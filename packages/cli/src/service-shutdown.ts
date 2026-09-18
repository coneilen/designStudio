import { ApplicationError, PROJECT_ID } from "@design-studio/application";
import { parseContract } from "@design-studio/contracts";
import { SERVICE_QUIESCENCE_PREFIX } from "./service-evidence.js";

export interface ObservedServiceExit {
  code: number | null;
  bytes: Uint8Array;
  error?: unknown;
}
export function stoppedFrame() {
  return { kind: "stopped", projectId: PROJECT_ID, requestId: "service_stop" };
}
function isTeardownRecord(
  value: unknown,
  kind: "stopped" | "quiescent",
): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "kind,projectId,requestId" &&
    "kind" in value &&
    value.kind === kind &&
    "projectId" in value &&
    value.projectId === PROJECT_ID &&
    "requestId" in value &&
    value.requestId === "service_stop"
  );
}
const isStoppedFrame = (value: unknown) => isTeardownRecord(value, "stopped");
// Evidence is observed from the fixed owned service, never from a caller-supplied process or artifact.
export class ServiceQuiescence {
  private acknowledgements = 0;
  private invalid = false;
  private errorRecords = 0;
  private stderrBytes = 0;
  private stderrPending = "";
  private discardingLine = false;
  private stderrFinished = false;
  observeControl(value: unknown): void {
    if (this.acknowledgements > 0 || this.errorRecords > 0) this.invalid = true;
    if (!value || typeof value !== "object" || !("kind" in value)) return;
    if (value.kind !== "stopped") return;
    this.acknowledgements++;
    if (!isStoppedFrame(value) || this.acknowledgements !== 1)
      this.invalid = true;
  }
  get acknowledged() {
    return this.acknowledgements === 1 && !this.invalid;
  }
  get teardownObserved() {
    return !this.invalid && (this.acknowledged || this.errorRecords === 1);
  }
  observeStderr(bytes: Uint8Array): void {
    if (this.stderrFinished) {
      this.invalid = true;
      return;
    }
    this.stderrBytes += bytes.length;
    if (this.stderrBytes > 65536) {
      this.invalid = true;
      return;
    }
    // Only the fixed ASCII marker is authority-bearing; arbitrary diagnostic lines are ignored.
    for (const byte of bytes) {
      if (byte === 10) {
        if (!this.discardingLine) this.stderrLine(this.stderrPending);
        this.stderrPending = "";
        this.discardingLine = false;
      } else if (!this.discardingLine) {
        this.stderrPending += String.fromCharCode(byte);
        if (this.stderrPending.length > 511) {
          if (this.stderrPending.startsWith(SERVICE_QUIESCENCE_PREFIX))
            this.invalid = true;
          this.stderrPending = "";
          this.discardingLine = true;
        }
      }
    }
  }
  private stderrLine(line: string): void {
    if (!line.startsWith(SERVICE_QUIESCENCE_PREFIX)) {
      if (
        line &&
        (SERVICE_QUIESCENCE_PREFIX.startsWith(line) ||
          line.startsWith(SERVICE_QUIESCENCE_PREFIX.trimEnd()))
      )
        this.invalid = true;
      return;
    }
    this.errorRecords++;
    if (this.errorRecords !== 1 || this.acknowledgements !== 0) {
      this.invalid = true;
      return;
    }
    try {
      const value = parseContract(
        "JsonValue",
        line.slice(SERVICE_QUIESCENCE_PREFIX.length),
        "json",
      );
      if (!isTeardownRecord(value, "quiescent")) this.invalid = true;
    } catch {
      this.invalid = true;
    }
  }
  endStderr(): void {
    if (
      this.stderrPending &&
      (SERVICE_QUIESCENCE_PREFIX.startsWith(this.stderrPending) ||
        this.stderrPending.startsWith(SERVICE_QUIESCENCE_PREFIX))
    )
      this.invalid = true;
    this.stderrPending = "";
    this.stderrFinished = true;
  }
  invalidateControl(): void {
    this.invalid = true;
  }
  confirms(exit: ObservedServiceExit): boolean {
    if (this.invalid || exit.bytes.length > 26214400) return false;
    if (exit.bytes.length === 0)
      return this.acknowledged && this.errorRecords === 0;
    try {
      const envelope = parseContract(
        "ResponseEnvelope",
        Buffer.from(exit.bytes).toString("utf8"),
        "json",
      );
      if (envelope.requestId !== "service_stop") return false;
      if (!envelope.success)
        return (
          this.acknowledged || (this.errorRecords === 1 && this.stderrFinished)
        );
      return (
        this.errorRecords === 0 &&
        envelope.data.kind === "service" &&
        envelope.data.state === "stopped" &&
        envelope.data.projectId === PROJECT_ID &&
        envelope.data.warnings.length === 0 &&
        Object.keys(envelope.data).sort().join(",") ===
          "kind,projectId,state,warnings"
      );
    } catch {
      return false;
    }
  }
  reportedFailure(exit: ObservedServiceExit): unknown {
    if (!this.confirms(exit) || exit.bytes.length === 0) return undefined;
    const envelope = parseContract(
      "ResponseEnvelope",
      Buffer.from(exit.bytes).toString("utf8"),
      "json",
    );
    return envelope.success ? undefined : envelope.error;
  }
}
export class ServiceShutdownFailure extends ApplicationError {
  override readonly cause: unknown;
  constructor(
    cause: unknown,
    readonly cleanupFailure?: unknown,
  ) {
    super("INTERRUPTED", 409);
    this.cause = cause;
  }
}
export class ServiceShutdown {
  private released = false;
  private channelClosed = false;
  private terminalFailure: ServiceShutdownFailure | undefined;
  private attempt: Promise<void> | undefined;
  private stopping = false;
  constructor(
    private readonly ports: {
      channel: {
        write(
          value: ReturnType<typeof stoppedFrame> | { kind: "stop" },
        ): Promise<void>;
        read(timeout: number): Promise<unknown>;
        close(): void;
      };
      observedExit(): ObservedServiceExit | undefined;
      waitForExit(): Promise<ObservedServiceExit>;
      release(): Promise<void>;
      evidence: ServiceQuiescence;
    },
  ) {}
  get started() {
    return this.stopping;
  }
  close(): Promise<void> {
    this.stopping = true;
    if (this.attempt) return this.attempt;
    const attempt = this.closeAttempt();
    this.attempt = attempt;
    void attempt.then(
      () => {
        this.attempt = undefined;
      },
      () => {
        this.attempt = undefined;
      },
    );
    return attempt;
  }
  private async closeAttempt(): Promise<void> {
    if (this.released) {
      if (this.terminalFailure) throw this.terminalFailure;
      return;
    }
    const evidence = this.ports.evidence;
    let exit = this.ports.observedExit();
    let exchangeFailure: unknown;
    if (!exit && !evidence.teardownObserved) {
      try {
        await this.ports.channel.write({ kind: "stop" });
        const reply = await this.ports.channel.read(30000);
        if (!isStoppedFrame(reply) || !evidence.acknowledged)
          throw new ApplicationError("INTERRUPTED", 409);
      } catch (error) {
        exchangeFailure = error;
      }
      exit = this.ports.observedExit();
    }
    if (!exit) {
      if (exchangeFailure) throw new ServiceShutdownFailure(exchangeFailure);
      try {
        exit = await this.ports.waitForExit();
      } catch (error) {
        throw new ServiceShutdownFailure(error);
      }
    }
    // Child close alone is not evidence that pending renderer Jobs or authorities were quiescent.
    if (!evidence.confirms(exit))
      throw new ServiceShutdownFailure(
        exit.error ??
          exchangeFailure ??
          new ApplicationError("INTERRUPTED", 409),
      );
    const reportedFailure = evidence.reportedFailure(exit);
    if (exit.error || exit.code !== 0 || reportedFailure)
      this.terminalFailure ??= new ServiceShutdownFailure(
        exit.error ?? reportedFailure ?? new ApplicationError("PROCESS_FAILED"),
      );
    try {
      if (!this.channelClosed) {
        this.ports.channel.close();
        this.channelClosed = true;
      }
      await this.ports.release();
      this.released = true;
    } catch (error) {
      throw new ServiceShutdownFailure(
        this.terminalFailure?.cause ?? exchangeFailure,
        error,
      );
    }
    if (this.terminalFailure) throw this.terminalFailure;
  }
}
