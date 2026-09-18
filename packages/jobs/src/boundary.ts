import {
  type ContractError,
  type ErrorCode,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";

export class JobFailure extends Error {
  constructor(
    readonly detail: ContractError,
    readonly status:
      | "failed"
      | "cancelled"
      | "interrupted"
      | "unavailable" = "failed",
  ) {
    super(detail.code);
  }
}
export function detail(code: ErrorCode, retryable = false): ContractError {
  return {
    code,
    message: `Job operation: ${code}.`,
    retryable,
    diagnosticIds: [],
  };
}
export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status === "complete") return outcome.value;
  if (outcome.status === "partial")
    throw new JobFailure(outcome.error, "interrupted");
  throw new JobFailure(outcome.error, outcome.status);
}
export function complete<T>(context: OperationContext, value: T): Outcome<T> {
  return {
    schemaVersion: "1.0",
    projectId: context.projectId,
    requestId: context.requestId,
    status: "complete",
    value,
    diagnosticIds: [],
  };
}
export function failure<T>(
  context: Pick<OperationContext, "projectId" | "requestId">,
  error: unknown,
): Outcome<T> {
  const code =
    error instanceof JobFailure
      ? error.detail.code
      : error instanceof HostBoundaryError
        ? error.code
        : "INTERNAL_ERROR";
  return {
    schemaVersion: "1.0",
    projectId: context.projectId,
    requestId: context.requestId,
    status:
      error instanceof JobFailure
        ? error.status
        : code === "CANCELLED"
          ? "cancelled"
          : "failed",
    error: detail(code, error instanceof JobFailure && error.detail.retryable),
    diagnosticIds: [],
  };
}
export function own<T>(value: T): T {
  if (!validateContract("JsonValue", value).success)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Expected bounded plain JSON.",
    );
  return structuredClone(value);
}
export function integer(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new HostBoundaryError("INVALID_INPUT", "Invalid jobs configuration.");
  return value;
}
