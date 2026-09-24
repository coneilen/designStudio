# @design-studio/jobs

F07 trusted local job library over `@design-studio/storage`'s real single-writer
JobRepository. No database, SQL driver, migration, CLI/API server, worker
process, browser/device/model adapter, or executable discovery is created here.
Constructing/importing the library is inert. Handlers are trusted application
callbacks, **not sandboxed arbitrary JavaScript**.

### Synthetic fixture lifetime

The disk-backed jobs test fixture owns setup/reopen promises, every returned
SQLite instance and service, and the original runner scope. Cleanup cancels
outer test work, joins late opens and serialized store queues, then closes
handles before removing the generated root. A database returned after cancellation
is still registered for cleanup but is never admitted to new fixture work.
Explicit service-issued signals are preserved unchanged. Cancel-control tests
track the original test-body promise, not just the runner's timeout wrapper;
runner-timeout diagnostics report only the pending phase and elapsed timings.
These guards do not increase any test timeout or claim to explain CI I/O latency.

## Required composition

`createJobService(JobServiceOptions)` requires:

- The provisioned store's `jobs` repository, its exact trusted clock, project
  and artifact-root IDs, a stable worker owner ID, and registered handlers.
- `ExecutionAuthority.verify`, `observe(signal)` and `issue(record, signal)`.
  Verification must authenticate exact proof objects. Observation issues a
  fresh explicitly job-scoped discovery context; issuance looks up current
  trusted policy and returns a narrow execution context.
- `RecoveryAuthority.issue(record, signal)` and
  `decide(record, facts, context)`. Recovery issuance is distinct from F03's
  mandatory evidence authorization. Neither an authority reference in submitted
  JSON nor an abort signal proves that recovery/cleanup is authorized.

There is **no default issuer, grant-based authenticity shortcut, production
in-memory repository, or permissive storage/publication policy**. F08 supplies
actual application/CLI policy composition. The issuer must reject unknown or
revoked actors and independently resolve allowed handlers, operations, inputs,
resources and destinations from current trusted policy. It must not copy or
extend expired authorization objects or treat job payload claims as authority.

All public request contexts are snapshotted before queueing/await: owned frozen
metadata and copied budget, exact authorization reference, and live signal/clock.
Callback references and registered handler identity/version/operation are owned
at construction; current policy remains live behind those callbacks.
Execution issuance must preserve the original requestId/jobId/project/actor,
the supplied lifecycle signal and exact clock, and cannot enlarge the persisted
budget or deadline. The library does not persist authorization proofs/tokens.
Normal authorization, semantic validation, native publication barriers, retention,
and recovery policies still belong to the real host/store composition.

## Public API

| API | Result / behavior |
| --- | --- |
| `submit(submission, context)` | `Outcome<Job>`; authorized schema-valid submission, registered operation/handler/version, immutable input references, operation-scoped idempotency. F03 constructs the Job/digest. |
| `get(id, context)` | `Outcome<Job>`; current authorized durable state, including verified completed receipt bytes. |
| `getVersioned(id, context)` | `Outcome<{job, rowVersion}>`; no private authority, effect, control or storage envelope. |
| `cancel(id, expectedVersion, context)` | `Outcome<{job, rowVersion}>`; conditional, durably idempotent cancellation through `cancelWithReceipt`. The control receipt remains in the store's private journal; the public view is current, not the original control-result snapshot. |
| `wait(id, context)` | Waits within the caller's live deadline/signal for terminal or action-required state. Retry-wait is not completion. Cancelling this observer does not cancel the job. |
| `waitForAttempt(id, context)` | Bounded authorized wait for this service's active callback/finalizer to return; useful for attempt-level orchestration. It does not attest another process's quiescence. |
| `getRecoveryView(id, context)` | Bounded authorized `{job,rowVersion,stages,recoveryRequired}` inspection. Stage receipts are evidence, not permission to adopt/publish/discard bytes. |
| `recover(id, expectedVersion, evidence, context)` | Explicit versioned F03 reconciliation, rejecting a claimed stop while this service still has a running callback. |
| `resume(id, expectedVersion, evidence, context)` | Explicit authorized resolved-to-queued recovery; never changes logical identity, original budget or deadline. |
| `runOnce()` | One serialized, bounded scheduler pass with claimed IDs, active count and scanned count. |
| `start()` / `stop(timeoutMs?)` | Explicit polling lifecycle / bounded cooperative shutdown. No processes are spawned. |

The private rowVersion is an optimistic-concurrency token, not a lease
generation. Both matter. Consumers must not attach rowVersion or private
metadata as extra fields on the strict shared Job JSON.

