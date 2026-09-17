import { ApplicationError, PROJECT_ID } from "@design-studio/application";
import { parseContract } from "@design-studio/contracts";

export interface ObservedServiceExit {
  code: number | null;
  bytes: Uint8Array;
  error?: unknown;
}
export function stoppedFrame() {
  return { kind: "stopped", projectId: PROJECT_ID, requestId: "service_stop" };
}
function isStoppedFrame(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "kind,projectId,requestId" &&
    "kind" in value &&
    value.kind === "stopped" &&
    "projectId" in value &&
    value.projectId === PROJECT_ID &&
    "requestId" in value &&
    value.requestId === "service_stop"
  );
}
// Evidence is observed from the fixed owned service, never from a caller-supplied process or artifact.
export class ServiceQuiescence {
  private acknowledgements = 0;
  private invalid = false;
  observeControl(value: unknown): void {
    if (this.acknowledgements > 0) this.invalid = true;
    if (!value || typeof value !== "object" || !("kind" in value)) return;
    if (value.kind !== "stopped") return;
    this.acknowledgements++;
    if (!isStoppedFrame(value) || this.acknowledgements !== 1)
      this.invalid = true;
  }
  get acknowledged() {
    return this.acknowledgements === 1 && !this.invalid;
  }
  invalidateControl(): void {
    this.invalid = true;
  }
  confirms(exit: ObservedServiceExit): boolean {
    if (this.invalid || exit.bytes.length > 26214400) return false;
    if (exit.bytes.length === 0) return this.acknowledged;
    try {
      const envelope = parseContract(
        "ResponseEnvelope",
        Buffer.from(exit.bytes).toString("utf8"),
        "json",
      );
      return (
        envelope.success &&
        envelope.requestId === "service_stop" &&
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
    if (!exit && !evidence.acknowledged) {
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
    if (exit.error || exit.code !== 0)
      this.terminalFailure ??= new ServiceShutdownFailure(
        exit.error ?? new ApplicationError("PROCESS_FAILED"),
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
