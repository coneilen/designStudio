import { randomUUID } from "node:crypto";
import {
  type Clock,
  DEFAULT_BUDGETS,
  validateContract,
} from "@design-studio/contracts";
import { SystemClock } from "@design-studio/host";
import { ApplicationError } from "./response.js";

export interface CommandOperation {
  readonly requestId: string;
  readonly deadline: string;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}
export function snapshotCommandOperation(
  operation: CommandOperation,
): CommandOperation {
  const owned = Object.freeze({
    requestId: operation.requestId,
    deadline: operation.deadline,
    clock: operation.clock,
    signal: operation.signal,
  });
  if (
    !validateContract("StableId", owned.requestId).success ||
    !validateContract("Timestamp", owned.deadline).success ||
    typeof owned.clock?.now !== "function" ||
    typeof owned.clock.sleep !== "function" ||
    !(owned.signal instanceof AbortSignal)
  )
    throw new ApplicationError("INVALID_INPUT");
  return owned;
}
export function checkCommandOperation(operation: CommandOperation): void {
  const now = operation.clock.now();
  if (!Number.isFinite(now) || now >= Date.parse(operation.deadline))
    throw new ApplicationError("DEADLINE_EXCEEDED", 504);
  if (operation.signal.aborted) {
    const reason: unknown = operation.signal.reason;
    if (
      reason instanceof ApplicationError &&
      reason.code === "DEADLINE_EXCEEDED"
    )
      throw reason;
    throw new ApplicationError("CANCELLED");
  }
}
export function remainingCommandMs(operation: CommandOperation): number {
  checkCommandOperation(operation);
  const remaining = Math.floor(
    Date.parse(operation.deadline) - operation.clock.now(),
  );
  if (remaining < 1) throw new ApplicationError("DEADLINE_EXCEEDED", 504);
  return remaining;
}
export function createCommandLifetime(timeoutMs: number, signal?: AbortSignal) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_BUDGETS.maxDurationMs
  )
    throw new ApplicationError("INVALID_INPUT");
  const controller = new AbortController();
  const system = new SystemClock();
  const start = system.now();
  const monotonicStart = performance.now();
  const clock: Clock = Object.freeze({
    now: () => start + Math.floor(performance.now() - monotonicStart),
    sleep: system.sleep.bind(system),
  });
  const operation = snapshotCommandOperation({
    requestId: randomUUID(),
    deadline: new Date(start + timeoutMs).toISOString(),
    clock,
    signal: controller.signal,
  });
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new ApplicationError("DEADLINE_EXCEEDED", 504)),
    timeoutMs,
  );
  return {
    operation,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
}
