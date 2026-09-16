import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type Budget,
  type LocatedTool,
  type OperationContext,
  type Outcome,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
  type ToolIdentity,
  type ToolLocator,
  validateContract,
} from "@design-studio/contracts";
import {
  type Authority,
  boundary,
  HostBoundaryError,
  OperationGuard,
} from "./guards.js";

export interface ApprovedTool {
  id: string;
  executable: string;
  identity: ToolIdentity & { sha256: string };
  platforms: readonly NodeJS.Platform[];
  maxExecutableBytes: number;
  commands: readonly { args: readonly string[]; cwd: string }[];
  environment: Readonly<Record<string, string>>;
  /** Descendant-spawning commands require a native process containment adapter. */
  spawnsDescendants: false;
}
export interface ToolLocatorOptions {
  projectId: string;
  authority: Authority;
  tools: readonly ApprovedTool[];
  budgetLimits?: Readonly<Budget>;
}
export class ConfiguredToolLocator implements ToolLocator {
  private readonly tools = new Map<string, ApprovedTool>();
  readonly projectId: string;
  readonly authority: Authority;
  private readonly budgetLimits: Readonly<Budget> | undefined;
  constructor(options: ToolLocatorOptions) {
    this.projectId = options.projectId;
    this.authority = options.authority;
    this.budgetLimits = options.budgetLimits
      ? Object.freeze({ ...options.budgetLimits })
      : undefined;
    for (const tool of options.tools) {
      if (
        !validateContract("StableId", tool.id).success ||
        this.tools.has(tool.id) ||
        !validateContract("ToolIdentity", tool.identity).success ||
        !/^[0-9a-f]{64}$/.test(tool.identity.sha256) ||
        !path.isAbsolute(tool.executable) ||
        /\.(cmd|bat|ps1|sh)$/i.test(tool.executable) ||
        !Number.isSafeInteger(tool.maxExecutableBytes) ||
        tool.maxExecutableBytes <= 0 ||
        tool.spawnsDescendants !== false ||
        tool.commands.some((command) => !path.isAbsolute(command.cwd))
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid approved tool configuration.",
        );
      if (
        Object.keys(tool.environment).some((key) =>
          /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(
            key,
          ),
        )
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Runtime injection environment variables are forbidden.",
        );
      this.tools.set(tool.id, structuredClone(tool));
    }
  }
  guard(
    toolId: string,
    context: OperationContext,
    timeoutMs?: number,
  ): OperationGuard {
    return new OperationGuard(
      context,
      {
        projectId: this.projectId,
        resourceKind: "provider",
        resourceId: toolId,
        operation: "execute",
      },
      this.authority,
      timeoutMs,
      this.budgetLimits,
    );
  }
  async approved(
    toolId: string,
    context: OperationContext,
    guard = this.guard(toolId, context),
  ): Promise<ApprovedTool> {
    guard.check();
    const tool = this.tools.get(toolId);
    if (!tool)
      throw new HostBoundaryError(
        "TOOL_MISSING",
        "Tool is not explicitly configured.",
        true,
      );
    if (!tool.platforms.includes(process.platform))
      throw new HostBoundaryError(
        "UNSUPPORTED_HOST",
        "Configured tool is unsupported on this host.",
        true,
      );
    try {
      const stat = await lstat(tool.executable);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (await realpath(tool.executable)) !== path.resolve(tool.executable)
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Executable identity requires a real regular file.",
        );
      if (stat.size > tool.maxExecutableBytes)
        throw new HostBoundaryError(
          "INPUT_LIMIT",
          "Approved executable exceeds its configured byte bound.",
        );
      await access(tool.executable, constants.X_OK);
      const handle = await open(
        tool.executable,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const hash = createHash("sha256");
        const chunk = new Uint8Array(65536);
        let total = 0;
        while (true) {
          guard.check();
          const { bytesRead } = await handle.read(chunk);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > tool.maxExecutableBytes)
            throw new HostBoundaryError(
              "INPUT_LIMIT",
              "Executable grew past configured byte bound.",
            );
          hash.update(chunk.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
          after.ino !== stat.ino ||
          after.dev !== stat.dev ||
          after.mtimeMs !== stat.mtimeMs ||
          total !== stat.size ||
          hash.digest("hex") !== tool.identity.sha256
        )
          throw new HostBoundaryError(
            "TOOL_VERSION_UNSUPPORTED",
            "Executable bytes do not match approved identity.",
          );
      } finally {
        await handle.close();
      }
      guard.check();
      return structuredClone(tool);
    } catch (error) {
      if (error instanceof HostBoundaryError) throw error;
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "unknown";
      throw new HostBoundaryError(
        code === "ENOENT" ? "TOOL_MISSING" : "PROVIDER_UNAVAILABLE",
        `Executable inspection failed (${code}).`,
        true,
        { cause: error },
      );
    }
  }
  locate(
    toolId: string,
    context: OperationContext,
  ): Promise<Outcome<LocatedTool>> {
    return boundary(context, async () => {
      const tool = await this.approved(toolId, context);
      return {
        identity: tool.identity,
        executable: tool.executable,
        hostSupported: true,
      };
    });
  }
}

