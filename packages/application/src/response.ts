import { randomUUID } from "node:crypto";
import {
  ContractBoundaryError,
  type Diagnostic,
  type ErrorCode,
  type Job,
  type Outcome,
  type ResponseEnvelope,
  referenceDiagnosticFields,
  validateContract,
} from "@design-studio/contracts";

export type ResponseData = Extract<ResponseEnvelope, { success: true }>["data"];
export function draftWarning(): Diagnostic {
  return {
    schemaVersion: "1.0",
    id: "foundation_unapproved",
    code: "APPROVAL_REQUIRED",
    severity: "warning",
    message:
      "Synthetic fixture output is an unapproved draft, not an implementation handoff.",
    operations: [],
    nodeIds: [],
    evidenceIds: [],
    recovery:
      "No approval or handoff compiler is implemented in this foundation.",
  };
}
const messages: Partial<Record<ErrorCode, string>> = {
  ACTION_REQUIRED:
    "A trusted installed fixture configuration, registered project, or required precondition is missing. Consult the fixture setup instructions; no automatic setup was performed.",
  AUTH_REQUIRED:
    "Use the owned launchLocalSession controller or with-session credential channel. Credentials are never accepted in command arguments.",
  INVALID_INPUT:
    "Invalid command, parameter, or schema. Use designctl --help --json.",
  CONFLICT:
    "The expected version, logical request, or exclusive writer ownership conflicts with current state.",
  DEADLINE_EXCEEDED:
    "The finite wait expired. Inspect the job before retrying; accepted work was not rolled back.",
};
export class ApplicationError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus = 400,
    readonly jobId?: string,
    readonly referenceDiagnostic?: import("@design-studio/contracts").ReferenceDiagnostic,
  ) {
    super(code);
  }
}
export function success(
  requestId: string,
  data: ResponseData,
): ResponseEnvelope {
  const envelope = { schemaVersion: "1.0", success: true, requestId, data };
  const checked = validateContract("ResponseEnvelope", envelope);
  if (!checked.success) throw new ApplicationError("INTERNAL_ERROR", 500);
  if (
    data.kind === "job" &&
    !validateContract("FoundationVersionedJobResponse", envelope).success
  )
    throw new ApplicationError("INTERNAL_ERROR", 500);
  return structuredClone(checked.value);
}
export function failure(
  requestId: string,
  code: ErrorCode,
  jobId?: string,
): ResponseEnvelope {
  return {
    schemaVersion: "1.0",
    success: false,
    requestId: validateContract("StableId", requestId).success
      ? requestId
      : randomUUID(),
    error: {
      code,
      message: messages[code] ?? code,
      retryable: false,
      diagnosticIds: [],
      ...(jobId ? { jobId } : {}),
    },
  };
}
export function safeError(error: unknown): ApplicationError {
  if (error instanceof ContractBoundaryError)
    return new ApplicationError("INVALID_INPUT", 400);
  if (error instanceof ApplicationError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const checked = validateContract("ErrorCode", error.code);
    if (checked.success)
      return new ApplicationError(
        checked.value,
        statusCode(checked.value),
        undefined,
        referenceDiagnosticFields(error).referenceDiagnostic,
      );
    if (error.code === "WRITER_BUSY")
      return new ApplicationError("CONFLICT", 409);
    if (error.code === "SCHEMA_INCOMPATIBLE")
      return new ApplicationError("ACTION_REQUIRED", 409);
    if (error.code === "INTEGRITY")
      return new ApplicationError("ARTIFACT_INTEGRITY", 500);
  }
  return new ApplicationError("INTERNAL_ERROR", 500);
}
export function statusCode(code: ErrorCode): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "AUTH_REQUIRED") return 401;
  if (
    [
      "FORBIDDEN",
      "ORIGIN_FORBIDDEN",
      "CSRF_INVALID",
      "PATH_FORBIDDEN",
    ].includes(code)
  )
    return 403;
  if (
    [
      "CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "ACTION_REQUIRED",
      "INTERRUPTED",
      "OUTPUT_UNCERTAIN",
    ].includes(code)
  )
    return 409;
  if (code === "INPUT_LIMIT") return 413;
  if (code === "DEADLINE_EXCEEDED") return 504;
  if (
    ["TOOL_MISSING", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_HOST"].includes(code)
  )
    return 503;
  if (code === "INTERNAL_ERROR" || code === "ARTIFACT_INTEGRITY") return 500;
  return 400;
}
export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status !== "complete")
    throw new ApplicationError(
      outcome.error.code,
      statusCode(outcome.error.code),
      outcome.error.jobId,
      referenceDiagnosticFields(outcome.error).referenceDiagnostic,
    );
  return outcome.value;
}
export function exitCode(envelope: ResponseEnvelope, wait = false): number {
  if (!envelope.success) {
    const code = envelope.error.code;
    if (code === "POLICY_FAILED") return 3;
    if (code === "VALIDATION_INCONCLUSIVE") return 4;
    if (
      [
        "INVALID_INPUT",
        "INVALID_SCHEMA",
        "UNSUPPORTED_SCHEMA_VERSION",
        "INPUT_LIMIT",
      ].includes(code)
    )
      return 2;
    if (
      [
        "CONFLICT",
        "IDEMPOTENCY_CONFLICT",
        "ACTION_REQUIRED",
        "AUTH_REQUIRED",
        "FORBIDDEN",
        "ORIGIN_FORBIDDEN",
        "CSRF_INVALID",
        "APPROVAL_REQUIRED",
        "INTERRUPTED",
        "OUTPUT_UNCERTAIN",
      ].includes(code)
    )
      return 5;
    return 1;
  }
  if (wait && envelope.data.kind === "job" && envelope.data.job)
    return jobExit(envelope.data.job);
  return 0;
}
function jobExit(job: Job): number {
  if (job.status === "completed")
    return job.comparisonVerdict === "fail"
      ? 3
      : job.comparisonVerdict === "inconclusive"
        ? 4
        : 0;
  if (job.status === "waiting-for-user" || job.status === "interrupted")
    return 5;
  return 1;
}
