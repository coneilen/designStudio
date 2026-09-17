import { randomUUID } from "node:crypto";
import {
  type Artifact,
  type ArtifactReference,
  type CommitReceipt,
  DEFAULT_BUDGETS,
  type Job,
  type OperationContext,
  type Outcome,
  type StagedArtifact,
} from "@design-studio/contracts";
import type Database from "better-sqlite3";
import {
  bounded,
  cancelControlScope,
  fields,
  increment,
  integer,
  JOB_LIMITS,
  jobCheck,
  resourceKeys,
  storedJob,
  storedResource,
  storedStage,
  usage,
  zeroUsage,
} from "./job-codec.js";
import type {
  JobCancelReceipt,
  JobCancelResult,
  JobCommand,
  JobCommitResult,
  JobCompletion,
  JobExpected,
  JobPage,
  JobReconciliation,
  JobRepository,
  JobScan,
  JobStageResult,
  JobSubmission,
  JobUsage,
  JobWorkerExpected,
  StoredJob,
  StoredJobResource,
  StoredJobStage,
} from "./job-types.js";
import {
  type RevisionCommit,
  StorageError,
  type StorageOptions,
  type StorageScope,
} from "./types.js";

export interface JobCommitHooks {
  prepare(context: OperationContext): Promise<void>;
  scope(): string;
  operation(): Job["operation"];
  actorId(): string;
  payload: JobCompletion;
  verify(
    evidence: { artifact: Artifact; bytes: Uint8Array }[],
    context: OperationContext,
  ): Promise<void>;
  check(context: OperationContext): void;
  finish(receipt: CommitReceipt, context: OperationContext): void;
}

/** Package-private bridge; callers never receive a database or transaction callback. */
export interface JobHost {
  db: Database.Database;
  options: StorageOptions;
  run<T>(
    context: OperationContext,
    operation: "read" | "write",
    action: (context: OperationContext) => Promise<T>,
  ): Promise<Outcome<T>>;
  snapshot<T, R>(
    input: T,
    context: OperationContext,
    operation: "read" | "write",
    action: (input: T) => Promise<Outcome<R>>,
  ): Promise<Outcome<R>>;
  guard(
    context: OperationContext,
    operation: "read" | "write",
    kind: StorageScope["resourceKind"],
    id: string,
  ): Promise<void>;
  checkpoint(context: OperationContext): void;
  digest(value: unknown): string;
  read(artifact: Artifact, context: OperationContext): Promise<Uint8Array>;
  artifact(reference: ArtifactReference): Artifact;
  hasCommittedPublication(artifact: Artifact): boolean;
  refs(kind: string, id: string, references: ArtifactReference[]): void;
  stage(bytes: Uint8Array, context: OperationContext): Promise<StagedArtifact>;
  commit(
    outputs: StagedArtifact[],
    context: OperationContext,
    request: RevisionCommit | undefined,
    hooks: JobCommitHooks,
  ): Promise<Outcome<CommitReceipt>>;
  verifyInputRevision(
    reference: ArtifactReference,
    context: OperationContext,
  ): Promise<void>;
}

const terminal = new Set<Job["status"]>(["completed", "failed", "cancelled"]);
const databaseTimestamp = (value: string | undefined): string | null =>
  value === undefined ? null : new Date(Date.parse(value)).toISOString();