Cancellation `context.requestId` is the control idempotency key, independent of
the job's original logical request. F03 binds it to project/actor/private
job-cancel operation and exact job ID/expected version. A successful control
increments the private version once, even when a final receipt already won.
Exact replay after restart/restore does not mutate and returns the currently
authorized Job/version, which may be newer than the immutable control receipt's
resultVersion. Reusing that key for another target/precondition conflicts before
completed-job handling. There is no in-memory deduplication or fallback to legacy
`requestCancel`. F08 transports/header handling/routes remain outside this package.

## Handler and staged renderer contract

Register `{id, version, operation, run(execution)}` through trusted composition,
never a model-supplied function/script/provider request. The `run` result is
one of complete, wait, retry, fail or interrupt. Complete carries the F03
`JobCompletion`, including exact staging receipts, outputState, diagnostics,
optional revision CAS request and independent comparison verdict/source status.
Missing schema/semantic evidence cannot be converted into complete output.
F03's required `verifyCompletion` validates actual output bytes.

`JobExecution` exposes an owned context, a copied current record, checkpoint,
stage, coalesced progress, reserve/settle usage, and a **stage-only** filesystem
adapter. Await every operation before returning from a handler. Do not retain
execution callbacks to issue work after return. In-flight writes are serialized;
every successful repository operation adopts its new rowVersion. Staging
precharges bytes/version before I/O; failure rereads the record without resetting
its charge or silently retrying the stage.

The execution's original lease ID, owner, generation and resource generations
are immutable. Refreshing an observed Job can never authorize an old callback
to adopt a successor's fence. Old finalizers also cannot interrupt a successor.

F06's staged path receives `execution.filesystem`, which accepts only the
configured artifact root and exact `blobs/<sha256>` content address. It preserves
the exact execution context and storage-issued metadata. Each awaited stage
passes directly through `JobRepository.stage` and updates the journal/version
before returning. Do not stage through the raw host and add job ownership only
after rendering.

F06's package-local wrapper returns
`{outcome, staged, evidence?, cleanup?, recoveryRequired}`. It must preserve
known stage receipts on failure/cancel. Its renderer-host lease cleanup is
separate from artifact cleanup and finishes before staging under that lease's
own finite allowance. No publisher/discard is reachable through the jobs stage
adapter. Only F07 calls fenced `commitJob`; the standalone auto-publishing
Renderer adapter is not the tracked-job path.

A declared partial `JobStageResult` maps to partial `StagedArtifact`, preserving
the exact known receipt, original error, missing items and diagnostic IDs.
`execution.stageFailure` retains an owned copy of that mapped noncomplete
outcome before attempting a journal refresh. Failed or rejected refresh cannot
replace this primary evidence. Such a partial result still forbids completion
and remains interrupted; it is neither publication authority nor permission to
adopt bytes by hash. `getStages` remains necessary for durable recovery but is
not a substitute for preserving already-known receipts while reads are unavailable.
Do not log raw stageFailure objects; normal job errors/telemetry remain sanitized.

## State, limits and safety

All nine shared states remain distinct: queued, running, waiting-for-user,
retry-wait, cancel-requested, completed, failed, cancelled and interrupted.
Heartbeat/progress and idempotent receipt reads are not state transitions.
Safe wait/retry/fail releases happen only after the handler actually returns
and F03 confirms no unresolved effect. Completed comparison reports may carry
fail or inconclusive verdicts; completed is artifact production, not policy pass.

F03 commits completed Job, receipt, artifacts/reference edges and optional
revision/head CAS in **one existing writer transaction** after the mandatory
host publication barrier. No unfenced ArtifactStore commit, second database,
or two-commit/outbox atomicity claim exists here. A committed receipt wins
cancellation/response loss. Failed final publication remains interrupted pending
explicit reconciliation; filesystem hash equality is not completion evidence.
Corrupt committed bytes yield an integrity error, not automatic rerunning.

Runtime concurrency defaults to 1 and is configurable only in 1..4. This is
separate from development-agent concurrency. **Expired/interrupted callbacks
retain both global slots and resource ownership until confirmed stop.**
Different/no resource keys cannot bypass the worker ceiling. A local callback
is not removed from active accounting by an abort or timeout Promise race.
Across reopen, F03 retains the durable slot. A destination restored-lease marker
is not proof that source workers stopped, and does not release quarantine.
Cross-store physical-device coordination is not implemented.

The original effective deadline covers queue/retry/wait time. Attempts increment
on claim, never heartbeat or polling. Retries honor max(backoff, retry-after),
retain original requestId/jobId and cumulative reservations, and never retry
permission/schema errors automatically. Defaults retain the shared 30-second,
three-attempt, 25-MiB input/output profile and zero calls/tokens/spend. Reservation
amounts remain charged even for settled/no-effect work in this initial store.
Unknown effects retain interruption/reservations and are never blindly retried.

