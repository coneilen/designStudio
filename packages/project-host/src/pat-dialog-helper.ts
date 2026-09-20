import { Socket } from "node:net";
import path from "node:path";
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
  let sessionStarted = false;
  let code = 0;
  let installation: CaptureInstallationLease | undefined;
  let guard: { close(): void } | undefined;
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
    const input = await import("./pat-dialog-input.js");
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
    sessionStarted = true;
    code = await input.runPatDialogInput(channel, duration);
  } catch (error) {
    code = 1;
    if (!sessionStarted) {
      const primary =
        error instanceof HostBoundaryError ? error.code : undefined;
      try {
        await channel.send(
          PatKind.error,
          0,
          Buffer.of(
            primary === "CANCELLED"
              ? 1
              : primary === "DEADLINE_EXCEEDED"
                ? 2
                : 3,
          ),
        );
        await channel.send(PatKind.closed, 1, Buffer.of(0));
      } catch {
        code = 1;
      }
    }
  } finally {
    await channel.close();
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
