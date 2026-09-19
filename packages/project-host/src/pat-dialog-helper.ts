import { Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { HostBoundaryError } from "../../host/dist/guards.js";
import { loadJobs } from "../../host/dist/owned-job.js";
import { PatChannel, PatKind } from "../../host/dist/pat-channel.js";
import type { CaptureInstallationLease } from "./installation.js";

async function main(): Promise<number> {
  if (
    process.version !== "v24.21.0" ||
    process.argv.length !== 4 ||
    process.argv[2] !== "--control-fd" ||
    process.argv[3] !== "3"
  )
    return 2;
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const channel = new PatChannel(socket);
  const abort = new AbortController();
  let ended = false;
  let control: Promise<void> | undefined;
  let ready: Promise<void> | undefined;
  let accepted: Buffer | undefined;
  let clean = false;
  let code = 0;
  let installation: CaptureInstallationLease | undefined;
  let guard: { close(): void } | undefined;
  let inputErrorType:
    | typeof import("../../host/dist/windows-pat-dialog.js").NativePatDialogError
    | undefined;
  try {
    const init = await channel.read(5000);
    let job: string;
    try {
      if (init.kind !== PatKind.init || init.sequence !== 0)
        throw new Error("protocol");
      if (init.bytes.some((byte) => byte < 32 || byte > 126))
        throw new Error("protocol");
      const id = init.bytes.toString("ascii");
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          id,
        )
      )
        throw new Error("protocol");
      job = `Local\\design-studio-${id}`;
    } finally {
      init.bytes.fill(0);
    }
    (await loadJobs()).joinCurrent(job, "pat-dialog");
    await channel.send(PatKind.joined, 0);
    const ownFile = fileURLToPath(import.meta.url);
    const suffix = path.join(
      "payload",
      "packages",
      "project-host",
      "dist",
      "pat-dialog-helper.js",
    );
    if (!ownFile.endsWith(`${path.sep}${suffix}`))
      throw new Error("uninstalled-role");
    const host = await import("./installation.js");
    host.establishBootstrapOrigin(ownFile.slice(0, -suffix.length - 1));
    installation = await host.verifyCaptureInstallation();
    if (installation.paths.dialogEntry !== ownFile)
      throw new Error("wrong-role");
    guard = host.registerCaptureInstallationGuards(installation);
    const input = await import("../../host/dist/windows-pat-dialog.js");
    const { validatePatBytes } = await import("../../host/dist/pat-input.js");
    inputErrorType = input.NativePatDialogError;
    const start = await channel.read(5000);
    let duration: number;
    try {
      if (start.kind !== PatKind.start || start.sequence !== 0)
        throw new Error("protocol");
      duration = start.bytes.readUInt32BE();
      if (duration < 1 || duration > 300_000) throw new Error("protocol");
    } finally {
      start.bytes.fill(0);
    }
    const deadline = performance.now() + duration;
    control = (async () => {
      try {
        const frame = await channel.read(duration);
        try {
          if (frame.kind !== PatKind.cancel || frame.sequence !== 0)
            throw new Error("protocol");
          abort.abort();
        } finally {
          frame.bytes.fill(0);
        }
      } catch {
        if (!ended) abort.abort();
      }
    })();
    accepted = await input.collectWindowsPat(abort.signal, deadline, () => {
      if (ready) throw new Error("duplicate-ready");
      ready = channel.send(PatKind.ready, 0);
      void ready.catch(() => abort.abort());
    });
    clean = true;
    validatePatBytes(accepted);
    if (abort.signal.aborted || performance.now() >= deadline)
      throw new HostBoundaryError("CANCELLED", "PAT input cancelled.");
    await ready;
    await channel.send(PatKind.accepted, 1, accepted);
  } catch (error) {
    const inputError =
      inputErrorType !== undefined && error instanceof inputErrorType
        ? error
        : undefined;
    const primary =
      inputError?.primaryCode ??
      (error instanceof HostBoundaryError ? error.code : undefined);
    const cancelled = primary === "CANCELLED";
    const expired = primary === "DEADLINE_EXCEEDED";
    clean ||= inputError?.cleanupComplete === true;
    code = clean ? 0 : 1;
    try {
      await channel.send(
        PatKind.error,
        ready ? 1 : 0,
        Buffer.of(cancelled ? 1 : expired ? 2 : 3),
      );
    } catch {
      code = 1;
    }
  } finally {
    ended = true;
    accepted?.fill(0);
    if (ready) {
      try {
        await ready;
      } catch {
        code = 1;
      }
    }
    try {
      await channel.send(
        PatKind.closed,
        1,
        Buffer.of(clean && code === 0 ? 3 : 0),
      );
    } catch {
      code = 1;
    }
    await channel.close();
    await control;
    guard?.close();
    await installation?.close();
  }
  return code;
}

// This fixed role has no stdout/stderr protocol and cannot select another module.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