Storage caps are imported from `JOB_STORAGE_LIMITS`, not copied into a competing
schema: scan100, keys32, stages/effects128, progress sequence10000 at least50ms
apart, 20000 retained jobs/resource counters/global stage entries and bounded
metadata. The scheduler processes a page per pass in createdAt/ID order, so
blocked resources do not hide all other eligible work. Progress stays below1
until atomic completion. Final receipt success does not imply every submitted
duplicate stage was consumed.

Library defaults: lease5000ms, heartbeat about one-third of lease, poll100ms,
retry backoff1000ms, authority allowance5000ms, shutdown allowance5000ms.
Execution issuance is capped by the lesser of the configured authority allowance
and the immutable job deadline's remaining time; expired jobs never invoke the
execution issuer. Observation and recovery retain their purpose-specific
allowance so current authority can reconcile an expired job.
Leases/shutdown/authority allowances are finite and at most30000ms; poll must
not exceed heartbeat and heartbeat is below lease. Storage further caps leases
by job/context/grant deadlines. F03 holds its queue during publication I/O:
delayed heartbeats cannot retroactively revive an expired lease.

Each scheduler turn aborts its own observation signal when that turn settles,
on success or failure, so the authority issuer can retire its temporary grants.
This does not abort active worker signals or replace execution authority.
`waitForAttempt` does not drive heartbeats: callers waiting on asynchronous work
must keep `start()` running (or independently drive scheduler turns), then join
`stop()` on every exit. Execution staging/finalization remains serialized with
heartbeat and cannot be kept alive by an overlapping unfenced renewal.

Original observe/issue/recovery callback promises are tracked independently of
their deadline races, until actual fulfillment or rejection. Aborting their
signals does not remove them from shutdown accounting. A late result after
timeout cannot start a handler or be mistaken for a completed earlier request.

`stop` returning a noncomplete outcome means work/authority/recovery has not fully drained:
do not close the shared store/host while operations are still pending. Retry
stop after actual quiescence. Pending callbacks produce `interrupted` even when
the count of active job handlers is zero. It never kills arbitrary code, deletes staged
files, or claims an uncooperative callback stopped. Trusted host/authority
operations still have to honor their own finite/cooperative boundaries;
synchronous native calls are not forcibly interruptible.

## Recovery, telemetry and evidence

Recovery uses fresh current authority, never expired caller grants. It inspects
receipts before deciding next state; uncertain host publications remain
interrupted/action-required. Exact staging IDs stay available through F03's
journal and bounded getStages. Historical/current stages are not interchangeable
capabilities; explicit disposition plus current instance ownership and host
policy are required for discard. Unknown stages are retained. Jobs never invoke
filesystem close/discard as an implicit recovery step.

Optional local `onEvent` reports only claimed/settled/fault, IDs, state, attempt,
numeric elapsed time/cumulative usage and safe codes. No raw payload, exception
text, prompts, credentials or signed URLs are logged. `lastError` exposes typed
scheduler/recovery/telemetry failures. A throwing telemetry observer sets
INTERNAL_ERROR without invalidating committed work or recursively logging itself.
Elapsed time is since original submission, not a claimed pure render benchmark.
There is no dependency on external telemetry.

Observed RED/GREEN sequences include absent state/service modules; revoked
in-flight authority incorrectly becoming failure rather than action-required;
issued budget enlargement; failed publication incorrectly auto-resolving; old
callbacks adopting successor fences; waiting-job deadline expiry; stop/admission
races; and telemetry exceptions escaping durable completion. Tests cover all81
legal/illegal state pairs, conditional cancellation, receipt races, staged
renderer journaling, retained slot caps1/4, restart, persisted retry deadlines,
unknown effects, finite authority waits, explicit resume and waiter cancellation.
Review-driven regressions additionally cover partial stage receipts surviving
unavailable/rejected refresh, timed-out authority/recovery callbacks still
blocking shutdown until late settlement, and durable cancellation replay after
restart/authorized restore returning the current private version without mutation.

Most integration cases use real temporary SQLite with the explicitly synthetic
storage test disk adapter and a current-policy LocalSessionAuthenticator registry.
That adapter does not prove host containment/durability. The separate Windows
x64 smoke uses real ProjectFileSystem native NTFS publication plus SQLite and
verifies committed-report receipt replay after reopen without another handler
invocation. Only original synthetic bytes and newly owned temporary roots are
used. No real renderer/browser, provider, device, credential vault or user store
is accessed. Database-backup durability remains F03/F04's required hook; fresh
job smoke does not establish migration or hardware power-loss guarantees.

Build before typecheck/smoke, using the repository's pinned Node/pnpm:

```powershell
pnpm -r --sort build
pnpm typecheck
pnpm exec vitest run --project unit packages/jobs/tests
pnpm exec vitest run --project smoke packages/jobs/tests
pnpm exec biome check packages/jobs
```

Dependency install scripts remain disabled; native SQLite preparation is the
existing explicitly approved storage command. No external dependency was added.
