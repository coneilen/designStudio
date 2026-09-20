import { ChildProcess, spawn } from "node:child_process";
import { Duplex, PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { loadJobs } from "../../host/dist/owned-job.js";
import { PatChannel, PatKind } from "../../host/dist/pat-channel.js";
import { openCaptureProject } from "../src/capture-project.js";
import { startCapturePatDialog } from "../src/pat-dialog-controller.js";
import { withCaptureInstallation } from "./capture-support.js";
import { supportsNativeJob } from "./job-platform.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const windows = it.skipIf(!supportsNativeJob(process.platform, process.arch));
const terminalFrame = (nonce: Buffer, value: number) => {
  const bytes = Buffer.alloc(39);
  bytes.writeUInt32BE(1);
  nonce.copy(bytes, 4);
  bytes[36] = PatKind.closed;
  bytes[37] = 1;
  bytes[38] = value;
  return bytes;
};

for (const terminal of [
  "valid",
  "duplicate",
  "foreign",
  "partial-header",
  "partial-body",
] as const)
  windows(
    `synthetic process adapter validates terminal ${terminal} and observed close`,
    async () => {
      expect(vi.isMockFunction(spawn)).toBe(true);
      const jobs = await loadJobs();
      let joined = false;
      let exited = false;
      let jobClosed = false;
      const job = vi
        .spyOn(jobs, "create")
        .mockImplementation((_name, profile) => {
          expect(profile).toBe("pat-dialog");
          return {
            flags: () => 0x2008,
            members: () => (joined && !exited ? [4242] : []),
            terminate: () => {
              exited = true;
              child.emit("close", 1);
            },
            close: () => {
              expect(exited).toBe(true);
              jobClosed = true;
            },
          };
        });
      const toChild = new PassThrough();
      const toParent = new PassThrough();
      const parentPipe = Duplex.from({ writable: toChild, readable: toParent });
      const childPipe = Duplex.from({ writable: toParent, readable: toChild });
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 4242 });
      Object.defineProperty(child, "stdio", {
        value: [null, null, null, parentPipe],
      });
      child.kill = () => {
        exited = true;
        child.emit("close", 1);
        return true;
      };
      vi.mocked(spawn).mockReturnValue(child);
      let nonce: Buffer | undefined;
      childPipe.prependListener("data", (chunk: Buffer) => {
        if (!nonce) nonce = Buffer.from(chunk.subarray(4, 36));
      });
      const channel = new PatChannel(childPipe);
      let sentClosed = false;
      const peer = (async () => {
        const init = await channel.read(5000);
        expect(init.kind).toBe(PatKind.init);
        init.bytes.fill(0);
        joined = true;
        await channel.send(PatKind.joined, 0);
        const start = await channel.read(5000);
        expect(start.kind).toBe(PatKind.start);
        start.bytes.fill(0);
        await channel.send(PatKind.ready, 0);
        await channel.send(
          PatKind.accepted,
          1,
          Buffer.from("synthetic-controller"),
        );
        await tick();
        if (!nonce) throw new Error("Missing synthetic nonce");
        const final = terminalFrame(nonce, 3);
        let trailing = Buffer.alloc(0);
        if (terminal === "duplicate") trailing = terminalFrame(nonce, 0);
        if (terminal === "foreign") {
          trailing = terminalFrame(nonce, 3);
          trailing[4] = (trailing[4] ?? 0) ^ 1;
        }
        if (terminal === "partial-header")
          trailing = terminalFrame(nonce, 3).subarray(0, 12);
        if (terminal === "partial-body")
          trailing = terminalFrame(nonce, 3).subarray(0, 38);
        childPipe.write(Buffer.concat([final, trailing]));
        sentClosed = true;
      })();
      try {
        await withCaptureInstallation(async (installation) => {
          const project = await openCaptureProject(installation);
          let run: ReturnType<typeof startCapturePatDialog> | undefined;
          try {
            expect(() =>
              startCapturePatDialog(
                { ...project },
                new AbortController().signal,
              ),
            ).toThrow(/live native/);
            run = startCapturePatDialog(project, new AbortController().signal);
            let settled = false;
            void run.result.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            await expect(project.close()).rejects.toThrow(/dialog helpers/);
            for (let count = 0; count < 100 && !sentClosed; count++)
              await tick();
            await peer;
            expect(sentClosed).toBe(true);
            expect(settled).toBe(false);
            expect(jobClosed).toBe(false);
            toParent.end();
            exited = true;
            child.emit("close", 0);
            if (terminal === "valid") {
              const bytes = await run.result;
              expect(bytes.toString()).toBe("synthetic-controller");
              bytes.fill(0);
            } else await expect(run.result).rejects.toBeDefined();
            expect(await run.close()).toMatchObject({
              closed: true,
              scrub: terminal === "valid" ? "confirmed" : "unconfirmed",
            });
            expect(jobClosed).toBe(true);
            const call = vi.mocked(spawn).mock.calls.at(-1);
            expect(call?.[0]).toBe(installation.paths.node);
            expect(call?.[1]).toEqual([
              installation.paths.dialogEntry,
              "--control-fd",
              "3",
            ]);
            expect(JSON.stringify(call)).not.toContain("synthetic-controller");
          } finally {
            if (!exited) {
              exited = true;
              child.emit("close", 1);
            }
            await channel.close();
            if (run) {
              await run.result.then(
                (bytes) => bytes.fill(0),
                () => undefined,
              );
              expect((await run.close()).closed).toBe(true);
            }
            await project.close();
          }
        });
      } finally {
        await channel.close();
        job.mockRestore();
        vi.mocked(spawn).mockReset();
      }
    },
  );

windows(
  "already-cancelled native admission never spawns and releases its atomic helper count",
  async () => {
    expect(vi.isMockFunction(spawn)).toBe(true);
    vi.mocked(spawn).mockClear();
    await withCaptureInstallation(async (installation) => {
      const project = await openCaptureProject(installation);
      try {
        const run = startCapturePatDialog(project, AbortSignal.abort());
        await expect(run.result).rejects.toMatchObject({ code: "CANCELLED" });
        expect(await run.close()).toMatchObject({ closed: true });
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await project.close();
      }
    });
  },
);

windows(
  "failed process creation releases the owned Job and helper count without a fictional close event",
  async () => {
    const jobs = await loadJobs();
    let released = false;
    const job = vi.spyOn(jobs, "create").mockReturnValue({
      members: () => [],
      flags: () => 0x2008,
      terminate: () => {},
      close: () => {
        released = true;
      },
    });
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("synthetic private executable error");
    });
    try {
      await withCaptureInstallation(async (installation) => {
        const project = await openCaptureProject(installation);
        try {
          const run = startCapturePatDialog(
            project,
            new AbortController().signal,
          );
          await expect(run.result).rejects.toMatchObject({
            code: "INTERRUPTED",
          });
          expect(await run.close()).toMatchObject({
            closed: true,
            scrub: "unconfirmed",
          });
          expect(released).toBe(true);
        } finally {
          await project.close();
        }
      });
    } finally {
      job.mockRestore();
      vi.mocked(spawn).mockReset();
    }
  },
);
