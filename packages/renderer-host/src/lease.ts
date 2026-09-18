import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ErrorCode,
  OperationContext,
  Outcome,
} from "@design-studio/contracts";
import {
  boundary,
  complete,
  HostBoundaryError,
  OperationGuard,
  snapshotOperationContext,
} from "@design-studio/host";
import type { RendererWorkerOptions } from "./index.js";
import { encode, type Frame, FrameReader, Kind, send } from "./protocol.js";
import type { OwnedJob } from "./windows-job.js";

export interface TrustedRendererImplementation {
  render(
    bytes: Uint8Array,
    context: { signal: AbortSignal },
  ): Promise<Uint8Array>;
  close?(): Promise<void>;
}
export interface CleanupReport {
  workerExitObserved: true;
  jobEmptyObserved: true;
  mode: "graceful" | "forced";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminalFailure?: { code: ErrorCode; message: string };
}
export interface RendererWorkerLease {
  exchange(
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<Uint8Array>>;
  close(): Promise<Outcome<CleanupReport>>;
  readonly closed: Promise<Outcome<CleanupReport>>;
}
function hostError(cause: unknown): HostBoundaryError {
  return cause instanceof HostBoundaryError
    ? cause
    : new HostBoundaryError(
        "PROCESS_FAILED",
        "Renderer worker boundary failed.",
        false,
        { cause },
      );
}
export class WorkerLease implements RendererWorkerLease {
  readonly closed: Promise<Outcome<CleanupReport>>;
  private resolveClosed!: (outcome: Outcome<CleanupReport>) => void;
  private readonly transport: Duplex;
  private readonly reader: FrameReader;
  private watch: ReturnType<OperationGuard["watch"]> | undefined;
  private pending:
    | {
        kind: number;
        sequence: number;
        resolve: (bytes: Buffer) => void;
        reject: (error: HostBoundaryError) => void;
      }
    | undefined;
  private failure: HostBoundaryError | undefined;
  private activeGuard: OperationGuard | undefined;
  private shutting = false;
  private ready = false;
  private busy = false;
  private exitObserved = false;
  private closeAcknowledged = false;
  private sequence = 0;
  private input = 0;
  private output = 0;
  private stdout = 0;
  private stderr = 0;
  private readonly requests = new Set<string>();
  private readonly cleanupErrors: unknown[] = [];
  private cleanupBytes = 0;
  private forceRequested = false;
  private joined = false;
  private idle: AbortController | undefined;
  constructor(
    private readonly options: RendererWorkerOptions,
    private readonly guard: OperationGuard,
    private readonly job: OwnedJob,
    private readonly child: ChildProcess,
    private readonly directory: string,
    private readonly nonce: string,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.transport = child.stdio[3] as Duplex;
    this.reader = new FrameReader(
      nonce,
      options.limits.maxFrameBytes,
      (frame) => this.receive(frame),
    );
    child.on("error", (cause) =>
      this.fail(
        new HostBoundaryError(
          "PROCESS_FAILED",
          "Owned worker launch failed.",
          false,
          { cause },
        ),
      ),
    );
    child.on("close", () => {
      this.exitObserved = true;
      if (!this.shutting)
        this.fail(
          new HostBoundaryError(
            "PROCESS_FAILED",
            "Renderer worker exited unexpectedly.",
          ),
        );
    });
    child.stdout?.on("data", (bytes: Buffer) =>
      this.diagnostic("stdout", bytes),
    );
    child.stderr?.on("data", (bytes: Buffer) =>
      this.diagnostic("stderr", bytes),
    );
    this.transport.on("error", (cause) => this.fail(hostError(cause)));
    this.transport.on("close", () => {
      if (!this.shutting)
        this.fail(
          new HostBoundaryError(
            "PROCESS_FAILED",
            "Renderer transport closed unexpectedly.",
          ),
        );
    });
    this.transport.on("data", (bytes: Buffer) => {
      if (this.shutting) {
        try {
          this.cleanupBytes += bytes.length;
          if (this.cleanupBytes > this.options.limits.maxOutputBytes) {
            this.forceRequested = true;
            this.reader.stop();
          } else this.reader.push(bytes);
        } catch (error) {
          this.cleanupErrors.push(error);
          this.forceRequested = true;
          this.reader.stop();
        }
        return;
      }
      try {
        this.count("output", bytes.length);
        this.reader.push(bytes);
      } catch (error) {
        this.fail(hostError(error));
      }
    });
  }
  private count(kind: "input" | "output", bytes: number): void {
    this.guard.consume(kind, bytes);
    this.activeGuard?.consume(kind, bytes);
    const limit =
      kind === "input"
        ? this.options.limits.maxInputBytes
        : this.options.limits.maxOutputBytes;
    if (bytes > limit - this[kind])
      throw new HostBoundaryError(
        kind === "input" ? "INPUT_LIMIT" : "OUTPUT_LIMIT",
        `Renderer lease ${kind} bound exceeded.`,
      );
    this[kind] += bytes;
  }
  private diagnostic(kind: "stdout" | "stderr", bytes: Buffer): void {
    if (this.shutting) {
      this.cleanupBytes += bytes.length;
      if (this.cleanupBytes > this.options.limits.maxOutputBytes)
        this.forceRequested = true;
      return;
    }
    try {
      this.count("output", bytes.length);
      this[kind] += bytes.length;
      if (
        this[kind] >
        (kind === "stdout"
          ? this.options.limits.maxStdoutBytes
          : this.options.limits.maxStderrBytes)
      )
        throw new HostBoundaryError(
          "OUTPUT_LIMIT",
          `Renderer ${kind} bound exceeded.`,
        );
    } catch (error) {
      this.fail(hostError(error));
    }
  }
  private receive(frame: Frame): void {
    if (this.shutting) {
      if (
        frame.kind === Kind.closed &&
        frame.sequence === 0 &&
        frame.bytes.length === 0
      )
        this.closeAcknowledged = true;
      return;
    }
    this.guard.check();
    if (frame.kind === Kind.error && frame.bytes.length === 1)
      throw new HostBoundaryError(
        frame.bytes[0] === 2 ? "OUTPUT_LIMIT" : "PROCESS_FAILED",
        "Trusted renderer reported failure.",
      );
    const pending = this.pending;
    if (
      !pending ||
      frame.kind !== pending.kind ||
      frame.sequence !== pending.sequence ||
      (frame.kind !== Kind.result && frame.bytes.length !== 0)
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Unexpected or replayed worker frame.",
      );
    this.pending = undefined;
    pending.resolve(frame.bytes);
  }
  private wait(kind: number, sequence = 0): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(
        new HostBoundaryError(
          "CONFLICT",
          "Worker already has an outstanding frame.",
        ),
      );
    return new Promise((resolve, reject) => {
      this.pending = { kind, sequence, resolve, reject };
    });
  }
  private async transmit(
    kind: number,
    sequence = 0,
    bytes = Buffer.alloc(0),
  ): Promise<void> {
    const frame = encode(this.nonce, kind, sequence, bytes);
    this.count("input", frame.length);
    await send(this.transport, frame);
  }
  private fail(error: HostBoundaryError): void {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
    void this.close();
  }
  assertLive(): void {
    this.guard.check();
    if (this.failure) throw this.failure;
    if (this.shutting || !this.ready)
      throw new HostBoundaryError(
        "CANCELLED",
        "Renderer lease closed before delivery.",
      );
  }
  async start(): Promise<void> {
    const lifetime = this.guard.watch();
    this.watch = lifetime;
    lifetime.signal.addEventListener(
      "abort",
      () => this.fail(hostError(lifetime.signal.reason)),
      { once: true },
    );
    if (lifetime.signal.aborted) this.fail(hostError(lifetime.signal.reason));
    const start = new OperationGuard(
      this.guard.context,
      {
        projectId: this.options.projectId,
        resourceKind: "provider",
        resourceId: this.options.providerId,
        operation: "execute",
      },
      this.options.authority,
      this.options.limits.startMs,
      this.options.budgetLimits,
    ).watch();
    const abort = () => this.fail(hostError(start.signal.reason));
    start.signal.addEventListener("abort", abort, { once: true });
    try {
      await this.wait(Kind.joined);
      this.guard.check();
      if (!this.child.pid || !this.job.members().includes(this.child.pid))
        throw new HostBoundaryError(
          "POLICY_FAILED",
          "Parent did not observe owned worker membership.",
        );
      this.joined = true;
      const ready = this.wait(Kind.ready);
      await Promise.all([ready, this.transmit(Kind.start)]);
      this.guard.check();
      this.ready = true;
      this.armIdle();
    } catch (cause) {
      this.fail(hostError(cause));
      await this.afterFailure(hostError(cause));
    } finally {
      start.signal.removeEventListener("abort", abort);
      await start.close();
    }
  }
  private armIdle(): void {
    this.idle?.abort();
    const timer = new AbortController();
    this.idle = timer;
    this.guard.context.clock
      .sleep(this.options.limits.idleMs, timer.signal)
      .then(
        () =>
          this.fail(
            new HostBoundaryError(
              "DEADLINE_EXCEEDED",
              "Renderer lease idle deadline exceeded.",
            ),
          ),
        (error: unknown) => {
          if (
            timer.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
            return;
          this.fail(
            new HostBoundaryError(
              "INTERNAL_ERROR",
              "Renderer idle clock failed.",
            ),
          );
        },
      );
  }
  exchange(
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<Uint8Array>> {
    return boundary(context, async (context) => {
      context = snapshotOperationContext(context);
      const original = this.guard.context;
      if (
        context.authorization !== original.authorization ||
        context.projectId !== original.projectId ||
        context.authorization.actorId !== original.authorization.actorId ||
        context.authorization.sessionId !== original.authorization.sessionId ||
        context.clock !== original.clock
      )
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Renderer lease belongs to another project, actor, session or clock.",
        );
      try {
        this.guard.check();
      } catch (cause) {
        const error = hostError(cause);
        this.fail(error);
        return await this.afterFailure(error);
      }
      const request = new OperationGuard(
        context,
        {
          projectId: this.options.projectId,
          actorId: original.authorization.actorId,
          resourceKind: "provider",
          resourceId: this.options.providerId,
          operation: "execute",
        },
        this.options.authority,
        undefined,
        this.options.budgetLimits,
      );
      if (this.busy || this.requests.has(context.requestId))
        throw new HostBoundaryError(
          "CONFLICT",
          "Concurrent or replayed renderer request.",
        );
      if (this.shutting || !this.ready)
        throw (
          this.failure ??
          new HostBoundaryError("CONFLICT", "Renderer lease is closed.")
        );
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.buffer instanceof SharedArrayBuffer
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Renderer payload must be owned binary bytes.",
        );
      if (bytes.length > this.options.limits.maxFrameBytes)
        throw new HostBoundaryError(
          "INPUT_LIMIT",
          "Renderer request exceeds its frame bound.",
        );
      if (this.requests.size >= this.options.limits.maxRequests)
        throw new HostBoundaryError(
          "INPUT_LIMIT",
          "Renderer request count exhausted.",
        );
      request.check();
      const owned = Buffer.from(bytes);
      const watch = request.watch();
      this.requests.add(context.requestId);
      this.busy = true;
      this.activeGuard = request;
      this.idle?.abort();
      const abort = () => this.fail(hostError(watch.signal.reason));
      watch.signal.addEventListener("abort", abort, { once: true });
      try {
        this.guard.check();
        const reply = this.wait(Kind.result, ++this.sequence);
        const [output] = await Promise.all([
          reply,
          this.transmit(Kind.request, this.sequence, owned),
        ]);
        request.check();
        this.guard.check();
        if (this.failure || this.shutting)
          throw (
            this.failure ??
            new HostBoundaryError(
              "CANCELLED",
              "Lease closed before output delivery.",
            )
          );
        return Uint8Array.from(output);
      } catch (cause) {
        const error = hostError(cause);
        this.fail(error);
        return await this.afterFailure(error);
      } finally {
        watch.signal.removeEventListener("abort", abort);
        await watch.close();
        this.busy = false;
        this.activeGuard = undefined;
        try {
          request.check();
          this.assertLive();
          this.armIdle();
        } catch (cause) {
          const error = this.failure ?? hostError(cause);
          this.fail(error);
          await this.afterFailure(error);
        }
      }
    });
  }
  private async afterFailure(error: HostBoundaryError): Promise<never> {
    const cleanup = await this.closed;
    if (cleanup.status !== "complete")
      throw new HostBoundaryError(
        "INTERRUPTED",
        `Renderer failed (${error.code}); ${"error" in cleanup && cleanup.error ? cleanup.error.message : "Owned cleanup was not established."}`,
        false,
        { cause: error },
      );
    throw error;
  }
  close(): Promise<Outcome<CleanupReport>> {
    if (!this.shutting) {
      this.shutting = true;
      this.idle?.abort();
      this.pending?.reject(
        this.failure ??
          new HostBoundaryError("CANCELLED", "Renderer lease closed."),
      );
      this.pending = undefined;
      void this.cleanup().then(this.resolveClosed, (cause: unknown) => {
        this.resolveClosed({
          schemaVersion: "1.0",
          projectId: this.guard.context.projectId,
          requestId: this.guard.context.requestId,
          status: "interrupted",
          error: {
            code: "INTERRUPTED",
            message: `${this.failure ? `Renderer failed (${this.failure.code}). ` : ""}${hostError(cause).message}`,
            retryable: false,
            diagnosticIds: [],
          },
          diagnosticIds: [],
        });
      });
    }
    return this.closed;
  }
  private async cleanup(): Promise<Outcome<CleanupReport>> {
    const errors = this.cleanupErrors;
    let mode: CleanupReport["mode"] = "graceful";
    // Cleanup uses a monotonic allowance, independent of the cancelled request clock.
    if (
      !this.exitObserved &&
      this.transport.writable &&
      !this.transport.destroyed
    ) {
      send(this.transport, encode(this.nonce, Kind.close, 0)).catch(
        (error: unknown) => {
          errors.push(error);
        },
      );
      const deadline = performance.now() + this.options.limits.closeMs;
      while (
        !this.exitObserved &&
        !this.forceRequested &&
        performance.now() < deadline
      )
        await delay(10);
    }
    try {
      if (!this.exitObserved || this.job.members().length > 0) {
        mode = "forced";
        this.job.terminate();
      }
    } catch (error) {
      errors.push(error);
    }
    // Before verified membership only the fixed, non-spawning direct child can be outside the Job.
    if (
      !this.joined &&
      !this.exitObserved &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.kill("SIGKILL") &&
      this.child.pid !== undefined
    )
      errors.push(
        new HostBoundaryError(
          "INTERRUPTED",
          "Owned pre-membership worker termination failed.",
        ),
      );
    try {
      const deadline = performance.now() + this.options.limits.closeMs;
      while (
        (!this.exitObserved || this.job.members().length > 0) &&
        performance.now() < deadline
      )
        await delay(10);
      if (!this.exitObserved || this.job.members().length > 0)
        throw new HostBoundaryError(
          "INTERRUPTED",
          "Owned worker exit or empty Job was not observed before cleanup deadline.",
        );
    } catch (error) {
      errors.push(error);
    }
    try {
      this.job.close();
    } catch (error) {
      errors.push(error);
    }
    this.reader.stop();
    this.transport.destroy();
    try {
      await this.watch?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        await rm(this.directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new HostBoundaryError(
        "INTERRUPTED",
        `Renderer cleanup failed: ${errors.map((error) => (error instanceof HostBoundaryError ? error.message : "Owned transport, clock or filesystem cleanup failed.")).join(" ")}`,
        false,
        {
          cause: new AggregateError([
            ...(this.failure ? [this.failure] : []),
            ...errors,
          ]),
        },
      );
    return complete(this.guard.context, {
      workerExitObserved: true,
      jobEmptyObserved: true,
      mode:
        mode === "graceful" &&
        this.closeAcknowledged &&
        this.child.exitCode === 0
          ? "graceful"
          : "forced",
      exitCode: this.child.exitCode,
      signal: this.child.signalCode,
      ...(this.failure
        ? {
            terminalFailure: {
              code: this.failure.code,
              message: this.failure.message,
            },
          }
        : {}),
    });
  }
}
