import { type ChildProcess, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import {
  ApplicationError,
  type Command,
  exitCode,
  PROJECT_ID,
  safeDiagnosticLine,
} from "@design-studio/application";
import { acquireInstalledLauncher } from "@design-studio/application/installed";
import { parseContract, type ResponseEnvelope } from "@design-studio/contracts";
import { parseArguments } from "./arguments.js";
import { PrivateChannel } from "./channel.js";

export interface CliResult {
  envelope: ResponseEnvelope;
  exitCode: number;
}
const blocked: readonly Command[] = ["serve", "with-session", "fixtures init"];
function processResult(child: ChildProcess) {
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let pending = "";
  let error: Error | undefined;
  child.stdout?.on("data", (bytes: Buffer) => {
    if (stdout.length + bytes.length > 26214400) {
      error = new ApplicationError("OUTPUT_LIMIT");
      child.kill();
    } else stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr?.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 65536) {
      error = new ApplicationError("OUTPUT_LIMIT");
      child.kill();
    }
    pending += bytes.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const safe = safeDiagnosticLine(line);
      if (safe) process.stderr.write(safe);
    }
    if (pending.length > 1024) pending = "";
  });
  const closed = new Promise<{ code: number | null; bytes: Buffer }>(
    (resolve, reject) => {
      child.once("error", () => {
        error = new ApplicationError("PROCESS_FAILED");
      });
      child.once("close", (code) =>
        error ? reject(error) : resolve({ code, bytes: stdout }),
      );
    },
  );
  return closed;
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApplicationError("DEADLINE_EXCEEDED", 504)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function environment() {
  return { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" };
}
export async function launchLocalSession(
  options: { projectId?: string; port?: number } = {},
) {
  if (
    (options.projectId !== undefined && options.projectId !== PROJECT_ID) ||
    (options.port !== undefined &&
      (!Number.isInteger(options.port) ||
        options.port < 0 ||
        options.port > 65535))
  )
    throw new ApplicationError("INVALID_INPUT");
  const requestedPort = options.port ?? 0;
  const owner = await acquireInstalledLauncher();
  const paths = owner.installation.paths;
  const child = spawn(
    paths.node,
    [
      paths.bootstrapEntry,
      "cli",
      "serve",
      "--project",
      PROJECT_ID,
      "--port",
      String(requestedPort),
      "--control-fd",
      "3",
      "--json",
    ],
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      env: environment(),
    },
  );
  const closed = processResult(child);
  // Attach immediately: startup may fail before readiness is consumed.
  void closed.catch(() => {});
  const pipe = child.stdio[3];
  if (!(pipe instanceof Duplex)) {
    child.kill();
    await closed.catch(() => {});
    await owner.close();
    throw new ApplicationError("TRANSPORT_UNAVAILABLE");
  }
  const channel = new PrivateChannel(pipe);
  let credential: string;
  let port: number;
  try {
    const ready = await channel.read(180000);
    if (
      !ready ||
      typeof ready !== "object" ||
      Array.isArray(ready) ||
      ready.kind !== "ready" ||
      typeof ready.port !== "number" ||
      !Number.isInteger(ready.port) ||
      ready.port < 1 ||
      ready.port > 65535 ||
      typeof ready.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(ready.credential)
    )
      throw new ApplicationError("AUTH_REQUIRED", 401);
    credential = ready.credential;
    port = ready.port;
  } catch (error) {
    child.kill();
    await bounded(
      closed.catch(() => undefined),
      30000,
    );
    channel.close();
    await owner.close();
    throw error;
  }
  let stopped = false;
  let working = false;
  return {
    async runCli(argv: readonly string[]): Promise<CliResult> {
      if (stopped || working) throw new ApplicationError("CONFLICT", 409);
      const args = [...argv];
      const parsed = parseArguments(args);
      if (
        blocked.includes(parsed.command) ||
        parsed.values.values["session-fd"] ||
        parsed.values.values.mode
      )
        throw new ApplicationError("INVALID_INPUT");
      working = true;
      try {
        await channel.write({ kind: "keepalive" });
        await owner.installation.recheck();
        const client = spawn(
          paths.node,
          [
            paths.bootstrapEntry,
            "cli",
            ...args,
            "--mode",
            "api",
            "--session-fd",
            "3",
            ...(parsed.values.values.json ? [] : ["--json"]),
          ],
          {
            shell: false,
            stdio: ["ignore", "pipe", "pipe", "overlapped"],
            env: environment(),
          },
        );
        const result = processResult(client);
        void result.catch(() => {});
        const clientPipe = client.stdio[3];
        if (!(clientPipe instanceof Duplex)) {
          client.kill();
          await result.catch(() => {});
          throw new ApplicationError("TRANSPORT_UNAVAILABLE");
        }
        const session = new PrivateChannel(clientPipe);
        try {
          await session.write({ kind: "session", port, credential });
          const output = await bounded(result, 180000);
          const envelope = parseContract(
            "ResponseEnvelope",
            output.bytes.toString("utf8"),
            "json",
          );
          const expected = exitCode(
            envelope,
            parsed.command === "jobs wait" ||
              (parsed.command === "render" && !parsed.values.values.async),
          );
          if (output.code !== expected)
            throw new ApplicationError("PROCESS_FAILED");
          return { envelope, exitCode: expected };
        } catch (error) {
          client.kill();
          await bounded(
            result.catch(() => undefined),
            30000,
          );
          throw error;
        } finally {
          session.close();
        }
      } finally {
        working = false;
      }
    },
    async close(): Promise<void> {
      if (stopped) return;
      if (working) throw new ApplicationError("CONFLICT", 409);
      await channel.write({ kind: "stop" });
      const reply = await channel.read(30000);
      if (
        !reply ||
        typeof reply !== "object" ||
        Array.isArray(reply) ||
        reply.kind !== "stopped"
      )
        throw new ApplicationError("INTERRUPTED", 409);
      const result = await bounded(closed, 30000);
      if (result.code !== 0) throw new ApplicationError("INTERRUPTED", 409);
      channel.close();
      credential = "";
      await owner.close();
      stopped = true;
    },
  };
}