const usageLimits = {
  inputBytes: "maxInputBytes",
  outputBytes: "maxOutputBytes",
  externalCalls: "maxExternalCalls",
  modelTokens: "maxModelTokens",
  costMicros: "maxCostMicros",
} as const;
const interruptedError = {
  code: "INTERRUPTED" as const,
  message: "Restored execution requires trusted reconciliation.",
  retryable: false,
  diagnosticIds: [],
};
export class StoredJobs implements JobRepository {
  private readonly hostInstanceId = `host-${randomUUID()}`;
  private readonly config;
  constructor(private readonly host: JobHost) {
    const config = host.options.jobs;
    this.config = config
      ? Object.freeze({
          ...config,
          limits: Object.freeze({ ...(config.limits ?? DEFAULT_BUDGETS) }),
          maxWorkers: integer(config.maxWorkers ?? 1, 1, 4),
        })
      : undefined;
    if (this.config) jobCheck("Budget", this.config.limits);
  }
  private enabled() {
    if (!this.config)
      throw new StorageError(
        "INVALID_INPUT",
        "Trusted jobs composition is not configured.",
      );
    return this.config;
  }
  private now(): number {
    return integer(this.enabled().clock.now());
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private async authorize(
    id: string,
    context: OperationContext,
    operation: "read" | "write",
  ) {
    this.enabled();
    jobCheck("StableId", id);
    await this.host.guard(context, operation, "job", id);
  }
  private identity(record: StoredJob, context: OperationContext) {
    if (context.clock !== this.enabled().clock)
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "Workers require the original trusted shared clock.",
      );
    if (
      record.job.actorId !== context.authorization.actorId ||
      record.job.id !== context.jobId ||
      record.requestId !== context.requestId ||
      record.job.projectId !== context.projectId
    )
      throw new StorageError(
        "CONFLICT",
        "Execution context differs from original job identity.",
      );
  }
  tracked(id: string): boolean {
    return !!this.host.db.prepare("SELECT 1 FROM jobs WHERE id=?").get(id);
  }
  load(id: string): StoredJob {
    const row = this.host.db
      .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
      .get(id);
    if (!row) throw new StorageError("NOT_FOUND", "Job does not exist.");
    const record = storedJob(JSON.parse(row.data));
    this.validateBinding(record);
    return record;
  }
  validateBinding(record: StoredJob) {
    for (const control of record.cancelControls ?? [])
      if (
        control.payloadSha256 !==
        this.host.digest({
          jobId: control.jobId,
          expectedVersion: control.expectedVersion,
        })
      )
        throw new StorageError(
          "INTEGRITY",
          "Cancellation-control payload digest changed.",
        );
    const submission = record.submission;
    const expectedDeadline = Math.min(
      Date.parse(submission.deadline),
      Date.parse(record.createdAt) + submission.budget.maxDurationMs,
    );
    if (
      this.host.digest(submission) !== record.job.idempotency.payloadSha256 ||
      submission.id !== record.job.id ||
      submission.operation !== record.job.operation ||
      submission.handlerId !== record.handlerId ||
      submission.handlerVersion !== record.handlerVersion ||
      submission.authorityRef !== record.authorityRef ||
      this.host.digest(submission.input) !==
        this.host.digest(record.job.input) ||
      this.host.digest(submission.resources) !==
        this.host.digest(record.job.resources) ||
      this.host.digest(submission.budget) !==
        this.host.digest(record.job.budget) ||
      this.host.digest(submission.resourceKeys) !==
        this.host.digest(record.resourceKeys) ||
      this.host.digest(submission.inputRevision ?? null) !==
        this.host.digest(record.inputRevision ?? null) ||
      Date.parse(record.job.deadline) !== expectedDeadline
    )
      throw new StorageError(
        "INTEGRITY",
        "Job submission digest/bindings changed.",
      );
  }
  private save(record: StoredJob) {
    storedJob(record);
    this.host.db
      .prepare("UPDATE jobs SET state=?,due=?,data=? WHERE id=?")
      .run(
        record.job.status,
        databaseTimestamp(record.job.nextEligibleAttempt),
        JSON.stringify(record),
        record.job.id,
      );
  }
  private bump(record: StoredJob) {
    record.rowVersion = increment(record.rowVersion);
    record.updatedAt = this.timestamp();
  }
  private expect(record: StoredJob, expected: JobExpected) {
    integer(expected.rowVersion, 1);
    jobCheck("JobStatus", expected.state);
    if (
      record.rowVersion !== expected.rowVersion ||
      record.job.status !== expected.state
    )
      throw new StorageError("CONFLICT", "Job state/version changed.");
  }
  private resource(key: string): StoredJobResource | undefined {
    const row = this.host.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM job_resources WHERE key=?",
      )
      .get(key);
    return row ? storedResource(JSON.parse(row.data)) : undefined;
  }
  private saveResource(resource: StoredJobResource) {
    storedResource(resource);
    this.host.db
      .prepare(
        "INSERT INTO job_resources VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(resource.key, JSON.stringify(resource));
  }
  private live(
    id: string,
    expected: JobWorkerExpected,
    context: OperationContext,
    completion = false,
  ): StoredJob {
    this.host.checkpoint(context);
    const record = this.load(id);
    this.identity(record, context);
    this.expect(record, expected);
    const lease = record.job.lease;
    const now = this.now();
    if (
      !lease ||
      (record.job.status !== "running" &&
        !completion &&
        record.job.status !== "cancel-requested") ||
      (completion && record.job.status !== "running") ||
      lease.id !== expected.leaseId ||
      lease.ownerId !== expected.ownerId ||
      lease.fencingToken !== expected.fencingToken ||
      record.generation !== expected.fencingToken ||
      now >= Date.parse(lease.expiresAt) ||
      now >= Date.parse(record.job.deadline) ||
      now >= Date.parse(context.authorization.expiresAt) ||
      now >= Date.parse(context.deadline) ||
      this.host.digest(record.resources) !==
        this.host.digest(expected.resources)
    )
      throw new StorageError(
        "CONFLICT",
        "Worker lease, deadline or resource fence is no longer live.",
      );
    for (const reservation of record.resources) {
      const resource = this.resource(reservation.key);
      if (
        resource?.state !== "held" ||
        resource.generation !== reservation.generation ||
        resource.jobId !== id ||
        resource.leaseId !== lease.id ||
        resource.fencingToken !== lease.fencingToken
      )
        throw new StorageError(
          "CONFLICT",
          "Resource generation is no longer owned by this worker.",
        );
    }
    return record;
  }
  private transaction<T>(
    context: OperationContext,
    action: () => T,
    finalCheck?: () => void,
  ): T {
    return this.host.db.transaction(() => {
      this.host.checkpoint(context);
      const result = action();
      this.host.options.fault?.("before-commit");
      this.host.checkpoint(context);
      finalCheck?.();
      return result;
    })();
  }
  private workerTransaction<T>(
    id: string,
    expected: JobWorkerExpected,
    context: OperationContext,
    action: (record: StoredJob) => T,
    completion = false,
  ): T {
    let expiresAt = 0;
    return this.transaction(
      context,
      () => {
        const record = this.live(id, expected, context, completion);
        expiresAt = Math.min(
          Date.parse(record.job.lease?.expiresAt ?? ""),
          Date.parse(record.job.deadline),
          Date.parse(context.authorization.expiresAt),
        );
        return action(record);
      },
      () => {
        if (!Number.isFinite(expiresAt) || this.now() >= expiresAt)
          throw new StorageError(
            "CONFLICT",
            "Original worker lease expired before transaction completion.",
          );
      },
    );
  }
  private count(table: "jobs" | "job_resources" | "job_stages", limit: number) {
    const row = this.host.db
      .prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`)
      .get();
    if (!row || row.count >= limit)
      throw new StorageError("LIMIT", "Job store capacity reached.");
  }
  receiptScope(record: StoredJob): string {
    return JSON.stringify([
      "job-v1",
      record.job.projectId,
      record.job.actorId,
      record.job.operation,
      record.requestId,
    ]);
  }
  private legacyScope(record: StoredJob): string {
    return JSON.stringify([
      record.job.projectId,
      record.job.actorId,
      "write",
      record.requestId,
    ]);
  }
  assertLegacyAvailable(context: OperationContext): void {
    if (context.jobId && this.tracked(context.jobId))
      throw new StorageError(
        "CONFLICT",
        "Tracked jobs must use the fenced job commit path.",
      );
    const scope = JSON.stringify([
      "job-v1",
      context.projectId,
      context.authorization.actorId,
      "write",
      context.requestId,
    ]);
    if (this.host.db.prepare("SELECT 1 FROM jobs WHERE scope=?").get(scope))
      throw new StorageError(
        "CONFLICT",
        "Logical write key is already bound to a tracked job.",
      );
  }
  receiptConsistent(record: StoredJob, receipt: CommitReceipt): boolean {
    return (
      record.job.status === "completed" &&
      record.job.projectId === receipt.projectId &&
      record.job.id === receipt.jobId &&
      record.job.actorId === receipt.idempotency.actorId &&
      record.job.operation === receipt.idempotency.operation &&
      record.requestId === receipt.idempotency.key &&
      record.job.projectId === receipt.idempotency.projectId &&
      record.finalOutputSha256 === receipt.idempotency.payloadSha256 &&
      this.host.digest(record.job.receipt) === this.host.digest(receipt)
    );
  }
  receipt(record: StoredJob): CommitReceipt | null {
    const row = this.host.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM receipts WHERE scope=?",
      )
      .get(this.receiptScope(record));
    if (!row) {
      if (record.job.status === "completed")
        throw new StorageError("INTEGRITY", "Completed job lacks its receipt.");
      return null;
    }
    const receipt = jobCheck("CommitReceipt", JSON.parse(row.data));
    if (!this.receiptConsistent(record, receipt))
      throw new StorageError(
        "INTEGRITY",
        "Receipt is not bound to its authoritative job.",
      );
    return receipt;
  }
  private async verifyReceipt(
    record: StoredJob,
    context: OperationContext,
  ): Promise<CommitReceipt | null> {
    const receipt = this.receipt(record);
    if (receipt)
      for (const artifact of receipt.outputs) {
        await this.host.guard(context, "read", "artifact", artifact.id);
        const exact = this.host.artifact(artifact);
        if (
          this.host.digest(exact) !== this.host.digest(artifact) ||
          !this.host.db
            .prepare(
              "SELECT 1 FROM artifact_refs WHERE owner_kind='job' AND owner_id=? AND artifact_id=?",
            )
            .get(receipt.id, artifact.id)
        )
          throw new StorageError(
            "INTEGRITY",
            "Job receipt output lacks protected exact metadata.",
          );
        await this.host.read(artifact, context);
      }
    return receipt;
  }
  private async authorizeInput(record: StoredJob, context: OperationContext) {
    for (const ref of this.inputRefs(record))
      await this.host.guard(context, "read", "artifact", ref.id);
    if (record.inputRevision)
      await this.host.guard(
        context,
        "read",
        "revision",
        record.inputRevision.id,
      );
  }
  inputRefs(record: StoredJob): ArtifactReference[] {
    return [
      record.job.input,
      {
        id: record.job.resources.snapshotId,
        sha256: record.job.resources.sha256,
      },
    ];
  }
  create(
    input: JobSubmission,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.snapshot(input, context, "write", (input) =>
      this.host.run(context, "write", async (context) => {
        fields(
          input,
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
        await this.authorize(input.id, context, "write");
        const config = this.enabled();
        if (context.clock !== config.clock)
          throw new StorageError(
            "AUTHORIZATION_CHANGED",
            "Submission requires the trusted shared clock.",
          );
        for (const id of [
          input.handlerId,
          input.handlerVersion,
          input.authorityRef,
        ])
          jobCheck("StableId", id);
        jobCheck("ArtifactReference", input.input);
        jobCheck("ResourceLock", input.resources);
        jobCheck("Budget", input.budget);
        jobCheck("Timestamp", input.deadline);
        jobCheck("Operation", input.operation);
        const keys = resourceKeys(input.resourceKeys);
        for (const key of Object.keys(
          config.limits,
        ) as (keyof typeof config.limits)[])
          if (
            input.budget[key] > config.limits[key] ||
            input.budget[key] > context.budget[key]
          )
            throw new StorageError(
              "LIMIT",
              "Job budget exceeds trusted submission limits.",
            );
        if (context.jobId !== input.id)
          throw new StorageError(
            "CONFLICT",
            "Submission context must bind its job.",
          );
        const now = this.now();
        const digest = this.host.digest({ ...input, resourceKeys: keys });
        const record: StoredJob = {
          submission: { ...input, resourceKeys: keys },
          job: {
            schemaVersion: "1.0",
            id: input.id,
            projectId: context.projectId,
            actorId: context.authorization.actorId,
            operation: input.operation,
            status: "queued",
            input: input.input,
            resources: input.resources,
            idempotency: {
              key: context.requestId,
              projectId: context.projectId,
              actorId: context.authorization.actorId,
              operation: input.operation,
              payloadSha256: digest,
            },
            attempt: 0,
            deadline: new Date(
              Math.min(
                Date.parse(input.deadline),
                now + input.budget.maxDurationMs,
              ),
            ).toISOString(),
            budget: input.budget,
            progress: 0,
            diagnosticIds: [],
          },
          requestId: context.requestId,
          handlerId: input.handlerId,
          handlerVersion: input.handlerVersion,
          authorityRef: input.authorityRef,
          ...(input.inputRevision
            ? { inputRevision: input.inputRevision }
            : {}),
          resourceKeys: keys,
          resources: [],
          rowVersion: 1,
          generation: 0,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          progressSequence: 0,
          lastProgressAt: null,
          usage: zeroUsage(),
          effects: [],
        };
        storedJob(record);
        await this.authorizeInput(record, context);
        if (input.inputRevision)
          await this.host.verifyInputRevision(input.inputRevision, context);
        const priorRow = this.host.db
          .prepare<[string], { id: string }>(
            "SELECT id FROM jobs WHERE scope=?",
          )
          .get(this.receiptScope(record));
        if (priorRow) {
          await this.authorize(priorRow.id, context, "read");
          const prior = this.load(priorRow.id);
          if (
            prior.job.id !== input.id ||
            prior.job.idempotency.payloadSha256 !== digest
          )
            throw new StorageError(
              "CONFLICT",
              "Job idempotency key is bound to a different submission.",
            );
          await this.verifyReceipt(prior, context);
          return prior;
        }
        if (
          record.job.operation === "write" &&
          this.host.db
            .prepare("SELECT 1 FROM receipts WHERE scope=?")
            .get(this.legacyScope(record))
        )
          throw new StorageError(
            "CONFLICT",
            "Logical write key already has a legacy receipt.",
          );
        if (
          this.host.db
            .prepare(
              "SELECT 1 FROM receipts WHERE json_extract(data,'$.jobId')=? LIMIT 1",
            )
            .get(record.job.id)
        )
          throw new StorageError(
            "CONFLICT",
            "Historical receipt job identities cannot be appropriated.",
          );
        if (now >= Date.parse(record.job.deadline))
          throw new StorageError(
            "DEADLINE",
            "Job submission deadline expired.",
          );
        for (const reference of this.inputRefs(record)) {
          const artifact = this.host.artifact(reference);
          if (!this.host.hasCommittedPublication(artifact))
            throw new StorageError(
              "INTEGRITY",
              "Job input requires trusted committed publication evidence.",
            );
          await this.host.read(artifact, context);
        }
        return this.transaction(
          context,
          () => {
            this.count("jobs", JOB_LIMITS.jobs);
            this.host.db
              .prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)")
              .run(
                record.job.id,
                this.receiptScope(record),
                "queued",
                record.createdAt,
                null,
                JSON.stringify(record),
              );
            this.host.refs("job-input", record.job.id, this.inputRefs(record));
            return record;
          },
          () => {
            if (this.now() >= Date.parse(record.job.deadline))
              throw new StorageError(
                "DEADLINE",
                "Submission deadline expired before transaction completion.",
              );
          },
        );
      }),
    );
  }
  get(id: string, context: OperationContext): Promise<Outcome<StoredJob>> {
    return this.host.run(context, "read", async (context) => {
      await this.authorize(id, context, "read");
      const record = this.load(id);
      await this.authorizeInput(record, context);
      await this.verifyReceipt(record, context);
      return record;
    });
  }
  getJobReceipt(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt | null>> {
    return this.host.run(context, "read", async (context) => {
      await this.authorize(id, context, "read");
      return this.verifyReceipt(this.load(id), context);
    });
  }
  scan(query: JobScan, context: OperationContext): Promise<Outcome<JobPage>> {
    return this.host.snapshot(query, context, "read", (query) =>
      this.host.run(context, "read", async (context) => {
        this.enabled();
        fields(query, ["states", "limit"], ["cursor", "dueBefore"]);
        integer(query.limit, 1, JOB_LIMITS.scan);
        const states = bounded(query.states, 9).map((state) =>
          jobCheck("JobStatus", state),
        );
        if (!states.length)
          throw new StorageError("INVALID_INPUT", "Scan requires states.");
        if (query.cursor) {
          fields(query.cursor, ["createdAt", "id"]);
          jobCheck("Timestamp", query.cursor.createdAt);
          jobCheck("StableId", query.cursor.id);
        }
        if (query.dueBefore) jobCheck("Timestamp", query.dueBefore);
        // Restrict candidates to explicit grants before selecting or parsing private metadata.
        const allowed = context.authorization.grants
          .filter(
            (g) => g.resourceKind === "job" && g.operations.includes("read"),
          )
          .map((g) => g.resourceId);
        if (allowed.length > JOB_LIMITS.jobs)
          throw new StorageError("LIMIT", "Too many scan grants.");
        for (const id of allowed) await this.authorize(id, context, "read");
        if (!allowed.length)
          throw new StorageError(
            "AUTHORIZATION_CHANGED",
            "Job scan requires explicit read grants.",
          );
        const rows = this.host.db
          .prepare<unknown[], { id: string }>(`
        SELECT id FROM jobs WHERE id IN (SELECT value FROM json_each(?))
          AND state IN (SELECT value FROM json_each(?))
          AND (created > ? OR (created = ? AND id > ?))
          AND (? IS NULL OR due IS NULL OR due <= ?)
        ORDER BY created,id LIMIT ?
      `)
          .all(
            JSON.stringify(allowed),
            JSON.stringify(states),
            databaseTimestamp(query.cursor?.createdAt) ?? "",
            databaseTimestamp(query.cursor?.createdAt) ?? "",
            query.cursor?.id ?? "",
            databaseTimestamp(query.dueBefore),
            databaseTimestamp(query.dueBefore),
            query.limit + 1,
          );
        const more = rows.length > query.limit;
        const records = rows
          .slice(0, query.limit)
          .map((row) => this.load(row.id));
        for (const record of records) {
          await this.authorizeInput(record, context);
          await this.verifyReceipt(record, context);
        }
        const last = records.at(-1);
        return {
          records,
          nextCursor:
            more && last
              ? { createdAt: last.createdAt, id: last.job.id }
              : null,
        };
      }),
    );
  }
  claim(
    id: string,
    expected: JobExpected,
    ownerId: string,
    durationMs: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.snapshot(
      { id, expected, ownerId, durationMs },
      context,
      "write",
      (input) =>
        this.host.run(context, "write", async (context) => {
          await this.authorize(input.id, context, "write");
          await this.authorizeInput(this.load(input.id), context);
          jobCheck("StableId", input.ownerId);
          integer(input.durationMs, 1, 30000);
          return this.transaction(
            context,
            () => {
              const record = this.load(input.id);
              this.identity(record, context);
              this.expect(record, input.expected);
              if (
                this.receipt(record) ||
                !["queued", "retry-wait"].includes(record.job.status) ||
                (record.job.nextEligibleAttempt &&
                  this.now() < Date.parse(record.job.nextEligibleAttempt))
              )
                throw new StorageError(
                  "CONFLICT",
                  "Job is not eligible for claim.",
                );
              if (
                record.effects.some(
                  (e) => e.state === "reserved" || e.state === "unknown",
                )
              )
                throw new StorageError(
                  "CONFLICT",
                  "Unresolved effects prohibit a claim.",
                );
              if (this.now() >= Date.parse(record.job.deadline))
                throw new StorageError("DEADLINE", "Job deadline expired.");
              if (record.job.attempt >= record.job.budget.maxAttempts)
                throw new StorageError("LIMIT", "Job attempts exhausted.");
              const active = this.host.db
                .prepare<[], { count: number }>(
                  `SELECT count(*) AS count FROM jobs
                   WHERE state IN ('running','cancel-requested')
                     OR (json_type(data,'$.job.lease') IS NOT NULL
                       AND coalesce(json_type(data,'$.restoredLease'),'') <> 'true')`,
                )
                .get();
              if (!active || active.count >= this.enabled().maxWorkers)
                throw new StorageError(
                  "CONFLICT",
                  "Trusted worker ceiling reached.",
                );
              const generation = increment(record.generation);
              const leaseId = `lease-${randomUUID()}`;
              const resources = record.resourceKeys.map((key) => {
                const prior = this.resource(key);
                if (prior && prior.state !== "released")
                  throw new StorageError(
                    "CONFLICT",
                    "Resource is held or quarantined.",
                  );
                return { key, generation: increment(prior?.generation ?? 0) };
              });
              const expiresAt = Math.min(
                this.now() + input.durationMs,
                Date.parse(record.job.deadline),
                Date.parse(context.deadline),
                Date.parse(context.authorization.expiresAt),
              );
              if (expiresAt <= this.now())
                throw new StorageError(
                  "DEADLINE",
                  "Execution authority expired.",
                );
              record.generation = generation;
              record.resources = resources;
              record.job.status = "running";
              record.job.attempt = increment(record.job.attempt);
              delete record.restoredLease;
              record.job.lease = {
                id: leaseId,
                ownerId: input.ownerId,
                resourceId: input.id,
                fencingToken: generation,
                heartbeatAt: this.timestamp(),
                expiresAt: new Date(expiresAt).toISOString(),
              };
              delete record.job.error;
              delete record.job.nextEligibleAttempt;
              for (const resource of resources) {
                if (!this.resource(resource.key))
                  this.count("job_resources", JOB_LIMITS.resources);
                this.saveResource({
                  ...resource,
                  state: "held",
                  jobId: input.id,
                  leaseId,
                  fencingToken: generation,
                });
              }
              this.bump(record);
              this.save(record);
              return record;
            },
            () => {
              const record = this.load(input.id);
              if (
                !record.job.lease ||
                this.now() >= Date.parse(record.job.lease.expiresAt)
              )
                throw new StorageError(
                  "CONFLICT",
                  "Claim expired before transaction completion.",
                );
            },
          );
        }),
    );
  }
  heartbeat(
    id: string,
    expected: JobWorkerExpected,
    extensionMs: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.snapshot(
      { id, expected, extensionMs },
      context,
      "write",
      (input) =>
        this.host.run(context, "write", async (context) => {
          await this.authorize(input.id, context, "write");
          integer(input.extensionMs, 1, 30000);
          return this.workerTransaction(
            input.id,
            input.expected,
            context,
            (record) => {
              const lease = record.job.lease;
              if (!lease) throw new StorageError("CONFLICT", "Missing lease.");
              lease.heartbeatAt = this.timestamp();
              lease.expiresAt = new Date(
                Math.min(
                  Math.max(
                    Date.parse(lease.expiresAt),
                    this.now() + input.extensionMs,
                  ),
                  Date.parse(record.job.deadline),
                  Date.parse(context.deadline),
                  Date.parse(context.authorization.expiresAt),
                ),
              ).toISOString();
              this.bump(record);
              this.save(record);
              return record;
            },
          );
        }),
    );
  }
  private unresolved(record: StoredJob): boolean {
    return record.effects.some(
      (e) => e.state === "reserved" || e.state === "unknown",
    );
  }
  private release(record: StoredJob, quarantine: boolean) {
    for (const reservation of record.resources) {
      const resource = this.resource(reservation.key);
      if (
        !resource ||
        resource.jobId !== record.job.id ||
        resource.generation !== reservation.generation
      )
        throw new StorageError(
          "CONFLICT",
          "Cannot release another resource generation.",
        );
      this.saveResource(
        quarantine
          ? { ...resource, state: "quarantined" }
          : {
              ...resource,
              state: "released",
              jobId: null,
              leaseId: null,
              fencingToken: null,
            },
      );
    }
    if (!quarantine) {
      record.resources = [];
      delete record.job.lease;
      delete record.restoredLease;
    }
  }
  private reserve(record: StoredJob, id: string, amount: JobUsage) {
    jobCheck("StableId", id);
    usage(amount);
    if (record.effects.some((e) => e.id === id))
      throw new StorageError("CONFLICT", "Effect identity is immutable.");
    if (record.effects.length >= JOB_LIMITS.effects)
      throw new StorageError("LIMIT", "Effect journal capacity reached.");
    for (const key of Object.keys(usageLimits) as (keyof JobUsage)[]) {
      const total = increment(record.usage[key], amount[key]);
      if (total > record.job.budget[usageLimits[key]])
        throw new StorageError("LIMIT", "Cumulative job budget exceeded.");
      record.usage[key] = total;
    }
    record.effects.push({ id, reserved: amount, state: "reserved" });
  }
  private settle(
    record: StoredJob,
    id: string,
    result: "settled" | "no-effect" | "unknown",
    actual?: JobUsage,
  ) {
    const effect = record.effects.find((e) => e.id === id);
    if (!effect || (effect.state !== "reserved" && effect.state !== "unknown"))
      throw new StorageError("CONFLICT", "Effect cannot be settled again.");
    if (result === "settled") {
      if (!actual)
        throw new StorageError("INVALID_INPUT", "Settled usage is required.");
      usage(actual);
      for (const key of Object.keys(usageLimits) as (keyof JobUsage)[])
        if (actual[key] > effect.reserved[key])
          throw new StorageError(
            "LIMIT",
            "Usage exceeds its prior reservation.",
          );
      effect.actual = actual;
    }
    // Reservations are cumulative across retries, even for confirmed no-effect work.
    effect.state = result;
  }
  update(
    id: string,
    expected: JobWorkerExpected,
    command: JobCommand,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.snapshot(
      { id, expected, command },
      context,
      "write",
      (input) =>
        this.host.run(context, "write", async (context) => {
          await this.authorize(input.id, context, "write");
          return this.workerTransaction(
            input.id,
            input.expected,
            context,
            (record) => {
              const command = input.command;
              if (
                record.job.status === "cancel-requested" &&
                !["acknowledge-cancel", "interrupt", "settle-usage"].includes(
                  command.kind,
                )
              )
                throw new StorageError(
                  "CONFLICT",
                  "Cancellation permits only safe stop/effect acknowledgment.",
                );
              switch (command.kind) {
                case "progress":
                  fields(command, ["kind", "sequence", "progress"]);
                  integer(command.sequence, 1, JOB_LIMITS.progress);
                  if (
                    command.sequence <= record.progressSequence ||
                    !Number.isFinite(command.progress) ||
                    command.progress < record.job.progress ||
                    command.progress >= 1 ||
                    (record.lastProgressAt !== null &&
                      this.now() - Date.parse(record.lastProgressAt) <
                        JOB_LIMITS.progressIntervalMs)
                  )
                    throw new StorageError(
                      "LIMIT",
                      "Progress must be monotonic, bounded and coalesced.",
                    );
                  record.progressSequence = command.sequence;
                  record.job.progress = command.progress;
                  record.lastProgressAt = this.timestamp();
                  break;
                case "reserve-usage":
                  fields(command, ["kind", "id", "usage"]);
                  this.reserve(record, command.id, command.usage);
                  break;
                case "settle-usage":
                  fields(command, ["kind", "id", "result"], ["actual"]);
                  if (
                    !["settled", "no-effect", "unknown"].includes(
                      command.result,
                    )
                  )
                    throw new StorageError(
                      "INVALID_INPUT",
                      "Invalid effect result.",
                    );
                  this.settle(
                    record,
                    command.id,
                    command.result,
                    command.result === "settled" ? command.actual : undefined,
                  );
                  break;
                case "wait":
                case "retry":
                case "fail":
                case "interrupt":
                case "acknowledge-cancel": {
                  fields(
                    command,
                    command.kind === "acknowledge-cancel"
                      ? ["kind"]
                      : command.kind === "retry"
                        ? ["kind", "error", "nextEligibleAttempt"]
                        : ["kind", "error"],
                  );
                  if (command.kind !== "acknowledge-cancel")
                    jobCheck("ContractError", command.error);
                  if (command.kind !== "interrupt" && this.unresolved(record))
                    throw new StorageError(
                      "CONFLICT",
                      "Unresolved effects must remain quarantined.",
                    );
                  if (
                    command.kind === "acknowledge-cancel" &&
                    record.job.status !== "cancel-requested"
                  )
                    throw new StorageError(
                      "CONFLICT",
                      "Cancellation has not been requested.",
                    );
                  if (command.kind === "retry") {
                    jobCheck("Timestamp", command.nextEligibleAttempt);
                    if (
                      !command.error.retryable ||
                      Date.parse(command.nextEligibleAttempt) < this.now() ||
                      Date.parse(command.nextEligibleAttempt) >=
                        Date.parse(record.job.deadline) ||
                      record.job.attempt >= record.job.budget.maxAttempts ||
                      [
                        "FORBIDDEN",
                        "AUTH_REQUIRED",
                        "INVALID_INPUT",
                        "SCHEMA_INVALID",
                      ].includes(command.error.code)
                    )
                      throw new StorageError(
                        "CONFLICT",
                        "Retry is not eligible.",
                      );
                    record.job.nextEligibleAttempt =
                      command.nextEligibleAttempt;
                  } else delete record.job.nextEligibleAttempt;
                  record.job.status =
                    command.kind === "wait"
                      ? "waiting-for-user"
                      : command.kind === "retry"
                        ? "retry-wait"
                        : command.kind === "fail"
                          ? "failed"
                          : command.kind === "interrupt"
                            ? "interrupted"
                            : "cancelled";
                  if (command.kind !== "acknowledge-cancel")
                    record.job.error = command.error;
                  this.release(record, command.kind === "interrupt");
                  break;
                }
                default:
                  throw new StorageError(
                    "INVALID_INPUT",
                    "Unknown job command.",
                  );
              }
              this.bump(record);
              this.save(record);
              return record;
            },
          );
        }),
    );
  }
  requestCancel(
    id: string,
    expectedVersion: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.run(context, "write", async (context) => {
      await this.authorize(id, context, "write");
      const initial = this.load(id);
      if (await this.verifyReceipt(initial, context)) return initial;
      return this.transaction(context, () => {
        const record = this.load(id);
        if (!this.cancelState(record, expectedVersion)) return record;
        this.bump(record);
        this.save(record);
        return record;
      });
    });
  }
  private cancelState(record: StoredJob, expectedVersion: number): boolean {
    if (record.rowVersion !== integer(expectedVersion, 1))
      throw new StorageError("CONFLICT", "Cancellation version changed.");
    if (
      terminal.has(record.job.status) ||
      record.job.status === "cancel-requested"
    )
      return false;
    if (
      record.job.status === "interrupted" ||
      (record.job.status !== "running" && this.unresolved(record))
    )
      throw new StorageError(
        "CONFLICT",
        "Cancellation needs trusted effect reconciliation.",
      );
    if (record.job.status === "running") record.job.status = "cancel-requested";
    else {
      record.job.status = "cancelled";
      this.release(record, false);
      delete record.job.nextEligibleAttempt;
    }
    return true;
  }
  private controlStats(): { count: number; bytes: number } {
    const size = this.host.db
      .prepare<[], { rows: number; bytes: number }>(`
      SELECT count(*) AS rows,coalesce(sum(length(cast(data AS BLOB))),0) AS bytes FROM jobs
    `)
      .get();
    if (
      !size ||
      size.rows > JOB_LIMITS.jobs ||
      size.bytes > JOB_LIMITS.metadataBytes
    )
      throw new StorageError(
        "LIMIT",
        "Cancellation lookup exceeds bounded metadata profile.",
      );
    const controls = this.host.db
      .prepare<[], { count: number }>(`
      SELECT coalesce(sum(json_array_length(data,'$.cancelControls')),0) AS count FROM jobs
    `)
      .get();
    if (!controls || controls.count > JOB_LIMITS.totalCancelControls)
      throw new StorageError(
        "LIMIT",
        "Cancellation lookup exceeds bounded control profile.",
      );
    return { count: controls.count, bytes: size.bytes };
  }
  cancelWithReceipt(
    id: string,
    expectedVersion: number,
    context: OperationContext,
  ): Promise<Outcome<JobCancelResult>> {
    return this.host.snapshot(
      { id, expectedVersion },
      context,
      "write",
      (input) =>
        this.host.run(context, "write", async (context) => {
          await this.authorize(input.id, context, "write");
          integer(input.expectedVersion, 1);
          this.controlStats();
          const identity = {
            projectId: context.projectId,
            actorId: context.authorization.actorId,
            key: context.requestId,
          };
          const payloadSha256 = this.host.digest({
            jobId: input.id,
            expectedVersion: input.expectedVersion,
          });
          const priorRows = this.host.db
            .prepare<[string, string, string], { id: string }>(`
          SELECT jobs.id FROM jobs, json_each(jobs.data,'$.cancelControls') AS control
          WHERE json_extract(control.value,'$.projectId')=?
            AND json_extract(control.value,'$.actorId')=?
            AND json_extract(control.value,'$.key')=?
            AND json_extract(control.value,'$.operation')='job-cancel'
          LIMIT 2
        `)
            .all(identity.projectId, identity.actorId, identity.key);
          if (priorRows.length > 1)
            throw new StorageError(
              "INTEGRITY",
              "Duplicate cancellation-control scope.",
            );
          const priorRow = priorRows[0];
          if (priorRow) {
            // The incoming target is authorized; changed-target conflicts reveal no old job metadata.
            if (priorRow.id !== input.id)
              throw new StorageError(
                "CONFLICT",
                "Cancellation-control key targets a different job.",
              );
            const record = this.load(input.id);
            await this.authorizeInput(record, context);
            const control = record.cancelControls?.find(
              (item) =>
                cancelControlScope(item) === cancelControlScope(identity),
            );
            if (!control)
              throw new StorageError(
                "INTEGRITY",
                "Missing cancellation-control receipt.",
              );
            if (
              control.payloadSha256 !== payloadSha256 ||
              control.expectedVersion !== input.expectedVersion
            )
              throw new StorageError(
                "CONFLICT",
                "Cancellation-control key has a different precondition.",
              );
            await this.verifyReceipt(record, context);
            return { record, control };
          }
          const initial = this.load(input.id);
          await this.authorizeInput(initial, context);
          const committed = await this.verifyReceipt(initial, context);
          const result = this.transaction(context, () => {
            const record = this.load(input.id);
            const oldBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
            const stats = this.controlStats();
            if (
              stats.count >= JOB_LIMITS.totalCancelControls ||
              (record.cancelControls?.length ?? 0) >= JOB_LIMITS.cancelControls
            )
              throw new StorageError(
                "LIMIT",
                "Cancellation-control capacity reached.",
              );
            if (!committed) this.cancelState(record, input.expectedVersion);
            this.bump(record);
            this.save(record);
            this.host.options.fault?.("job-cancel-after-state");
            const control: JobCancelReceipt = {
              version: 1,
              operation: "job-cancel",
              ...identity,
              jobId: input.id,
              expectedVersion: input.expectedVersion,
              payloadSha256,
              resultVersion: record.rowVersion,
              resultStatus: record.job.status,
              recordedAt: this.timestamp(),
            };
            record.cancelControls = [...(record.cancelControls ?? []), control];
            if (
              stats.bytes -
                oldBytes +
                Buffer.byteLength(JSON.stringify(record), "utf8") >
              JOB_LIMITS.metadataBytes
            )
              throw new StorageError(
                "LIMIT",
                "Cancellation-control metadata capacity reached.",
              );
            this.save(record);
            this.host.options.fault?.("job-cancel-after-control");
            return { record, control };
          });
          try {
            this.host.options.fault?.("after-commit");
          } catch {
            return result;
          }
          return result;
        }),
    );
  }
  validateControlGraph(records: StoredJob[]): void {
    const scopes = new Set<string>();
    for (const record of records) {
      storedJob(record);
      this.validateBinding(record);
      for (const control of record.cancelControls ?? []) {
        const scope = cancelControlScope(control);
        if (scopes.has(scope))
          throw new StorageError(
            "INTEGRITY",
            "Duplicate cancellation-control scope.",
          );
        scopes.add(scope);
      }
    }
    if (scopes.size > JOB_LIMITS.totalCancelControls)
      throw new StorageError(
        "LIMIT",
        "Backup cancellation controls exceed bounded profile.",
      );
  }
  stages(id: string): StoredJobStage[] {
    const rows = this.host.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM job_stages WHERE job=? ORDER BY id LIMIT 129",
      )
      .all(id);
    if (rows.length > JOB_LIMITS.stages)
      throw new StorageError(
        "LIMIT",
        "Job stage journal exceeds bounded profile.",
      );
    return rows.map((r) => storedStage(JSON.parse(r.data)));
  }
  getStages(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<StoredJobStage[]>> {
    return this.host.run(context, "read", async (context) => {
      await this.authorize(id, context, "read");
      this.load(id);
      return this.stages(id);
    });
  }
  private saveStage(stage: StoredJobStage) {
    storedStage(stage);
    this.host.db
      .prepare(
        "INSERT INTO job_stages VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(stage.stagingId, stage.jobId, JSON.stringify(stage));
  }
  stage(
    id: string,
    expected: JobWorkerExpected,
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<JobStageResult>> {
    const owned =
      bytes.length <= context.budget.maxInputBytes &&
      bytes.length <= context.budget.maxOutputBytes
        ? Uint8Array.from(bytes)
        : null;
    return this.host.snapshot({ id, expected }, context, "write", (input) =>
      this.host.run(context, "write", async (context) => {
        await this.authorize(input.id, context, "write");
        let record = this.live(input.id, input.expected, context, true);
        if (
          !owned ||
          owned.length > record.job.budget.maxOutputBytes ||
          this.stages(input.id).length >= JOB_LIMITS.stages
        )
          throw new StorageError("LIMIT", "Job staging capacity exceeded.");
        if (
          increment(record.usage.outputBytes, owned.length) >
          record.job.budget.maxOutputBytes
        )
          throw new StorageError(
            "LIMIT",
            "Cumulative staging byte budget exceeded.",
          );
        if (
          increment(record.usage.inputBytes, owned.length) >
          record.job.budget.maxInputBytes
        )
          throw new StorageError(
            "LIMIT",
            "Cumulative staging input budget exceeded.",
          );
        this.count("job_stages", JOB_LIMITS.jobs);
        record = this.workerTransaction(
          input.id,
          input.expected,
          context,
          (current) => {
            current.usage.inputBytes = increment(
              current.usage.inputBytes,
              owned.length,
            );
            current.usage.outputBytes = increment(
              current.usage.outputBytes,
              owned.length,
            );
            this.bump(current);
            this.save(current);
            return current;
          },
          true,
        );
        const journalExpected = {
          ...input.expected,
          rowVersion: record.rowVersion,
        };
        const staged = await this.host.stage(owned, context);
        this.host.options.fault?.("job-after-stage");
        const stage: StoredJobStage = {
          stagingId: staged.stagingId,
          staged,
          artifactRootId: this.host.options.artifactRootId,
          jobId: record.job.id,
          requestId: record.requestId,
          attempt: record.job.attempt,
          fencingToken: record.generation,
          leaseId: input.expected.leaseId,
          hostInstanceId: this.hostInstanceId,
          disposition: "retained",
        };
        // Journal returned physical evidence even when cancellation/expiry occurred during host I/O.
        this.host.db.transaction(() => {
          this.saveStage(stage);
        })();
        try {
          record = this.live(input.id, journalExpected, context, true);
        } catch (cause) {
          stage.disposition = "recovery-needed";
          this.saveStage(stage);
          throw cause;
        }
        return this.workerTransaction(
          input.id,
          journalExpected,
          context,
          (record) => {
            this.bump(record);
            this.save(record);
            return { record, staged };
          },
          true,
        );
      }),
    );
  }
  commitJob(
    id: string,
    expected: JobWorkerExpected,
    completion: JobCompletion,
    context: OperationContext,
  ): Promise<Outcome<JobCommitResult>> {
    return this.host.snapshot(
      { id, expected, completion },
      context,
      "write",
      async (input) => {
        let record: StoredJob | undefined;
        const required = () => {
          if (!record)
            throw new StorageError("INTEGRITY", "Job commit was not prepared.");
          return record;
        };
        const hooks: JobCommitHooks = {
          payload: input.completion,
          prepare: async (ctx) => {
            await this.authorize(input.id, ctx, "write");
            record = this.load(input.id);
            this.identity(record, ctx);
            await this.authorizeInput(record, ctx);
            fields(
              input.completion,
              ["outputs", "outputState", "diagnosticIds"],
              ["revision", "comparisonVerdict", "sourceStatus"],
            );
            bounded(input.completion.outputs, JOB_LIMITS.stages);
            for (const id of bounded(
              input.completion.diagnosticIds,
              JOB_LIMITS.stages,
            ))
              jobCheck("StableId", id);
            if (
              !["complete", "partial-inspection"].includes(
                input.completion.outputState,
              )
            )
              throw new StorageError(
                "INVALID_INPUT",
                "Invalid job output state.",
              );
            if (await this.verifyReceipt(record, ctx)) return;
            record = this.live(input.id, input.expected, ctx, true);
            if (this.unresolved(record))
              throw new StorageError(
                "CONFLICT",
                "Unresolved effects prohibit completion.",
              );
            const stages = this.stages(input.id);
            for (const output of input.completion.outputs) {
              await this.host.guard(
                ctx,
                "write",
                "artifact",
                output.artifact.id,
              );
              const stage = stages.find(
                (stage) => stage.stagingId === output.stagingId,
              );
              if (
                stage?.disposition !== "retained" ||
                stage.hostInstanceId !== this.hostInstanceId ||
                stage.fencingToken !== record.generation ||
                stage.leaseId !== input.expected.leaseId ||
                this.host.digest(stage.staged) !== this.host.digest(output)
              )
                throw new StorageError(
                  "CONFLICT",
                  "Output lacks current owned job staging evidence.",
                );
            }
          },
          scope: () => this.receiptScope(required()),
          operation: () => required().job.operation,
          actorId: () => required().job.actorId,
          verify: async (evidence, ctx) =>
            this.enabled().verifyCompletion(
              structuredClone(required()),
              structuredClone(input.completion),
              evidence,
              ctx,
            ),
          check: (ctx) => {
            this.live(input.id, input.expected, ctx, true);
          },
          finish: (receipt, ctx) => {
            record = this.live(input.id, input.expected, ctx, true);
            const leaseDeadline = record.job.lease?.expiresAt;
            record.job.status = "completed";
            record.job.progress = 1;
            record.job.receipt = receipt;
            record.job.outputState = input.completion.outputState;
            record.job.diagnosticIds = input.completion.diagnosticIds;
            if (input.completion.comparisonVerdict !== undefined)
              record.job.comparisonVerdict = input.completion.comparisonVerdict;
            if (input.completion.sourceStatus !== undefined)
              record.job.sourceStatus = input.completion.sourceStatus;
            delete record.job.error;
            delete record.job.nextEligibleAttempt;
            record.finalOutputSha256 = receipt.idempotency.payloadSha256;
            this.release(record, false);
            this.bump(record);
            this.save(record);
            this.host.options.fault?.("job-after-state");
            if (
              !leaseDeadline ||
              this.now() >= Date.parse(leaseDeadline) ||
              this.now() >= Date.parse(record.job.deadline)
            )
              throw new StorageError(
                "CONFLICT",
                "Job lease expired before transaction completion.",
              );
          },
        };
        const result = await this.host.commit(
          input.completion.outputs,
          context,
          input.completion.revision
            ? {
                ...input.completion.revision,
                outputs: input.completion.outputs,
              }
            : undefined,
          hooks,
        );
        if (result.status === "partial") {
          const { value: _value, missing: _missing, ...failure } = result;
          return { ...failure, status: "failed" };
        }
        if (result.status !== "complete") return result;
        return {
          ...result,
          value: { record: required(), receipt: result.value },
        };
      },
    );
  }
  reconcile(
    id: string,
    expectedVersion: number,
    evidence: JobReconciliation,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>> {
    return this.host.snapshot(
      { id, expectedVersion, evidence },
      context,
      "write",
      (input) =>
        this.host.run(context, "write", async (context) => {
          await this.authorize(input.id, context, "write");
          const initial = this.load(input.id);
          // Trusted callback authorizes recovery before revealing receipt/state decisions.
          await this.enabled().authorizeRecovery(
            structuredClone(initial),
            structuredClone(input.evidence),
            context,
          );
          const receipt = await this.verifyReceipt(initial, context);
          if (receipt && input.evidence.kind !== "abandon-stages")
            return initial;
          return this.transaction(context, () => {
            const record = this.load(input.id);
            if (record.rowVersion !== integer(input.expectedVersion, 1))
              throw new StorageError("CONFLICT", "Recovery version changed.");
            const evidence = input.evidence;
            if (evidence.kind === "abandon-stages") {
              fields(evidence, ["kind", "evidenceRef", "abandonedStageIds"]);
              jobCheck("StableId", evidence.evidenceRef);
              if (
                record.job.lease ||
                record.resources.length ||
                this.unresolved(record)
              )
                throw new StorageError(
                  "CONFLICT",
                  "Active or unresolved execution cannot abandon stages.",
                );
              const stages = this.stages(input.id);
              for (const id of bounded(
                evidence.abandonedStageIds,
                JOB_LIMITS.stages,
              )) {
                const stage = stages.find((stage) => stage.stagingId === id);
                if (!stage || stage.hostInstanceId !== this.hostInstanceId)
                  throw new StorageError(
                    "CONFLICT",
                    "Recovery lacks current host staging ownership.",
                  );
                stage.disposition = "authorized-abandoned";
                this.saveStage(stage);
              }
              this.bump(record);
              this.save(record);
              return record;
            }
            if (terminal.has(record.job.status))
              throw new StorageError(
                "CONFLICT",
                "Terminal job cannot be restarted.",
              );
            if (evidence.kind === "interrupt") {
              fields(evidence, ["kind", "error"]);
              jobCheck("ContractError", evidence.error);
              record.generation = increment(record.generation);
              record.job.status = "interrupted";
              record.job.error = evidence.error;
              delete record.job.nextEligibleAttempt;
              this.release(record, true);
              for (const stage of this.stages(input.id)) {
                if (stage.disposition !== "authorized-abandoned") {
                  stage.disposition = "recovery-needed";
                  this.saveStage(stage);
                }
              }
            } else if (evidence.kind === "resolved") {
              fields(
                evidence,
                [
                  "kind",
                  "decision",
                  "evidenceRef",
                  "stoppedLeaseId",
                  "effects",
                  "abandonedStageIds",
                ],
                ["error"],
              );
              jobCheck("StableId", evidence.evidenceRef);
              if (
                !["interrupted", "waiting-for-user", "queued"].includes(
                  record.job.status,
                ) ||
                evidence.stoppedLeaseId !== (record.job.lease?.id ?? null)
              )
                throw new StorageError(
                  "CONFLICT",
                  "Recovery must acknowledge the exact stopped execution.",
                );
              for (const effect of bounded(
                evidence.effects,
                JOB_LIMITS.effects,
              )) {
                const item = fields(effect, ["id", "result"], ["actual"]);
                const id = jobCheck("StableId", item.id);
                if (item.result !== "no-effect" && item.result !== "settled")
                  throw new StorageError(
                    "INVALID_INPUT",
                    "Invalid recovered effect.",
                  );
                this.settle(
                  record,
                  id,
                  item.result,
                  item.actual === undefined ? undefined : usage(item.actual),
                );
              }
              if (this.unresolved(record))
                throw new StorageError(
                  "CONFLICT",
                  "Recovery left unresolved effects.",
                );
              const stages = this.stages(input.id);
              for (const stageId of bounded(
                evidence.abandonedStageIds,
                JOB_LIMITS.stages,
              )) {
                const stage = stages.find(
                  (stage) => stage.stagingId === stageId,
                );
                if (!stage || stage.hostInstanceId !== this.hostInstanceId)
                  throw new StorageError(
                    "CONFLICT",
                    "Recovery cannot transplant host staging authority.",
                  );
                stage.disposition = "authorized-abandoned";
                this.saveStage(stage);
              }
              if (
                !["queued", "cancelled", "failed", "waiting-for-user"].includes(
                  evidence.decision,
                )
              )
                throw new StorageError(
                  "INVALID_INPUT",
                  "Invalid recovery decision.",
                );
              if (
                evidence.decision === "queued" &&
                (this.now() >= Date.parse(record.job.deadline) ||
                  record.job.attempt >= record.job.budget.maxAttempts)
              )
                throw new StorageError(
                  "CONFLICT",
                  "Recovered job is no longer retry eligible.",
                );
              if (
                evidence.decision === "failed" ||
                evidence.decision === "waiting-for-user"
              )
                record.job.error = jobCheck("ContractError", evidence.error);
              else delete record.job.error;
              record.generation = increment(record.generation);
              record.job.status = evidence.decision;
              this.release(record, false);
              delete record.job.nextEligibleAttempt;
            } else
              throw new StorageError(
                "INVALID_INPUT",
                "Unknown recovery evidence.",
              );
            this.bump(record);
            this.save(record);
            return record;
          });
        }),
    );
  }
  canDiscardStage(
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<boolean>> {
    return this.host.run(context, "read", async (context) => {
      jobCheck("StableId", stagingId);
      this.enabled();
      // A cleanup caller must name the job it is allowed to inspect before lookup.
      if (!context.jobId)
        throw new StorageError(
          "INVALID_INPUT",
          "Stage inspection requires job identity.",
        );
      await this.authorize(context.jobId, context, "read");
      return this.discardable(stagingId, context.jobId);
    });
  }
  discardable(stagingId: string, jobId?: string): boolean {
    const row = this.host.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM job_stages WHERE id=?",
      )
      .get(stagingId);
    if (!row) return false;
    const stage = storedStage(JSON.parse(row.data));
    if (
      jobId !== stage.jobId ||
      stage.hostInstanceId !== this.hostInstanceId ||
      stage.disposition !== "authorized-abandoned"
    )
      return false;
    const record = this.load(stage.jobId);
    return (
      !["running", "cancel-requested"].includes(record.job.status) &&
      !this.unresolved(record) &&
      record.resources.length === 0
    );
  }
  knownStage(stagingId: string): boolean {
    return !!this.host.db
      .prepare("SELECT 1 FROM job_stages WHERE id=?")
      .get(stagingId);
  }
  protectedStagePaths(): string[] {
    const rows = this.host.db
      .prepare<[], { data: string }>("SELECT data FROM job_stages LIMIT 20001")
      .all();
    bounded(rows, JOB_LIMITS.jobs);
    return rows.map(
      (row) => storedStage(JSON.parse(row.data)).staged.artifact.path,
    );
  }
  backup() {
    this.controlStats();
    const read = <T>(
      table: "jobs" | "job_resources" | "job_stages",
      parse: (value: unknown) => T,
    ): T[] => {
      const size = this.host.db
        .prepare<[], { count: number; bytes: number }>(
          `SELECT count(*) AS count,coalesce(sum(length(cast(data AS BLOB))),0) AS bytes FROM ${table}`,
        )
        .get();
      if (
        !size ||
        size.count > JOB_LIMITS.jobs ||
        size.bytes > JOB_LIMITS.metadataBytes
      )
        throw new StorageError("LIMIT", "Job backup exceeds bounded profile.");
      return this.host.db
        .prepare<[], { data: string }>(
          `SELECT data FROM ${table} ORDER BY rowid`,
        )
        .all()
        .map((row) => parse(JSON.parse(row.data)));
    };
    const jobs = read("jobs", storedJob);
    for (const record of jobs) {
      this.validateBinding(record);
      for (const reference of this.inputRefs(record))
        if (
          !this.host.db
            .prepare(
              "SELECT 1 FROM artifact_refs WHERE owner_kind='job-input' AND owner_id=? AND artifact_id=?",
            )
            .get(record.job.id, reference.id)
        )
          throw new StorageError(
            "INTEGRITY",
            "Job input lacks its protected reference.",
          );
      const receipt = this.receipt(record);
      if (receipt)
        for (const artifact of receipt.outputs)
          if (
            !this.host.db
              .prepare(
                "SELECT 1 FROM artifact_refs WHERE owner_kind='job' AND owner_id=? AND artifact_id=?",
              )
              .get(receipt.id, artifact.id)
          )
            throw new StorageError(
              "INTEGRITY",
              "Job receipt lacks its protected output reference.",
            );
    }
    return {
      jobs,
      jobResources: read("job_resources", storedResource),
      jobStages: read("job_stages", storedStage),
    };
  }
  restore(data: {
    jobs: StoredJob[];
    jobResources: StoredJobResource[];
    jobStages: StoredJobStage[];
  }) {
    for (const original of data.jobs) {
      const record = structuredClone(original);
      record.rowVersion = increment(record.rowVersion);
      record.generation = increment(record.generation);
      if (
        record.job.lease ||
        record.resources.length ||
        this.unresolved(record)
      ) {
        record.job.status = "interrupted";
        record.job.error = interruptedError;
        delete record.job.nextEligibleAttempt;
      }
      if (record.job.lease) record.restoredLease = true;
      this.host.db
        .prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)")
        .run(
          record.job.id,
          this.receiptScope(record),
          record.job.status,
          record.createdAt,
          databaseTimestamp(record.job.nextEligibleAttempt),
          JSON.stringify(storedJob(record)),
        );
      this.host.refs("job-input", record.job.id, this.inputRefs(record));
    }
    for (const original of data.jobResources) {
      const resource = structuredClone(original);
      resource.generation = increment(resource.generation);
      if (resource.state !== "released") resource.state = "quarantined";
      this.saveResource(resource);
      if (resource.jobId) {
        const record = this.load(resource.jobId);
        const reservation = record.resources.find(
          (item) => item.key === resource.key,
        );
        if (!reservation)
          throw new StorageError(
            "INTEGRITY",
            "Restored resource lacks its job.",
          );
        reservation.generation = resource.generation;
        this.save(record);
      }
    }
    for (const original of data.jobStages)
      this.saveStage({
        ...original,
        hostInstanceId: `historical-${randomUUID()}`,
        disposition: "recovery-needed",
      });
  }
}
