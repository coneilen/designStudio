import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ContractError,
  type FileSystemBoundary,
  type OperationContext,
  type Outcome,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import {
  authorizeOperation,
  HostBoundaryError,
  snapshotOperationContext,
} from "@design-studio/host";
import {
  JOB_STORAGE_LIMITS,
  type JobCommand,
  type JobUsage,
  type JobWorkerExpected,
  type StoredJob,
} from "@design-studio/storage";
import { complete, detail, failure, own, unwrap } from "./boundary.js";
import type { JobExecution, JobServiceOptions, StageFailure } from "./types.js";

export function fence(record: StoredJob): JobWorkerExpected {
  const lease = record.job.lease;
  if (!lease || lease.fencingToken !== record.generation)
    throw new HostBoundaryError(
      "LEASE_LOST",
      "Execution lease is unavailable.",
    );
  return {
    state: record.job.status,
    rowVersion: record.rowVersion,
    leaseId: lease.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    resources: structuredClone(record.resources),
  };
}

export class Execution implements JobExecution {
  readonly context: OperationContext;
  readonly filesystem: Pick<FileSystemBoundary, "stage">;
  private current: StoredJob;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingProgress: number | undefined;
  private highestProgress: number;
  private readonly originalFence: JobWorkerExpected;
  closing = false;
  private failedStage: StageFailure | undefined;
  refreshFailure: ContractError | undefined;

