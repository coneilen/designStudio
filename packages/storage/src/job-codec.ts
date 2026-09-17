import {
  type ContractName,
  type ContractTypes,
  validateContract,
} from "@design-studio/contracts";
import type {
  JobCancelReceipt,
  JobUsage,
  StoredJob,
  StoredJobResource,
  StoredJobStage,
} from "./job-types.js";
import { StorageError } from "./types.js";

export const JOB_LIMITS = Object.freeze({
  jobs: 20000,
  resources: 20000,
  keys: 32,
  stages: 128,
  effects: 128,
  cancelControls: 128,
  totalCancelControls: 20000,
  scan: 100,
  progress: 10000,
  progressIntervalMs: 50,
  metadataBytes: 26214400,
});
export function jobCheck<K extends ContractName>(
  name: K,
  input: unknown,
): ContractTypes[K] {
  const result = validateContract(name, input);
  if (!result.success)
    throw new StorageError("INVALID_INPUT", `Invalid job ${name}.`);
  return result.value;
}
export function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new StorageError("INVALID_INPUT", "Invalid private job fields.");
  return value as Record<string, unknown>;
}
export function bounded(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new StorageError("LIMIT", "Job list exceeds its bounded profile.");
  return value;
}
export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new StorageError(
      "LIMIT",
      "Job counter is outside its bounded profile.",
    );
  return value;
}
export function increment(value: number, amount = 1): number {
  integer(amount);
  return integer(value + amount);
}
export function usage(value: unknown): JobUsage {
  const result = fields(value, [
    "inputBytes",
    "outputBytes",
    "externalCalls",
    "modelTokens",
    "costMicros",
  ]);
  return {
    inputBytes: integer(result.inputBytes),
    outputBytes: integer(result.outputBytes),
    externalCalls: integer(result.externalCalls),
    modelTokens: integer(result.modelTokens),
    costMicros: integer(result.costMicros),
  };
}
export function zeroUsage(): JobUsage {
  return {
    inputBytes: 0,
    outputBytes: 0,
    externalCalls: 0,
    modelTokens: 0,
    costMicros: 0,
  };
}
export function resourceKeys(value: unknown): string[] {
  const result = bounded(value, JOB_LIMITS.keys).map((key) =>
    jobCheck("StableId", key),
  );
  if (new Set(result).size !== result.length)
    throw new StorageError("INVALID_INPUT", "Duplicate job resource key.");
  return result.sort();
}
export function cancelControlScope(
  control: Pick<JobCancelReceipt, "projectId" | "actorId" | "key">,
): string {
  return JSON.stringify([
    control.projectId,
    control.actorId,
    "job-cancel",
    control.key,
  ]);
}

export function cancelControl(input: unknown): JobCancelReceipt {
  jobCheck("JsonValue", input);
  const data = fields(input, [
    "version",
    "operation",
    "projectId",
    "actorId",
    "key",
    "jobId",
    "expectedVersion",
    "payloadSha256",
    "resultVersion",
    "resultStatus",
    "recordedAt",
  ]);
  if (data.version !== 1 || data.operation !== "job-cancel")
    throw new StorageError(
      "INTEGRITY",
      "Unsupported cancellation-control receipt.",
    );
  for (const key of ["projectId", "actorId", "key", "jobId"])
    jobCheck("StableId", data[key]);
  integer(data.expectedVersion, 1);
  integer(data.resultVersion, 1);
  jobCheck("Sha256", data.payloadSha256);
  jobCheck("Timestamp", data.recordedAt);
  if (
    !["cancel-requested", "cancelled", "completed", "failed"].includes(
      String(data.resultStatus),
    )
  )
    throw new StorageError("INTEGRITY", "Invalid cancellation-control result.");
  return input as JobCancelReceipt;
}