export class BoundedProcessRunner implements ProcessRunner {
  private readonly active = new Set<ChildProcess>();
  constructor(private readonly locator: ConfiguredToolLocator) {}
  get activeProcessCount(): number {
    return this.active.size;
  }
  async run(
    input: ProcessRequest,
    context: OperationContext,
  ): Promise<Outcome<ProcessResult>> {
    const outcome = await boundary(context, async () => {
      if (!validateContract("ProcessRequest", input).success)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid process request; argument arrays and shell:false are required.",
        );
      const request = structuredClone(input);
      const started = context.clock.now();
      const guard = this.locator.guard(
        request.toolId,
        context,
        request.timeoutMs,
      );
      guard.consume("input", Buffer.byteLength(JSON.stringify(request)));
      const tool = await this.locator.approved(request.toolId, context, guard);
      if (
        request.executable !== tool.executable ||
        !tool.commands.some(
          (command) =>
            command.cwd === request.cwd &&
            command.args.length === request.args.length &&
            command.args.every(
              (argument, index) => argument === request.args[index],
            ),
        )
      )
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Command arguments and working directory are not approved.",
        );
      try {
        if (
          (await lstat(request.cwd)).isSymbolicLink() ||
          (await realpath(request.cwd)) !== path.resolve(request.cwd)
        )
          throw new HostBoundaryError(
            "PATH_FORBIDDEN",
            "Working directory cannot be a path alias.",
          );
      } catch (error) {
        if (error instanceof HostBoundaryError) throw error;
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Approved working directory is unavailable.",
          false,
          { cause: error },
        );
      }
      guard.check();
      const watch = guard.watch();
      try {
        return await new Promise<ProcessResult>((resolve, reject) => {
          let child: ChildProcess;
          let failure: HostBoundaryError | undefined;
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let outBytes = 0;
          let errBytes = 0;
          try {
            child = spawn(tool.executable, [...request.args], {
              cwd: request.cwd,
              env: { ...tool.environment },
              shell: false,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (error) {
            reject(
              new HostBoundaryError(
                "PROCESS_FAILED",
                "Approved process could not be spawned.",
                false,
                { cause: error },
              ),
            );
            return;
          }
          this.active.add(child);
          const stop = (error: HostBoundaryError) => {
            failure ??= error;
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
          };
          const abort = () =>
            stop(
              watch.signal.reason instanceof HostBoundaryError
                ? watch.signal.reason
                : new HostBoundaryError("CANCELLED", "Process cancelled."),
            );
          watch.signal.addEventListener("abort", abort, { once: true });
          if (watch.signal.aborted) abort();
          const collect = (kind: "stdout" | "stderr", bytes: Buffer) => {
            if (failure) return;
            try {
              guard.consume("output", bytes.byteLength);
              if (kind === "stdout") {
                outBytes += bytes.byteLength;
                if (outBytes > request.maxStdoutBytes)
                  throw new HostBoundaryError(
                    "OUTPUT_LIMIT",
                    "Process stdout limit exceeded.",
                  );
                stdout.push(bytes);
              } else {
                errBytes += bytes.byteLength;
                if (errBytes > request.maxStderrBytes)
                  throw new HostBoundaryError(
                    "OUTPUT_LIMIT",
                    "Process stderr limit exceeded.",
                  );
                stderr.push(bytes);
              }
            } catch (error) {
              stop(
                error instanceof HostBoundaryError
                  ? error
                  : new HostBoundaryError(
                      "INTERNAL_ERROR",
                      "Process output guard failed.",
                    ),
              );
            }
          };
          child.stdout?.on("data", (bytes: Buffer) => collect("stdout", bytes));
          child.stderr?.on("data", (bytes: Buffer) => collect("stderr", bytes));
          child.on("error", (error: NodeJS.ErrnoException) => {
            failure = new HostBoundaryError(
              error.code === "ENOENT" ? "TOOL_MISSING" : "PROCESS_FAILED",
              `Process launch failed (${error.code ?? "unknown"}).`,
              error.code === "ENOENT",
            );
          });
          child.on("close", (exitCode, signal) => {
            watch.signal.removeEventListener("abort", abort);
            this.active.delete(child);
            if (failure) {
              reject(failure);
              return;
            }
            try {
              guard.check();
            } catch (error) {
              reject(error);
              return;
            }
            resolve({
              exitCode,
              signal,
              stdout: Uint8Array.from(Buffer.concat(stdout)),
              stderr: Uint8Array.from(Buffer.concat(stderr)),
              durationMs: context.clock.now() - started,
            });
          });
        });
      } finally {
        await watch.close();
      }
    });
    if (outcome.status === "complete" && outcome.value.exitCode !== 0) {
      return {
        ...outcome,
        status: "partial",
        missing: ["successful-process-exit"],
        error: {
          code: "PROCESS_FAILED",
          message:
            "Approved process exited unsuccessfully; binary output retained.",
          retryable: false,
          diagnosticIds: [],
        },
      };
    }
    return outcome;
  }
}
