import {
  type Budget,
  type ContractError,
  type Job,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import {
  authorizeOperation,
  HostBoundaryError,
  snapshotOperationContext,
} from "@design-studio/host";
import {
  JOB_STORAGE_LIMITS,
  type JobReconciliation,
  type JobScan,
  type JobSubmission,
  type StoredJob,
} from "@design-studio/storage";
import {
  complete,
  detail,
  failure,
  integer,
  JobFailure,
  own,
  unwrap,
} from "./boundary.js";
import { Execution, fence } from "./execution.js";
import { assertTransition, retryDeadline, terminal } from "./state-machine.js";
import type {
  HandlerResult,
  JobServiceOptions,
  RecoveryFacts,
  RecoveryView,
  SchedulerReport,
  TrustedJobHandler,
  VersionedJob,
} from "./types.js";

interface Active {
  execution: Execution;
  controller: AbortController;
  stopped: boolean;
  leaseId: string;
  done: Promise<void>;
}
const safeError = (error: ContractError): ContractError => {
  if (!validateContract("ContractError", error).success)
    throw new HostBoundaryError("INVALID_INPUT", "Invalid handler error.");
  return detail(error.code, error.retryable);
};
const view = (record: StoredJob): VersionedJob => ({
  job: structuredClone(record.job),
  rowVersion: record.rowVersion,
});

export class JobService {
  private readonly handlers = new Map<string, TrustedJobHandler>();
  private readonly active = new Map<string, Active>();
  private readonly authorities = new Set<Promise<unknown>>();
  private readonly maxWorkers: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly backoffMs: number;
  private readonly authorityTimeoutMs: number;
  private turn: Promise<unknown> = Promise.resolve();
  private cursor: JobScan["cursor"];
  private scheduler: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private error: ContractError | null = null;
  private readonly options: JobServiceOptions;

  constructor(options: JobServiceOptions) {
    if (
      !options.executionAuthority?.verify ||
      !options.executionAuthority.observe ||
      !options.executionAuthority.issue ||
      !options.recoveryAuthority?.issue ||
      !options.recoveryAuthority.decide
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Trusted execution and recovery authorities are required.",
      );
    for (const id of [
      options.projectId,
      options.ownerId,
      options.artifactRootId,
    ])
      if (!validateContract("StableId", id).success)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid service identity.",
        );
    this.options = Object.freeze({
      ...options,
      executionAuthority: Object.freeze({
        verify: options.executionAuthority.verify.bind(
          options.executionAuthority,
        ),
        observe: options.executionAuthority.observe.bind(
          options.executionAuthority,
        ),
        issue: options.executionAuthority.issue.bind(
          options.executionAuthority,
        ),
      }),
      recoveryAuthority: Object.freeze({
        issue: options.recoveryAuthority.issue.bind(options.recoveryAuthority),
        decide: options.recoveryAuthority.decide.bind(
          options.recoveryAuthority,
        ),
      }),
    });
    this.maxWorkers = integer(options.maxWorkers ?? 1, 1, 4);
    this.leaseMs = integer(options.leaseMs ?? 5000, 2, 30000);
    this.heartbeatMs = integer(
      options.heartbeatMs ?? Math.floor(this.leaseMs / 3),
      1,
      this.leaseMs - 1,
    );
    this.pollMs = integer(options.pollMs ?? 100, 1, this.heartbeatMs);
    this.backoffMs = integer(options.backoffMs ?? 1000, 1, 30000);
    this.authorityTimeoutMs = integer(
      options.authorityTimeoutMs ?? 5000,
      1,
      30000,
    );
    for (const handler of options.handlers) {
      if (
        !validateContract("StableId", handler.id).success ||
        !validateContract("StableId", handler.version).success ||
        !validateContract("Operation", handler.operation).success ||
        typeof handler.run !== "function"
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid registered handler.",
        );
      const key = `${handler.id}\0${handler.version}`;
      if (this.handlers.has(key))
        throw new HostBoundaryError(
          "CONFLICT",
          "Duplicate registered handler.",
        );
      this.handlers.set(
        key,
        Object.freeze({
          id: handler.id,
          version: handler.version,
          operation: handler.operation,
          run: handler.run.bind(handler),
        }),
      );
    }
  }
  get lastError(): ContractError | null {
    return this.error ? { ...this.error, diagnosticIds: [] } : null;
  }
  private async bounded<T>(
    work: Promise<T>,
    duration: number,
    onTimeout: () => void,
  ): Promise<T> {
    const original = Promise.resolve(work);
    this.authorities.add(original);
    original.then(
      () => this.authorities.delete(original),
      () => this.authorities.delete(original),
    );
    const timer = new AbortController();
    const sleeping = this.options.clock.sleep(duration, timer.signal);
    const timeout = sleeping.then(() => {
      onTimeout();
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "Trusted authority did not finish within its allowance.",
      );
    });
    try {
      return await Promise.race([original, timeout]);
    } finally {
      timer.abort();
      await sleeping.catch((error: unknown) => {
        if (
          !(
            timer.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
        )
          throw error;
      });
    }
  }
  private context(
    context: OperationContext,
    jobId: string,
    operation: "read" | "write",
  ): OperationContext {
    const owned = snapshotOperationContext(context);
    if (
      owned.projectId !== this.options.projectId ||
      owned.clock !== this.options.clock
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Wrong project or trusted clock.",
      );
    authorizeOperation(
      owned,
      {
        projectId: this.options.projectId,
        resourceKind: "job",
        resourceId: jobId,
        operation,
      },
      this.options.executionAuthority.verify,
    );
    return owned;
  }
  private async boundary<T>(
    context: OperationContext,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    const identity = {
      projectId: context.projectId,
      requestId: context.requestId,
    };
    try {
      context = snapshotOperationContext(context);
      return complete(context, await operation(context));
    } catch (error) {
      return failure(identity, error);
    }
  }
  submit(
    input: JobSubmission,
    context: OperationContext,
  ): Promise<Outcome<Job>> {
    return this.boundary(context, async (context) => {
      const captured = own(input);
      context = this.context(context, captured.id, "write");
      const handler = this.handlers.get(
        `${captured.handlerId}\0${captured.handlerVersion}`,
      );
      if (!handler || handler.operation !== captured.operation)
        throw new HostBoundaryError(
          "ACTION_REQUIRED",
          "Registered handler/version is unavailable.",
        );
      return unwrap(await this.options.repository.create(captured, context))
        .job;
    });
  }
  get(id: string, context: OperationContext): Promise<Outcome<Job>> {
    return this.boundary(
      context,
      async (context) =>
        unwrap(
          await this.options.repository.get(
            id,
            this.context(context, id, "read"),
          ),
        ).job,
    );
  }
  getVersioned(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<VersionedJob>> {
    return this.boundary(context, async (context) =>
      view(
        unwrap(
          await this.options.repository.get(
            id,
            this.context(context, id, "read"),
          ),
        ),
      ),
    );
  }
  getRecoveryView(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<RecoveryView>> {
    return this.boundary(context, async (context) => {
      context = this.context(context, id, "read");
      const record = unwrap(await this.options.repository.get(id, context));
      const stages = unwrap(
        await this.options.repository.getStages(id, context),
      );
      return {
        ...view(record),
        stages: stages.map((entry) => structuredClone(entry.staged)),
        recoveryRequired:
          record.job.status === "interrupted" ||
          stages.some((entry) => entry.disposition === "recovery-needed"),
      };
    });
  }
  cancel(
    id: string,
    expectedVersion: number,
    context: OperationContext,
  ): Promise<Outcome<VersionedJob>> {
    return this.boundary(context, async (context) => {
      context = this.context(context, id, "write");
      integer(expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      const { record } = unwrap(
        await this.options.repository.cancelWithReceipt(
          id,
          expectedVersion,
          context,
        ),
      );
      if (record.job.status === "cancel-requested")
        this.active.get(id)?.controller.abort();
      return view(record);
    });
  }
  recover(
    id: string,
    expectedVersion: number,
    evidence: JobReconciliation,
    context: OperationContext,
  ): Promise<Outcome<VersionedJob>> {
    return this.boundary(context, async (context) => {
      evidence = own(evidence);
      context = this.context(context, id, "write");
      if (
        evidence.kind !== "interrupt" &&
        this.active.get(id)?.stopped === false
      )
        throw new HostBoundaryError("CONFLICT", "Callback has not stopped.");
      return view(
        unwrap(
          await this.options.repository.reconcile(
            id,
            expectedVersion,
            evidence,
            context,
          ),
        ),
      );
    });
  }
  resume(
    id: string,
    expectedVersion: number,
    evidence: Extract<JobReconciliation, { kind: "resolved" }>,
    context: OperationContext,
  ): Promise<Outcome<VersionedJob>> {
    if (evidence.decision !== "queued")
      return Promise.resolve(
        failure(
          context,
          new HostBoundaryError(
            "INVALID_INPUT",
            "Resume requires queued recovery.",
          ),
        ),
      );
    return this.recover(id, expectedVersion, evidence, context);
  }
  private async pause(
    context: OperationContext,
    task?: Promise<void>,
  ): Promise<void> {
    const timer = new AbortController();
    const cancel = () => timer.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) timer.abort();
    const sleeping = this.options.clock.sleep(
      Math.max(
        0,
        Math.min(
          this.pollMs,
          Date.parse(context.deadline) - this.options.clock.now(),
        ),
      ),
      timer.signal,
    );
    try {
      await (task ? Promise.race([task, sleeping]) : sleeping);
    } finally {
      timer.abort();
      context.signal.removeEventListener("abort", cancel);
      await sleeping.catch((error: unknown) => {
        if (
          !(
            timer.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
        )
          throw error;
      });
    }
  }
  wait(id: string, context: OperationContext): Promise<Outcome<Job>> {
    return this.boundary(context, async (context) => {
      context = this.context(context, id, "read");
      for (;;) {
        const record = unwrap(
          await this.options.repository.get(
            id,
            this.context(context, id, "read"),
          ),
        );
        if (
          terminal(record.job.status) ||
          record.job.status === "waiting-for-user" ||
          record.job.status === "interrupted"
        )
          return record.job;
        await this.pause(context, this.active.get(id)?.done);
      }
    });
  }
  waitForAttempt(id: string, context: OperationContext): Promise<Outcome<Job>> {
    return this.boundary(context, async (context) => {
      context = this.context(context, id, "read");
      unwrap(await this.options.repository.get(id, context));
      while (this.active.has(id)) {
        this.context(context, id, "read");
        await this.pause(context, this.active.get(id)?.done);
      }
      return unwrap(await this.options.repository.get(id, context)).job;
    });
  }
  private notify(
    kind: "claimed" | "settled" | "fault",
    record?: StoredJob,
    code?: ContractError["code"],
  ): void {
    try {
      this.options.onEvent?.(
        Object.freeze({
          kind,
          at: this.options.clock.now(),
          ...(record
            ? {
                jobId: record.job.id,
                requestId: record.requestId,
                status: record.job.status,
                attempt: record.job.attempt,
                elapsedMs: Math.max(
                  0,
                  this.options.clock.now() - Date.parse(record.createdAt),
                ),
                usage: Object.freeze({ ...record.usage }),
              }
            : {}),
          ...(code ? { code } : {}),
        }),
      );
    } catch {
      // Telemetry cannot invalidate a durable result or recursively report itself.
      this.error = detail("INTERNAL_ERROR");
    }
  }
  private fault(error: unknown, record?: StoredJob): void {
    const result = failure(
      { projectId: this.options.projectId, requestId: "scheduler" },
      error,
    );
    if (result.status !== "complete" && result.status !== "partial")
      this.error = result.error;
    this.notify("fault", record, this.error?.code ?? "INTERNAL_ERROR");
  }
  private async repair(
    initial: StoredJob,
    facts: RecoveryFacts,
  ): Promise<StoredJob> {
    const controller = new AbortController();
    const ctx = this.context(
      await this.bounded(
        this.options.recoveryAuthority.issue(own(initial), controller.signal),
        this.authorityTimeoutMs,
        () => controller.abort(),
      ),
      initial.job.id,
      "write",
    );
    let record = unwrap(await this.options.repository.get(initial.job.id, ctx));
    if (terminal(record.job.status)) return record;
    if ((record.job.lease?.id ?? null) !== facts.stoppedLeaseId)
      throw new HostBoundaryError(
        "LEASE_LOST",
        "Recovery cannot interrupt a successor execution.",
      );
    if (
      !facts.stopConfirmed ||
      !["queued", "waiting-for-user", "interrupted"].includes(record.job.status)
    ) {
      if (record.job.status !== "interrupted")
        record = unwrap(
          await this.options.repository.reconcile(
            record.job.id,
            record.rowVersion,
            { kind: "interrupt", error: facts.error },
            ctx,
          ),
        );
      if (!facts.stopConfirmed) return record;
    }
    const evidence = own(
      await this.bounded(
        this.options.recoveryAuthority.decide(own(record), own(facts), ctx),
        this.authorityTimeoutMs,
        () => controller.abort(),
      ),
    );
    if (
      evidence.kind === "resolved" &&
      evidence.stoppedLeaseId !== facts.stoppedLeaseId
    )
      throw new HostBoundaryError(
        "CONFLICT",
        "Recovery must match the confirmed stopped lease.",
      );
    return unwrap(
      await this.options.repository.reconcile(
        record.job.id,
        record.rowVersion,
        evidence,
        ctx,
      ),
    );
  }
  private facts(
    reason: RecoveryFacts["reason"],
    error: ContractError,
    entry?: Active,
  ): RecoveryFacts {
    return {
      reason,
      error,
      stopConfirmed: entry?.stopped ?? true,
      stoppedLeaseId: entry?.leaseId ?? null,
    };
  }
  private async finish(
    entry: Active,
    result: HandlerResult | undefined,
    error?: unknown,
  ): Promise<void> {
    const ex = entry.execution;
    await ex.serial(async () => {
      let committing = false;
      try {
        // Fresh control authority can observe committed receipt/cancel even if work signal expired.
        const controlController = new AbortController();
        const control = this.context(
          await this.bounded(
            this.options.recoveryAuthority.issue(
              ex.record,
              controlController.signal,
            ),
            this.authorityTimeoutMs,
            () => controlController.abort(),
          ),
          ex.record.job.id,
          "write",
        );
        await ex.refresh(control);
        if (terminal(ex.record.job.status)) return;
        if (ex.record.job.lease?.id !== entry.leaseId)
          throw new HostBoundaryError(
            "LEASE_LOST",
            "Finalizer no longer owns this execution.",
          );
        if (ex.record.job.status === "cancel-requested") {
          ex.adopt(
            await this.repair(
              ex.record,
              this.facts("cancel", detail("CANCELLED"), entry),
            ),
          );
          return;
        }
        if (
          this.options.clock.now() >=
            Date.parse(ex.context.authorization.expiresAt) ||
          !this.options.executionAuthority.verify(ex.context.authorization)
        ) {
          ex.adopt(
            await this.repair(
              ex.record,
              this.facts("authority", detail("ACTION_REQUIRED"), entry),
            ),
          );
          return;
        }
        if (
          ex.context.signal.aborted ||
          ex.record.job.status !== "running" ||
          this.options.clock.now() >= Date.parse(ex.context.deadline) ||
          this.options.clock.now() >=
            Date.parse(ex.context.authorization.expiresAt)
        ) {
          ex.adopt(
            await this.repair(
              ex.record,
              this.facts("lease-lost", detail("LEASE_LOST"), entry),
            ),
          );
          return;
        }
        if (ex.refreshFailure)
          this.fault(new JobFailure(ex.refreshFailure), ex.record);
        if (ex.stageFailure) unwrap(ex.stageFailure);
        if (error) throw error;
        if (!result)
          throw new HostBoundaryError(
            "INVALID_INPUT",
            "Handler returned no outcome.",
          );
        result = own(result);
        if (result.kind === "complete") {
          ex.assertOwner();
          assertTransition(ex.record.job.status, "completed");
          committing = true;
          const committed = unwrap(
            await this.options.repository.commitJob(
              ex.record.job.id,
              fence(ex.record),
              result.completion,
              ex.context,
            ),
          );
          ex.adopt(committed.record);
        } else {
          const error = safeError(result.error);
          if (result.kind === "retry") {
            if (
              ["OUTPUT_UNCERTAIN", "INTERRUPTED", "LEASE_LOST"].includes(
                error.code,
              )
            ) {
              await ex.command({
                kind: "interrupt",
                error: detail(error.code),
              });
              return;
            }
            if (
              !error.retryable ||
              [
                "AUTH_REQUIRED",
                "FORBIDDEN",
                "INVALID_INPUT",
                "INVALID_SCHEMA",
                "UNSUPPORTED_SCHEMA_VERSION",
                "EGRESS_DENIED",
                "DEVICE_UNAUTHORIZED",
                "ORIGIN_FORBIDDEN",
                "CSRF_INVALID",
                "APPROVAL_REQUIRED",
                "UNKNOWN_PROPERTY",
              ].includes(error.code)
            ) {
              await ex.command({
                kind: error.code === "AUTH_REQUIRED" ? "wait" : "fail",
                error,
              });
              return;
            }
            const deadline = retryDeadline(
              this.options.clock.now(),
              ex.record.job.attempt,
              this.backoffMs,
              result.retryAfter === undefined
                ? undefined
                : Date.parse(result.retryAfter),
              Date.parse(ex.record.job.deadline),
            );
            if (ex.record.job.attempt >= ex.record.job.budget.maxAttempts)
              await ex.command({ kind: "fail", error: detail("INPUT_LIMIT") });
            else
              await ex.command({
                kind: "retry",
                error,
                nextEligibleAttempt: new Date(deadline).toISOString(),
              });
          } else await ex.command({ kind: result.kind, error });
        }
      } catch (caught) {
        const problem = failure(ex.context, caught);
        const safe =
          problem.status === "complete" || problem.status === "partial"
            ? detail("INTERNAL_ERROR")
            : problem.error;
        const facts = this.facts("handler-failed", safe, entry);
        // Failed publication may have escaped even though this callback returned.
        // Only explicit reconciliation can establish its external outcome.
        if (
          committing ||
          problem.status === "interrupted" ||
          safe.code === "OUTPUT_UNCERTAIN" ||
          safe.code === "INTERRUPTED"
        )
          facts.stopConfirmed = false;
        try {
          ex.adopt(await this.repair(ex.record, facts));
        } catch (recoveryError) {
          this.fault(recoveryError, ex.record);
        }
        this.fault(caught, ex.record);
      }
    });
  }
  private launch(
    record: StoredJob,
    context: OperationContext,
    controller: AbortController,
    handler: TrustedJobHandler,
  ): void {
    const execution = new Execution(record, context, this.options);
    const entry: Active = {
      execution,
      controller,
      stopped: false,
      leaseId: fence(record).leaseId,
      done: Promise.resolve(),
    };
    this.active.set(record.job.id, entry);
    entry.done = (async () => {
      let result: HandlerResult | undefined;
      let error: unknown;
      try {
        result = await handler.run(execution);
      } catch (caught) {
        error = caught;
      } finally {
        entry.stopped = true;
        execution.closing = true;
      }
      await this.finish(entry, result, error);
      this.notify("settled", execution.record);
    })()
      .catch((error: unknown) => this.fault(error, execution.record))
      .finally(() => {
        // Only the actual callback/finalizer completion releases the local slot.
        this.active.delete(record.job.id);
      });
    this.notify("claimed", record);
  }
  private async pulse(entry: Active, context: OperationContext): Promise<void> {
    const ex = entry.execution;
    await ex.serial(async () => {
      if (entry.stopped) return;
      const record = await ex.refresh(context);
      if (terminal(record.job.status)) {
        entry.controller.abort();
        return;
      }
      if (record.job.lease?.id !== entry.leaseId) {
        entry.controller.abort();
        throw new HostBoundaryError("LEASE_LOST", "A successor owns this job.");
      }
      const expired =
        !record.job.lease ||
        record.job.lease.id !== entry.leaseId ||
        record.generation !== record.job.lease.fencingToken ||
        this.options.clock.now() >= Date.parse(record.job.lease.expiresAt) ||
        this.options.clock.now() >=
          Date.parse(ex.context.authorization.expiresAt) ||
        !this.options.executionAuthority.verify(ex.context.authorization);
      if (
        record.job.status === "cancel-requested" ||
        record.job.status === "interrupted" ||
        expired
      ) {
        entry.controller.abort();
        if (expired && record.job.status !== "interrupted")
          ex.adopt(
            await this.repair(
              record,
              this.facts("lease-lost", detail("LEASE_LOST"), entry),
            ),
          );
        return;
      }
      if (
        this.options.clock.now() -
          Date.parse(record.job.lease?.heartbeatAt ?? "") >=
        this.heartbeatMs
      )
        ex.adopt(
          unwrap(
            await this.options.repository.heartbeat(
              record.job.id,
              fence(record),
              this.leaseMs,
              ex.context,
            ),
          ),
        );
      await ex.flushProgress();
    });
  }
  runOnce(): Promise<Outcome<SchedulerReport>> {
    const operation = this.turn.then(
      async (): Promise<Outcome<SchedulerReport>> => {
        let context: OperationContext | undefined;
        const observer = new AbortController();
        try {
          if (this.stopping)
            throw new HostBoundaryError("CONFLICT", "Scheduler is stopping.");
          context = snapshotOperationContext(
            await this.bounded(
              this.options.executionAuthority.observe(observer.signal),
              this.authorityTimeoutMs,
              () => observer.abort(),
            ),
          );
          if (this.stopping)
            throw new HostBoundaryError(
              "CONFLICT",
              "Scheduler stopped during admission.",
            );
          if (
            context.projectId !== this.options.projectId ||
            context.clock !== this.options.clock
          )
            throw new HostBoundaryError("FORBIDDEN", "Wrong scheduler scope.");
          for (const entry of this.active.values())
            await this.pulse(entry, context);
          const page = unwrap(
            await this.options.repository.scan(
              {
                states: [
                  "queued",
                  "retry-wait",
                  "running",
                  "cancel-requested",
                  "waiting-for-user",
                ],
                limit: JOB_STORAGE_LIMITS.scan,
                ...(this.cursor ? { cursor: this.cursor } : {}),
              },
              context,
            ),
          );
          this.cursor = page.nextCursor ?? undefined;
          const claimed: string[] = [];
          for (const record of page.records) {
            if (this.stopping) break;
            if (this.active.has(record.job.id)) continue;
            if (
              record.job.status === "running" ||
              record.job.status === "cancel-requested"
            ) {
              if (
                !record.job.lease ||
                this.options.clock.now() >=
                  Date.parse(record.job.lease.expiresAt)
              )
                await this.repair(record, {
                  reason: "lease-lost",
                  error: detail("INTERRUPTED"),
                  stoppedLeaseId: record.job.lease?.id ?? null,
                  stopConfirmed: false,
                });
              continue;
            }
            const remainingJobMs =
              Date.parse(record.job.deadline) - this.options.clock.now();
            if (
              remainingJobMs <= 0 ||
              record.job.attempt >= record.job.budget.maxAttempts
            ) {
              await this.repair(
                record,
                this.facts("deadline", detail("DEADLINE_EXCEEDED")),
              );
              continue;
            }
            if (record.job.status === "waiting-for-user") continue;
            if (
              record.job.nextEligibleAttempt &&
              this.options.clock.now() <
                Date.parse(record.job.nextEligibleAttempt)
            )
              continue;
            if (this.active.size >= this.maxWorkers) continue;
            const handler = this.handlers.get(
              `${record.handlerId}\0${record.handlerVersion}`,
            );
            if (!handler || handler.operation !== record.job.operation) {
              await this.repair(
                record,
                this.facts("authority", detail("ACTION_REQUIRED")),
              );
              continue;
            }
            const controller = new AbortController();
            let execution: OperationContext;
            try {
              execution = this.context(
                await this.bounded(
                  this.options.executionAuthority.issue(
                    own(record),
                    controller.signal,
                  ),
                  Math.min(this.authorityTimeoutMs, remainingJobMs),
                  () => controller.abort(),
                ),
                record.job.id,
                "write",
              );
              if (
                execution.signal !== controller.signal ||
                execution.requestId !== record.requestId ||
                execution.jobId !== record.job.id ||
                execution.authorization.actorId !== record.job.actorId ||
                Date.parse(execution.deadline) >
                  Date.parse(record.job.deadline) ||
                Date.parse(execution.deadline) >
                  this.options.clock.now() + execution.budget.maxDurationMs ||
                record.job.attempt >= execution.budget.maxAttempts ||
                (Object.keys(record.job.budget) as (keyof Budget)[]).some(
                  (key) => execution.budget[key] > record.job.budget[key],
                )
              )
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Issuer changed logical execution identity.",
                );
            } catch (error) {
              if (this.stopping) {
                controller.abort();
                break;
              }
              await this.repair(
                record,
                this.facts("authority", detail("ACTION_REQUIRED")),
              );
              this.fault(error, record);
              continue;
            }
            if (this.stopping) {
              controller.abort();
              break;
            }
            const claim = await this.options.repository.claim(
              record.job.id,
              { state: record.job.status, rowVersion: record.rowVersion },
              this.options.ownerId,
              this.leaseMs,
              execution,
            );
            if (claim.status !== "complete") {
              if (claim.status === "failed" && claim.error.code === "CONFLICT")
                continue;
              unwrap(claim);
              continue;
            }
            assertTransition(record.job.status, claim.value.job.status);
            if (this.stopping) {
              controller.abort();
              await this.repair(claim.value, {
                reason: "stopped",
                error: detail("INTERRUPTED"),
                stoppedLeaseId: claim.value.job.lease?.id ?? null,
                stopConfirmed: true,
              });
              break;
            }
            this.launch(claim.value, execution, controller, handler);
            claimed.push(record.job.id);
          }
          return complete(context, {
            claimed,
            active: this.active.size,
            scanned: page.records.length,
          });
        } catch (error) {
          this.fault(error);
          return failure(
            context ?? {
              projectId: this.options.projectId,
              requestId: "scheduler",
            },
            error,
          );
        } finally {
          // A turn owns only its observer, never the active worker's authority.
          observer.abort();
        }
      },
    );
    this.turn = operation;
    return operation;
  }
  async start(): Promise<Outcome<SchedulerReport>> {
    if (this.scheduler)
      return failure(
        { projectId: this.options.projectId, requestId: "scheduler" },
        new HostBoundaryError("CONFLICT", "Scheduler already started."),
      );
    this.stopping = false;
    const controller = new AbortController();
    this.scheduler = controller;
    const first = await this.runOnce();
    if (first.status !== "complete") {
      this.scheduler = undefined;
      return first;
    }
    this.loop = (async () => {
      while (!controller.signal.aborted) {
        await this.options.clock.sleep(this.pollMs, controller.signal);
        if (controller.signal.aborted) break;
        if ((await this.runOnce()).status !== "complete") break;
      }
    })()
      .catch((error: unknown) => {
        if (
          !(
            controller.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
        )
          this.fault(error);
      })
      .finally(() => {
        if (this.scheduler === controller) this.scheduler = undefined;
      });
    return first;
  }
  async stop(timeoutMs = 5000): Promise<Outcome<{ active: number }>> {
    integer(timeoutMs, 1, 30000);
    this.stopping = true;
    this.scheduler?.abort();
    for (const entry of this.active.values()) entry.controller.abort();
    const repairs = [...this.active.values()].map((entry) =>
      entry.execution
        .serial(async () => {
          if (!entry.stopped)
            entry.execution.adopt(
              await this.repair(
                entry.execution.record,
                this.facts("stopped", detail("INTERRUPTED"), entry),
              ),
            );
        })
        .catch((error: unknown) => this.fault(error, entry.execution.record)),
    );
    const timer = new AbortController();
    const sleeping = this.options.clock.sleep(timeoutMs, timer.signal);
    try {
      let drained = false;
      const draining = this.turn.then(async () => {
        await Promise.all([
          ...repairs,
          ...[...this.active.values()].map((entry) => entry.done),
        ]);
        // A timeout/abort only ends the wait, not the original trusted callback.
        while (this.authorities.size !== 0)
          await Promise.allSettled([...this.authorities]);
        drained = true;
      });
      await Promise.race([draining, sleeping]);
      if (!drained || this.active.size) {
        throw new JobFailure(detail("INTERRUPTED"), "interrupted");
      }
      if (this.loop) await this.loop;
      return {
        schemaVersion: "1.0",
        projectId: this.options.projectId,
        requestId: "scheduler",
        status: "complete",
        value: { active: 0 },
        diagnosticIds: [],
      };
    } catch (error) {
      this.fault(error);
      return failure(
        { projectId: this.options.projectId, requestId: "scheduler" },
        error,
      );
    } finally {
      timer.abort();
      await sleeping.catch((error: unknown) => {
        if (
          !(
            timer.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
        )
          throw error;
      });
    }
  }
}

export function createJobService(options: JobServiceOptions): JobService {
  return new JobService(options);
}