export function storedJob(input: unknown): StoredJob {
  jobCheck("JsonValue", input);
  const data = fields(
    input,
    [
      "submission",
      "job",
      "requestId",
      "handlerId",
      "handlerVersion",
      "authorityRef",
      "resourceKeys",
      "rowVersion",
      "generation",
      "resources",
      "createdAt",
      "updatedAt",
      "progressSequence",
      "lastProgressAt",
      "usage",
      "effects",
    ],
    ["inputRevision", "finalOutputSha256", "restoredLease", "cancelControls"],
  );
  const submission = fields(
    data.submission,
    [
      "id",
      "operation",
      "input",
      "resources",
      "handlerId",
      "handlerVersion",
      "authorityRef",
      "resourceKeys",
      "deadline",
      "budget",
    ],
    ["inputRevision"],
  );
  for (const key of ["id", "handlerId", "handlerVersion", "authorityRef"])
    jobCheck("StableId", submission[key]);
  jobCheck("Operation", submission.operation);
  jobCheck("ArtifactReference", submission.input);
  jobCheck("ResourceLock", submission.resources);
  jobCheck("Timestamp", submission.deadline);
  jobCheck("Budget", submission.budget);
  if (submission.inputRevision !== undefined)
    jobCheck("ArtifactReference", submission.inputRevision);
  resourceKeys(submission.resourceKeys);
  const job = jobCheck("Job", data.job);
  for (const key of [
    "requestId",
    "handlerId",
    "handlerVersion",
    "authorityRef",
  ])
    jobCheck("StableId", data[key]);
  integer(data.rowVersion, 1);
  const controls = new Set<string>();
  let previousControlVersion = 0;
  for (const item of bounded(
    data.cancelControls === undefined ? [] : data.cancelControls,
    JOB_LIMITS.cancelControls,
  )) {
    const control = cancelControl(item);
    const scope = cancelControlScope(control);
    if (
      controls.has(scope) ||
      control.jobId !== job.id ||
      control.projectId !== job.projectId ||
      control.resultVersion <= previousControlVersion ||
      control.resultVersion > integer(data.rowVersion) ||
      (control.resultStatus !== "cancel-requested" &&
        control.resultStatus !== job.status) ||
      (control.resultStatus !== "completed" &&
        control.expectedVersion >= control.resultVersion)
    )
      throw new StorageError(
        "INTEGRITY",
        "Cancellation-control owner/version binding is inconsistent.",
      );
    controls.add(scope);
    previousControlVersion = control.resultVersion;
  }
  integer(data.generation);
  integer(job.attempt);
  integer(data.progressSequence, 0, JOB_LIMITS.progress);
  jobCheck("Timestamp", data.createdAt);
  jobCheck("Timestamp", data.updatedAt);
  if (data.lastProgressAt !== null) jobCheck("Timestamp", data.lastProgressAt);
  resourceKeys(data.resourceKeys);
  const reservations = bounded(data.resources, JOB_LIMITS.keys);
  const keys = new Set<string>();
  for (const item of reservations) {
    const reservation = fields(item, ["key", "generation"]);
    const key = jobCheck("StableId", reservation.key);
    if (keys.has(key))
      throw new StorageError("INVALID_INPUT", "Duplicate job reservation.");
    keys.add(key);
    integer(reservation.generation, 1);
  }
  const totals = usage(data.usage);
  const limits = {
    inputBytes: "maxInputBytes",
    outputBytes: "maxOutputBytes",
    externalCalls: "maxExternalCalls",
    modelTokens: "maxModelTokens",
    costMicros: "maxCostMicros",
  } as const;
  for (const key of Object.keys(limits) as (keyof JobUsage)[])
    if (totals[key] > job.budget[limits[key]])
      throw new StorageError(
        "INTEGRITY",
        "Job usage exceeds its immutable budget.",
      );
  if (job.attempt > job.budget.maxAttempts)
    throw new StorageError("INTEGRITY", "Job attempts exceed budget.");
  const effectIds = new Set<string>();
  const reserved = zeroUsage();
  for (const item of bounded(data.effects, JOB_LIMITS.effects)) {
    const effect = fields(item, ["id", "reserved", "state"], ["actual"]);
    const id = jobCheck("StableId", effect.id);
    if (effectIds.has(id))
      throw new StorageError("INVALID_INPUT", "Duplicate job effect.");
    effectIds.add(id);
    const amount = usage(effect.reserved);
    for (const key of Object.keys(limits) as (keyof JobUsage)[])
      reserved[key] = increment(reserved[key], amount[key]);
    if (
      !["reserved", "settled", "no-effect", "unknown"].includes(
        String(effect.state),
      )
    )
      throw new StorageError("INVALID_INPUT", "Invalid effect disposition.");
    if (effect.state === "settled") {
      const actual = usage(effect.actual);
      for (const key of Object.keys(limits) as (keyof JobUsage)[])
        if (actual[key] > amount[key])
          throw new StorageError(
            "INTEGRITY",
            "Settled effect exceeds reservation.",
          );
    } else if (effect.actual !== undefined)
      throw new StorageError("INVALID_INPUT", "Unexpected effect usage.");
  }
  for (const key of Object.keys(limits) as (keyof JobUsage)[])
    if (reserved[key] > totals[key])
      throw new StorageError(
        "INTEGRITY",
        "Effect reservations exceed cumulative usage.",
      );
  bounded(job.diagnosticIds, JOB_LIMITS.stages);
  if (data.inputRevision !== undefined)
    jobCheck("ArtifactReference", data.inputRevision);
  if (data.finalOutputSha256 !== undefined)
    jobCheck("Sha256", data.finalOutputSha256);
  if (
    job.projectId !== job.idempotency.projectId ||
    job.actorId !== job.idempotency.actorId ||
    job.operation !== job.idempotency.operation ||
    data.requestId !== job.idempotency.key ||
    (job.status === "completed") !== (job.receipt !== undefined) ||
    (job.status === "completed") !== (data.finalOutputSha256 !== undefined) ||
    (job.status !== "completed" && job.progress === 1) ||
    (job.status === "completed" && job.progress !== 1)
  )
    throw new StorageError(
      "INTEGRITY",
      "Job identity/state binding is inconsistent.",
    );
  if (job.lease) {
    integer(job.lease.fencingToken, 1);
    if (
      job.lease.resourceId !== job.id ||
      job.lease.fencingToken > integer(data.generation)
    )
      throw new StorageError(
        "INTEGRITY",
        "Job lease generation is inconsistent.",
      );
  }
  if (
    data.restoredLease !== undefined &&
    (data.restoredLease !== true ||
      job.status !== "interrupted" ||
      !job.lease ||
      job.lease.fencingToken >= integer(data.generation))
  )
    throw new StorageError(
      "INTEGRITY",
      "Restored lease evidence must be interrupted and generation-invalidated.",
    );
  if (
    (job.status === "running" || job.status === "cancel-requested") &&
    !job.lease
  )
    throw new StorageError("INTEGRITY", "Active job lacks a lease.");
  if (job.status === "running" || job.status === "cancel-requested") {
    const declared = resourceKeys(data.resourceKeys);
    if (
      declared.length !== keys.size ||
      declared.some((key) => !keys.has(key)) ||
      job.lease?.fencingToken !== data.generation
    )
      throw new StorageError(
        "INTEGRITY",
        "Active job lacks its complete resource generation set.",
      );
  }
  if (
    (keys.size > 0 && !job.lease) ||
    (job.lease &&
      !["running", "cancel-requested", "interrupted"].includes(job.status))
  )
    throw new StorageError(
      "INTEGRITY",
      "Job state cannot own execution resources.",
    );
  return input as StoredJob;
}
export function storedResource(input: unknown): StoredJobResource {
  jobCheck("JsonValue", input);
  const data = fields(input, [
    "key",
    "generation",
    "state",
    "jobId",
    "leaseId",
    "fencingToken",
  ]);
  jobCheck("StableId", data.key);
  integer(data.generation, 1);
  if (!["released", "held", "quarantined"].includes(String(data.state)))
    throw new StorageError("INVALID_INPUT", "Invalid resource disposition.");
  if (data.state === "released") {
    if (
      data.jobId !== null ||
      data.leaseId !== null ||
      data.fencingToken !== null
    )
      throw new StorageError(
        "INTEGRITY",
        "Released resource retains an owner.",
      );
  } else {
    jobCheck("StableId", data.jobId);
    jobCheck("StableId", data.leaseId);
    integer(data.fencingToken, 1);
  }
  return input as StoredJobResource;
}
export function storedStage(input: unknown): StoredJobStage {
  jobCheck("JsonValue", input);
  const data = fields(input, [
    "stagingId",
    "artifactRootId",
    "staged",
    "jobId",
    "requestId",
    "attempt",
    "fencingToken",
    "leaseId",
    "hostInstanceId",
    "disposition",
  ]);
  for (const key of [
    "stagingId",
    "artifactRootId",
    "jobId",
    "requestId",
    "leaseId",
    "hostInstanceId",
  ])
    jobCheck("StableId", data[key]);
  integer(data.attempt, 1);
  integer(data.fencingToken, 1);
  const stage = fields(data.staged, ["stagingId", "artifact"]);
  jobCheck("Artifact", stage.artifact);
  if (
    stage.stagingId !== data.stagingId ||
    !["retained", "recovery-needed", "authorized-abandoned"].includes(
      String(data.disposition),
    )
  )
    throw new StorageError("INTEGRITY", "Invalid stage ownership/disposition.");
  return input as StoredJobStage;
}
