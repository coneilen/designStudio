import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { ErrorCode } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import { loadJobs, type OwnedJob } from "../../host/dist/owned-job.js";
import {
  PatChannel,
  type PatFrame,
  PatKind,
} from "../../host/dist/pat-channel.js";
import { validatePatBytes } from "../../host/dist/pat-input.js";
import { type CaptureProject, captureProjectOwner } from "./capture-project.js";
import { refuse } from "./native.js";

export interface PatDialogClose {
  closed: boolean;
  scrub: "confirmed" | "unconfirmed";
  code?: ErrorCode;
}
export interface PatDialogRun {
  result: Promise<Buffer>;
  cancel(): void;
  close(): Promise<PatDialogClose>;
}
const interrupted = () =>
  new HostBoundaryError(
    "INTERRUPTED",
    "Owned PAT helper did not complete verified input/teardown.",
  );

/** Fixed installed native role; no caller executable, IPC endpoint, callback or fake authority. */
export function startCapturePatDialog(
  project: CaptureProject,
  signal: AbortSignal,
): PatDialogRun {
  const owner = captureProjectOwner(project);
  if (owner.helpers || owner.work)
    refuse(
      "This private project already owns active capture work or a PAT dialog.",
    );
  if (!(signal instanceof AbortSignal))
    refuse("Native dialog needs an owned cancellation signal.");
  const nonce = randomBytes(32);
  owner.helpers++;
  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let job: OwnedJob | undefined;
  let channel: PatChannel | undefined;
  let observedExit: { code: number | null } | undefined;
  let spawnFailed = false;
  let joined = false;
  let scrubbed = false;
  let quiescent = false;
  let closed = false;
  let delivered = false;
  let pipeClosed = false;
  let pipeClose: Promise<void> | undefined;
  let cancelWrite: Promise<void> | undefined;
  let closeAttempt: Promise<PatDialogClose> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let cancelTransportFailed = false;
  let pipeFailed = false;
  let staged: Buffer | undefined;
  let terminalDeadline: number | undefined;
  const cancel = () => {
    abort.abort();
    staged?.fill(0);
    staged = undefined;
    if (channel && !cancelWrite) {
      cancelWrite = channel.send(PatKind.cancel, 0);
      void cancelWrite.catch(() => {
        cancelTransportFailed = true;
      });
    }
    if (child && !observedExit && !killTimer) {
      killTimer = setTimeout(() => {
        try {
          if (joined && job) job.terminate();
          else child?.kill();
        } catch {
          spawnFailed = true;
        }
      }, 5000);
    }
  };
  const checkpoint = () => {
    captureProjectOwner(project);
    if (signal.aborted || abort.signal.aborted)
      throw new HostBoundaryError(
        expired ? "DEADLINE_EXCEEDED" : "CANCELLED",
        "PAT input cancelled or expired.",
      );
    if (spawnFailed) throw interrupted();
  };
  const cleanup = (stop: boolean): Promise<PatDialogClose> => {
    if (closed)
      return Promise.resolve({
        closed: true,
        scrub: scrubbed ? "confirmed" : "unconfirmed",
      });
    if (stop && !delivered) cancel();
    if (closeAttempt) return closeAttempt;
    closeAttempt = (async () => {
      if (!quiescent) return { closed: false, scrub: "unconfirmed" } as const;
      if (channel && !pipeClose) {
        pipeClose = channel.close().then(() => {
          pipeClosed = true;
        });
        void pipeClose.catch(() => {
          pipeFailed = true;
          pipeClose = undefined;
        });
      }
      const end =
        !stop && terminalDeadline !== undefined
          ? terminalDeadline
          : performance.now() + 5000;
      while ((child && !observedExit) || (channel && !pipeClosed)) {
        if (performance.now() >= end) {
          cancel();
          return {
            closed: false,
            scrub: "unconfirmed",
            ...(pipeFailed ? { code: "INTERRUPTED" as const } : {}),
          } as const;
        }
        await sleep(10);
      }
      if (job && job.members().length !== 0)
        return { closed: false, scrub: "unconfirmed" } as const;
      if (cancelWrite)
        await cancelWrite.catch(() => {
          cancelTransportFailed = true;
        });
      if (job) job.close();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", cancel);
      nonce.fill(0);
      owner.helpers--;
      closed = true;
      return {
        closed: true,
        scrub: scrubbed ? "confirmed" : "unconfirmed",
        ...(cancelTransportFailed && !scrubbed
          ? { code: "TRANSPORT_UNAVAILABLE" as const }
          : {}),
      } as const;
    })().finally(() => {
      closeAttempt = undefined;
    });
    return closeAttempt;
  };
  try {
    signal.addEventListener("abort", cancel, { once: true });
  } catch {
    nonce.fill(0);
    owner.helpers--;
    throw interrupted();
  }
  const work = async (): Promise<Buffer> => {
    try {
      checkpoint();
      await project.recheck();
      await owner.installation.checkCurrent();
      checkpoint();
      const jobs = await loadJobs();
      checkpoint();
      const id = randomUUID();
      job = jobs.create(`Local\\design-studio-${id}`, "pat-dialog");
      const paths = owner.installation.paths;
      child = spawn(paths.node, [paths.dialogEntry, "--control-fd", "3"], {
        cwd: path.dirname(paths.node),
        shell: false,
        windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
        stdio: ["ignore", "ignore", "ignore", "overlapped"],
      });
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (code) => {
        observedExit = { code };
      });
      const pipe = child.stdio[3];
      if (!(pipe instanceof Duplex)) throw interrupted();
      channel = new PatChannel(pipe, nonce);
      const receive = async (timeout: number): Promise<PatFrame> => {
        if (!channel) throw interrupted();
        const frame = await channel.read(timeout);
        try {
          captureProjectOwner(project);
          if (spawnFailed) throw interrupted();
          return frame;
        } catch (error) {
          frame.bytes.fill(0);
          throw error;
        }
      };
      await channel.send(PatKind.init, 0, Buffer.from(id, "ascii"));
      const membership = await receive(5000);
      try {
        if (
          membership.kind !== PatKind.joined ||
          membership.sequence !== 0 ||
          !child.pid ||
          job.members().length !== 1 ||
          job.members()[0] !== child.pid
        )
          throw interrupted();
        joined = true;
      } finally {
        membership.bytes.fill(0);
      }
      await project.recheck();
      checkpoint();
      const duration = Buffer.alloc(4);
      duration.writeUInt32BE(300_000);
      const deadline = performance.now() + 300_000;
      deadlineTimer = setTimeout(() => {
        expired = true;
        cancel();
      }, 300_000);
      await channel.send(PatKind.start, 0, duration);
      duration.fill(0);
      let ready = false;
      let acceptedSeen = false;
      let failure: HostBoundaryError | undefined;
      let ended = false;
      for (let frames = 0; frames < 4 && !ended; frames++) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0)
          throw new HostBoundaryError(
            "DEADLINE_EXCEEDED",
            "PAT input deadline exceeded.",
          );
        const frame = await receive(
          ready ? remaining : Math.min(5000, remaining),
        );
        try {
          if (
            frame.kind === PatKind.ready &&
            !ready &&
            !staged &&
            !failure &&
            frame.sequence === 0
          )
            ready = true;
          else if (
            frame.kind === PatKind.accepted &&
            ready &&
            !acceptedSeen &&
            !failure &&
            frame.sequence === 1
          ) {
            acceptedSeen = true;
            validatePatBytes(frame.bytes);
            if (!signal.aborted && !abort.signal.aborted)
              staged = Buffer.from(frame.bytes);
            else
              failure = new HostBoundaryError(
                expired ? "DEADLINE_EXCEEDED" : "CANCELLED",
                "PAT input cancelled or expired.",
              );
          } else if (
            frame.kind === PatKind.error &&
            !failure &&
            !acceptedSeen &&
            frame.sequence === (ready ? 1 : 0) &&
            (frame.bytes[0] === 1 ||
              frame.bytes[0] === 2 ||
              frame.bytes[0] === 3)
          ) {
            const reason = frame.bytes[0];
            failure =
              reason === 1
                ? new HostBoundaryError("CANCELLED", "PAT entry cancelled.")
                : reason === 2
                  ? new HostBoundaryError(
                      "DEADLINE_EXCEEDED",
                      "PAT entry deadline exceeded.",
                    )
                  : interrupted();
          } else if (frame.kind === PatKind.closed && frame.sequence === 1) {
            scrubbed = frame.bytes[0] === 3;
            ended = true;
          } else throw interrupted();
        } finally {
          frame.bytes.fill(0);
        }
      }
      if (signal.aborted || abort.signal.aborted)
        failure ??= new HostBoundaryError(
          expired ? "DEADLINE_EXCEEDED" : "CANCELLED",
          "PAT input cancelled or expired.",
        );
      if (!ended || !scrubbed || (!staged && !failure)) throw interrupted();
      terminalDeadline = performance.now() + 5000;
      await channel.finalizeReceive(5000);
      if (!failure) {
        await project.recheck();
        checkpoint();
      }
      quiescent = true;
      const release = await cleanup(false);
      if (
        !release.closed ||
        observedExit?.code !== 0 ||
        !scrubbed ||
        spawnFailed ||
        !channel.receiveFinalized
      )
        throw interrupted();
      if (failure) throw failure;
      checkpoint();
      if (!staged) throw interrupted();
      delivered = true;
      const result = staged;
      staged = undefined;
      return result;
    } catch (error) {
      if (!channel?.receiveFinalized) scrubbed = false;
      staged?.fill(0);
      staged = undefined;
      quiescent = true;
      try {
        await cleanup(true);
      } catch {
        throw interrupted();
      }
      if (error instanceof HostBoundaryError)
        throw new HostBoundaryError(
          error.code,
          "PAT dialog did not return an accepted credential.",
          error.unavailable,
        );
      throw interrupted();
    }
  };
  const result = work();
  void result.catch(() => {});
  return Object.freeze({ result, cancel, close: () => cleanup(true) });
}
