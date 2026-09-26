export {
  AsyncTestScope,
  inTestScope as inCaptureTest,
  ownTests as ownCaptureTests,
  ownTestWork as ownCaptureWork,
  testScope as captureTestScope,
} from "../../jobs/tests/test-scope.js";

import { performance } from "node:perf_hooks";
import { type ErrorCode, validateContract } from "@design-studio/contracts";

export type ReferencePhaseEvent = {
  scope: "synthetic-reference-phase";
  scenario:
    | "conversion-provenance"
    | "converted-archive"
    | "closed-diagnostic"
    | "retained-integrity";
  event: "start" | "settled" | "rejected" | "runner-abort";
  phase: string | null;
  elapsedMs: number;
  durationMs?: number;
  outcome?: string;
  errorCode?: ErrorCode;
  runnerAborted: boolean;
};
export function referenceTelemetry(
  scenario: ReferencePhaseEvent["scenario"] | undefined,
  originalSignal: AbortSignal | undefined,
  sink: (event: ReferencePhaseEvent) => void = (event) =>
    console.log(JSON.stringify(event)),
) {
  const started = performance.now();
  let pending: string | null = null;
  let armed = false;
  let closed = false;
  let abortReported = false;
  const allowedPhases = new Set([
    "setup",
    "body",
    "fixture-open",
    "capture",
    "recover",
    "convert",
    "reference-plan",
    "reference-approve",
    "reference-download",
    "reference-diagnostic-plan",
    "reference-diagnostic-approve",
    "reference-diagnostic-download",
    "reference-diagnostic-inspect",
    "reference-recovery-apply-plan",
    "reference-recovery-apply",
    "reference-recovery-inspect",
    "reference-conversion-inspect",
    "convert-reference",
    "artifact",
    "verification",
    "backup-archive",
    "cleanup",
  ]);
  const emit = (
    event: ReferencePhaseEvent["event"],
    phase: string | null,
    durationMs?: number,
    outcome?: string,
    errorCode?: ErrorCode,
  ) => {
    if (!scenario) return;
    sink({
      scope: "synthetic-reference-phase",
      scenario,
      event,
      phase,
      elapsedMs: Math.round(performance.now() - started),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(errorCode === undefined ? {} : { errorCode }),
      runnerAborted: originalSignal?.aborted ?? false,
    });
  };
  const measure = async <T>(
    phase: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (!scenario) return action();
    if (!originalSignal || !armed || closed || !allowedPhases.has(phase))
      throw new Error("Invalid synthetic phase telemetry.");
    const before = performance.now();
    const previous = pending;
    pending = phase;
    emit("start", phase);
    try {
      const result = await action();
      const outcome =
        result &&
        typeof result === "object" &&
        "status" in result &&
        typeof result.status === "string" &&
        [
          "complete",
          "partial",
          "failed",
          "cancelled",
          "interrupted",
          "unavailable",
        ].includes(result.status)
          ? result.status
          : undefined;
      const code =
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error &&
        typeof result.error === "object" &&
        "code" in result.error
          ? validateContract("ErrorCode", result.error.code)
          : undefined;
      emit(
        "settled",
        phase,
        Math.round(performance.now() - before),
        outcome,
        code?.success ? code.value : undefined,
      );
      return result;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? validateContract("ErrorCode", error.code)
          : undefined;
      emit(
        "rejected",
        phase,
        Math.round(performance.now() - before),
        undefined,
        code?.success ? code.value : undefined,
      );
      throw error;
    } finally {
      pending = previous;
    }
  };
  const reportAbort = () => {
    if (!abortReported) {
      abortReported = true;
      emit("runner-abort", pending);
    }
  };
  return {
    measure,
    arm() {
      if (!scenario || armed) return;
      if (!originalSignal || closed)
        throw new Error("Invalid synthetic telemetry owner.");
      armed = true;
      originalSignal.addEventListener("abort", reportAbort, { once: true });
      if (originalSignal.aborted) reportAbort();
    },
    close() {
      originalSignal?.removeEventListener("abort", reportAbort);
      closed = true;
    },
  };
}