  constructor(
    record: StoredJob,
    context: OperationContext,
    private readonly options: JobServiceOptions,
  ) {
    this.current = structuredClone(record);
    this.originalFence = fence(record);
    this.context = snapshotOperationContext(context);
    this.highestProgress = record.job.progress;
    this.filesystem = Object.freeze({
      stage: async (request, bytes, supplied) => {
        try {
          supplied = snapshotOperationContext(supplied);
          if (
            supplied.authorization !== this.context.authorization ||
            supplied.signal !== this.context.signal ||
            supplied.clock !== this.context.clock ||
            supplied.projectId !== this.context.projectId ||
            supplied.requestId !== this.context.requestId ||
            supplied.jobId !== this.context.jobId ||
            supplied.deadline !== this.context.deadline ||
            !isDeepStrictEqual(supplied.budget, this.context.budget)
          )
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Staging cannot replace execution authority.",
            );
          if (
            !validateContract("FileRequest", request).success ||
            request.artifactRootId !== options.artifactRootId ||
            bytes.byteLength > this.context.budget.maxInputBytes ||
            request.path !==
              `blobs/${createHash("sha256").update(bytes).digest("hex")}`
          )
            throw new HostBoundaryError(
              "PATH_FORBIDDEN",
              "Staging must use the managed content address.",
            );
          return await this.stage(bytes);
        } catch (error) {
          return failure(this.context, error);
        }
      },
    } satisfies Pick<FileSystemBoundary, "stage">);
  }
  get record(): StoredJob {
    return structuredClone(this.current);
  }
  get stageFailure(): StageFailure | undefined {
    return this.failedStage === undefined ? undefined : own(this.failedStage);
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // The caller receives the rejection; the lane must still admit recovery.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  adopt(record: StoredJob): void {
    if (record.job.id !== this.current.job.id)
      throw new HostBoundaryError("CONFLICT", "Execution identity changed.");
    this.current = structuredClone(record);
  }
  check(): void {
    this.assertOwner();
    authorizeOperation(
      this.context,
      {
        projectId: this.context.projectId,
        resourceKind: "job",
        resourceId: this.current.job.id,
        operation: "write",
      },
      this.options.executionAuthority.verify,
    );
    const lease = fence(this.current);
    if (
      lease.fencingToken !== this.current.job.lease?.fencingToken ||
      this.options.clock.now() >=
        Date.parse(this.current.job.lease.expiresAt) ||
      this.current.job.status !== "running"
    )
      throw new HostBoundaryError("LEASE_LOST", "Execution is no longer live.");
  }
  assertOwner(): void {
    const current = fence(this.current);
    if (
      current.leaseId !== this.originalFence.leaseId ||
      current.ownerId !== this.originalFence.ownerId ||
      current.fencingToken !== this.originalFence.fencingToken ||
      !isDeepStrictEqual(current.resources, this.originalFence.resources)
    )
      throw new HostBoundaryError(
        "LEASE_LOST",
        "A callback cannot adopt another execution's fence.",
      );
  }
  async refresh(context: OperationContext): Promise<StoredJob> {
    const record = unwrap(
      await this.options.repository.get(this.current.job.id, context),
    );
    this.adopt(record);
    return record;
  }
  checkpoint(): Promise<void> {
    return this.serial(async () => {
      if (this.closing)
        throw new HostBoundaryError("CONFLICT", "Handler has returned.");
      await this.refresh(this.context);
      this.check();
    });
  }
  stage(bytes: Uint8Array): Promise<Outcome<StagedArtifact>> {
    let owned: Uint8Array;
    try {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > this.context.budget.maxInputBytes ||
        bytes.byteLength > this.context.budget.maxOutputBytes
      )
        throw new HostBoundaryError(
          "INPUT_LIMIT",
          "Staged bytes exceed the execution budget.",
        );
      owned = Uint8Array.from(bytes);
    } catch (error) {
      return Promise.resolve(failure(this.context, error));
    }
    return this.serial(async () => {
      try {
        if (this.closing)
          throw new HostBoundaryError("CONFLICT", "Handler has returned.");
        this.check();
        this.checkUsage({
          inputBytes: owned.length,
          outputBytes: owned.length,
          externalCalls: 0,
          modelTokens: 0,
          costMicros: 0,
        });
        const result = await this.options.repository.stage(
          this.current.job.id,
          fence(this.current),
          owned,
          this.context,
        );
        if (result.status !== "complete") {
          this.failedStage =
            result.status === "partial"
              ? { ...own(result), value: own(result.value.staged) }
              : own(result);
          // Even a failed stage can reserve bytes and advance the durable version.
          // Refresh failure must not erase the primary outcome or its known receipt.
          try {
            const refreshed = await this.options.repository.get(
              this.current.job.id,
              this.context,
            );
            if (refreshed.status === "complete") this.adopt(refreshed.value);
            else this.refreshFailure = detail(refreshed.error.code);
          } catch {
            this.refreshFailure = detail("INTERNAL_ERROR");
          }
          return own(this.failedStage);
        }
        this.adopt(result.value.record);
        return complete(this.context, result.value.staged);
      } catch (error) {
        return failure(this.context, error);
      }
    });
  }
  async command(command: JobCommand): Promise<void> {
    this.assertOwner();
    this.adopt(
      unwrap(
        await this.options.repository.update(
          this.current.job.id,
          fence(this.current),
          command,
          this.context,
        ),
      ),
    );
  }
  progress(progress: number): Promise<void> {
    return this.serial(async () => {
      if (this.closing)
        throw new HostBoundaryError("CONFLICT", "Handler has returned.");
      this.check();
      if (
        !Number.isFinite(progress) ||
        progress < this.highestProgress ||
        progress >= 1
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Progress must be monotonic and below completion.",
        );
      this.highestProgress = progress;
      this.pendingProgress = progress;
      await this.flushProgress();
    });
  }
  async flushProgress(): Promise<void> {
    if (
      this.pendingProgress === undefined ||
      (this.current.lastProgressAt !== null &&
        this.options.clock.now() - Date.parse(this.current.lastProgressAt) <
          JOB_STORAGE_LIMITS.progressIntervalMs)
    )
      return;
    await this.command({
      kind: "progress",
      sequence: this.current.progressSequence + 1,
      progress: this.pendingProgress,
    });
    this.pendingProgress = undefined;
  }
  reserve(id: string, usage: JobUsage): Promise<void> {
    const captured = own(usage);
    return this.serial(async () => {
      if (this.closing)
        throw new HostBoundaryError("CONFLICT", "Handler has returned.");
      this.check();
      this.checkUsage(captured);
      await this.command({ kind: "reserve-usage", id, usage: captured });
    });
  }
  private checkUsage(amount: JobUsage): void {
    const limits: JobUsage = {
      inputBytes: this.context.budget.maxInputBytes,
      outputBytes: this.context.budget.maxOutputBytes,
      externalCalls: this.context.budget.maxExternalCalls,
      modelTokens: this.context.budget.maxModelTokens,
      costMicros: this.context.budget.maxCostMicros,
    };
    for (const key of Object.keys(limits) as (keyof JobUsage)[]) {
      if (!Number.isSafeInteger(amount[key]) || amount[key] < 0)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid usage reservation.",
        );
      if (amount[key] > limits[key] - this.current.usage[key])
        throw new HostBoundaryError(
          key === "outputBytes" ? "OUTPUT_LIMIT" : "INPUT_LIMIT",
          "Cumulative execution budget exceeded.",
        );
    }
  }
  settle(
    id: string,
    result: "no-effect" | "unknown" | JobUsage,
  ): Promise<void> {
    const captured = typeof result === "string" ? result : own(result);
    return this.serial(async () => {
      if (this.closing)
        throw new HostBoundaryError("CONFLICT", "Handler has returned.");
      await this.command(
        typeof captured === "string"
          ? { kind: "settle-usage", id, result: captured }
          : { kind: "settle-usage", id, result: "settled", actual: captured },
      );
    });
  }
}
