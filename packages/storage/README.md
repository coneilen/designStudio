# @design-studio/storage

F03 local storage core, package version 1.0.0. Shared artifact/revision/review
contracts remain `@design-studio/contracts` schema 1.0. The private SQLite schema
is version 3. No renderer, asset decoder, authorization issuer, job scheduler,
handoff compiler, live provider, or competing filesystem implementation is here.

**Production composition requires explicit trusted policies.** The stable
SQLite backend and the host's opt-in `windows-ntfs-write-through-v1` publication
profile are exercised together by the root Windows integration suite.
`ensurePublicationDurable` still fails for generic or unknown publication
evidence; no permissive fallback is provided. Package-isolated tests retain
their explicitly simulated boundary acknowledgments. Neither these tests nor
the native OS-request profile constitute a hardware power-cut guarantee.

## Stable backend and reproducible preparation

Selected `better-sqlite3` **12.8.0**, not `node:sqlite` (Node 24's RC API), sql.js,
a JSON substitute, a remote service, or a second runtime. Version 12.8.0 declares
Node 24 support and ships the exact official Node ABI 137 Windows x64 prebuild.
Version 13.0.3's source-build installation path was not accepted.

After the root's pinned Node 24.21.0/pnpm 11.26.0 setup, from the workspace root:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @design-studio/storage prepare:native
pnpm build
pnpm typecheck
pnpm exec vitest run --project unit packages/storage/tests
```

Preparation is an explicit package-owned command, **not** an install hook.
It downloads only the pinned official GitHub release asset, with a 30-second
deadline and exact compressed-size limit; verifies its published SHA-256;
accepts exactly the expected regular tar entry, header and zero trailer;
verifies the extracted binary; and writes only the workspace's ignored
`.tools\sqlite-prebuild\build\Release\better_sqlite3.node`.
It rejects a mismatched existing binary, unsupported host/ABI/runtime, malformed
archive, or download failure. No compiler fallback, global installation,
dependency build approval, package-store mutation, or weakened TLS is used.

Offline preparation accepts a previously acquired official archive explicitly:

```powershell
pnpm --filter @design-studio/storage prepare:native --archive D:\approved-cache\better-sqlite3-v12.8.0-node-v137-win32-x64.tar.gz
```

Use the reported absolute `nativeBinding` path in `LocalStore.open`.
That supported driver option avoids placing a one-off binary in `node_modules`.
Keep the archive and `native-provenance.json` in the approved offline distribution
inventory. The command does not download other architectures or silently reuse
an ABI-incompatible binary.

Actual local distribution evidence, 2026-09-16:

| Item | Observed identity |
| --- | --- |
| Runtime | Node 24.21.0, ABI 137, win32 x64 |
| Package | better-sqlite3 12.8.0; MIT, copyright Joshua Wise; registry SHA-1 `ec9ccd4a426a35f3b9355c147af6c92a6ddd6862` |
| Official archive | 1,028,637 bytes; SHA-256 `cf91c2200c721b717a0562ecb399f60575566c5507e72426c96fb85ad2dd3d57`, matched GitHub's release-asset digest |
| Extracted binary | SHA-256 `194c049b8781c3ca39f7e12b4f4a47c79027502b366151404ae8847fe6e2a9a1`, locally measured after archive verification |
| Execution | Online preparation and offline reuse; real file-backed WAL commit/rollback/reopen/integrity; abrupt child-process exit/OS lock release; paths containing spaces and U+00E9 |

The provenance manifest records the exact official URL and digest provenance.
Retain the installed package's full MIT LICENSE, SQLite notices, Node notices,
and other dependency notices in redistribution. The extracted-binary digest is
not an upstream signature. The scoped lockfile adds the driver/types and their
37 package records without changing existing package records; it retains the
trusted mirror's SHA-1 provenance, not invented upstream SHA-512.
Public-npm restore, clean-machine signing/packaging, macOS native loading, and
macOS execution remain unverified.

## Required composition and public APIs

`LocalStore.open(StorageOptions)` acquires a retained SQLite EXCLUSIVE OS lock.
The single connection and async operation queue serialize commits, reads,
backup, review append, and maintenance. Competing service opens fail
`WRITER_BUSY`; process death releases the OS lock. There is no timeout lease
that can expire while an old writer still acts. `close()` refuses in-flight
work and is otherwise idempotent. Work is bounded by operation deadlines,
duration, input/output bytes, aggregate snapshot reads, and maintenance entries.

The database stores and checks **project ID, artifact root ID, and permission
scope** before any blob lookup. UNC/device/network URL paths are rejected.
`attestLocalDatabase(path, scope)` is mandatory host provisioning authority:
it must verify local media (including mapped drives), safe private database and
blob roots, exclusive managed-root access, and the exact project/permission
binding. Syntax checks do not defeat a hostile local writer. Distinct permission
domains that must not share existence require distinct physical roots/stores.
Changing a configured ID is not permission migration.

Every operation requires `OperationContext` and a mandatory asynchronous
`authorize(context, scope)` callback. Compose it with F04's trusted
`authorizeOperation`, not a shape/grants-only or allow-all function.
Root-scoped authorization precedes deduplication, existence checks and inventory;
revision/design/job access receives additional object-scoped checks.

Before enqueueing, storage owns and freezes request metadata and a copied
budget, then passes that owned context to authorization, filesystem calls,
retention callbacks and receipt construction. Caller edits to request/project/
job IDs, deadlines or budgets cannot retarget queued/in-flight work. The exact
authorization object is retained for trusted reference-based authenticators;
storage neither clones that proof nor freezes caller objects. Its captured
authorization JSON must remain unchanged at checkpoints and before accepting
results; in-place claim/grant mutation fails with `FORBIDDEN`. The original
signal and clock references remain live for cancellation/deadlines.

| API | Behavior |
| --- | --- |
| `stage(bytes, context)` | Copies bounded bytes, requests `blobs/<lowercase SHA256>`, checks verbatim shared staging metadata. |
| `verify(reference, context)` | Resolves trusted project metadata and reads/checks actual length and SHA-256. |
| `commit(outputs, context)` | Implements shared `ArtifactStore`; publishes and verifies bytes, requires durability acknowledgment, then atomically stores artifacts, protected job references and `CommitReceipt`. |
| `commitRevision({branch, base, revision, outputs}, context)` | Adds immutable revision/parent/lock storage and branch CAS in the same receipt transaction. Null base initializes a new root only; otherwise both expected revision and exact quoted content-hash If-Match must match. |
| `getRevision`, `getHead`, `getReceipt` | Authorized snapshot/head/receipt access. Receipt retrieval/retry checks actual output bytes. |
| `forkBranch(designId, branch, base, context)` | Creates an absent alternative head at an exact accepted revision/strong If-Match; never replaces an existing branch or rewrites the source head. Later revisions use normal CAS. |
| `appendReview`, `listReviews`, `applicableApproval` | Immutable actor-bound append chain; exact context and trusted evidence applicability, never manifest self-assertion. |
| `pin`, `releasePin`, `collectGarbage` | Policy-authorized bundle/job/legal/cache retention. Immutable revision/review/job receipt references are never cache-evicted. |
| `recover` | Reports orphan paths and corrupt/missing committed artifacts; discards only stages the mandatory trusted job policy proves abandoned. Unknown stages are retained explicitly. |
| `backup`, `restore` | Complete metadata/byte snapshot and verified transactional restoration into an empty provisioned store. |
| `encodeBackup`, `decodeBackup` | Bounded versioned UTF-8 JSON/base64 transport; duplicate keys, invalid encodings and unsupported shapes fail. Decoding does not authenticate approval provenance. |
| `jobs` | Optional trusted-composition persistent job repository, using this same writer/queue and guarded publication transaction; see below. |

`requestId` is the logical idempotency key for the current shared ArtifactStore
contract. Scope is project + trusted actor + `write` + requestId; payload
identity includes exact output metadata and revision/base/branch content.
Changing payload or job ID under that key conflicts. F07 must reuse both
requestId and jobId for retries; it must not replace them per network attempt.
Committed receipt wins cancellation/response-loss races. Stage/publish/transaction
failures leave at most staged/orphan bytes, never newly committed partial pointers.
Noncomplete host publication preserves interrupted/unavailable/cancelled outcomes
and error codes, and never invents a receipt.

### Persistent jobs: F03-owned transaction boundary

`StorageOptions.jobs` enables `store.jobs`; omitting it preserves legacy callers
and makes repository operations fail explicitly, not use an in-memory fallback.
It supplies the trusted shared `clock`, optional `maxWorkers` (default 1, maximum
4), optional immutable `limits` (default shared `DEFAULT_BUDGETS`), mandatory
`verifyCompletion(record, completion, evidence, context)` and mandatory
`authorizeRecovery(record, evidence, context)`. These are application composition,
not request payload. The verifier must enforce registered handler/version and
operation-specific schema/semantic completeness, not just hashes. Recovery policy
must authenticate its evidence reference and actual callback/effect-stop knowledge;
an aborted signal, elapsed lease, or matching hash is not stop evidence.

Private `jobs`, `job_resources`, and `job_stages` tables belong to the existing
SQLite connection. No second database, outbox, writer, public SQL handle or
caller-supplied transaction callback was added. `JobRepository`, `JobSubmission`,
`StoredJob`, `JobExpected`, `JobWorkerExpected`, `JobCommand`, `JobCompletion`,
`JobReconciliation`, usage/stage/result types and `JOB_STORAGE_LIMITS` are
exported. Shared Job/Lease/Receipt/schema version 1.0 remains unchanged.

| Repository operation | Contract |
| --- | --- |
| `create(submission, context)` | Constructs queued shared Job with attempt/progress zero. Owns submission; derives actor/project/request from context, computes canonical submission digest, pins verified committed input/resource artifacts atomically. Optional `inputRevision` names an accepted revision and its content hash. |
| `get(id, context)`, `getJobReceipt(id, context)` | Authorize before lookup; completed reads verify original-owner logical scope, authoritative Job/receipt binding, protected output refs and actual bytes. Observers need not be the submitting actor. |
| `scan(query, context)` | Explicit state list, limit, optional due cutoff and `(createdAt,id)` cursor. Only IDs covered by current explicit job-read grants are selected. Stable oldest-created/ID ordering; no wildcard/existence-only polling. |
| `getStages(id, context)` | Bounded exact stage-journal snapshot under root/job-read authority; metadata is evidence, never cleanup permission. |
| `claim(id, expected, ownerId, durationMs, context)` | Exact state/version; queued or due retry only. Atomically acquires every sorted key or none, increments attempt and durable job/resource generations, enforces trusted worker ceiling, attempts and deadlines. Retained execution leases occupy capacity even when interrupted or expired, until a confirmed-stop transition releases them. |
| `heartbeat(id, expected, extensionMs, context)` | Original live lease required, including at transaction exit. Extension cannot resurrect a lease and is capped by original job/current context/current grant deadline. |
| `update(id, expected, command, context)` | Discriminated progress, reserve/settle usage, wait/retry/fail/interrupt, or acknowledge-cancel. No arbitrary patch. Wait/retry/fail/cancel acknowledgment means the trusted handler has actually stopped; unresolved effects prohibit release. Interrupt quarantines resources. |
| `requestCancel(id, expectedVersion, context)` | Current authorized caller need not own worker lease. Receipt wins first; running becomes cancel-requested, including when effects remain unresolved. Safe nonrunning work cancels; uncertain work requires reconciliation. |
| `stage(id, expected, bytes, context)` | Copies bytes before enqueue. Atomically reserves cumulative input/output bytes and a version before host I/O. Journals returned exact stage identity before returning a fresh record. Expiry/auth/cancel after I/O retains journal evidence; crash/fault before journal leaves an unknown host stage that cannot be adopted/discarded. Failure requires rereading the current record, not retrying an obsolete version. |
| `commitJob(id, expected, completion, context)` | Reuses real publication, actual-byte verification, mandatory durability and optional F02 revision/head CAS. Synchronously rechecks original fence/state/version/deadlines/all resource generations inside the one transaction storing artifacts, receipt, protected refs, completed Job and optional revision/head, then releases keys. Returns `{record,receipt}`. |
| `reconcile(id, expectedVersion, evidence, context)` | Trusted recovery callback precedes receipt decisions. Interrupt invalidates generation and quarantines uncertain ownership. Resolved evidence must acknowledge exact stopped lease/effects before queued/cancelled/failed/waiting state; never resets identity, attempts, usage or deadlines. `abandon-stages` permits explicitly authorized cleanup disposition after completion without changing receipt. |
| `canDiscardStage(stagingId, context)` | Requires named job/read authority and explicit authorized-abandoned disposition, no active/unresolved ownership, and this exact store/host-instance journal. Unknown/historical stages return false. It grants no filesystem deletion authority. |

Worker `expected` contains exact state, rowVersion, leaseId, ownerId, fencingToken
and the persisted resource-generation list. Every worker mutation also requires
original requestId/jobId/actor and the same trusted shared clock reference.
Submission metadata/budgets are owned before enqueue; original authorization
proof, live signal and clock are retained through the existing snapshot/host
branding checks. Observers, cancellation and recovery can have separate transport
request IDs with current authority. Root/job grants are mandatory; inputs require
artifact-read (and optional revision-read), final outputs require artifact-write,
and receipt replay requires artifact-read. F07/F08 issue fresh contexts; storage
never clones proof, extends expired authority, persists tokens, or acts as issuer.

Fixed foundation bounds exported by `JOB_STORAGE_LIMITS`: 20,000 retained jobs
(terminal history included), 20,000 resource counters and total journal rows;
32 keys/job, 128 stages/effects/job, 100 scan entries, 10,000 progress sequence
ceiling, minimum 50 ms between progress writes, and 25 MiB metadata profile.
Lease durations/extensions are positive integers at most 30 seconds. Capacity
returns a typed limit, never silently prunes history. Progress is monotonic and
below 1 until final completion. All counters use checked safe-integer increments.
Resource generations persist after release; expiry alone never frees quarantine.
This is per-store serialization, not cross-project physical-device exclusivity.
Both worker interruption and recovery interruption retain the execution's worker
slot, including after reopen and lease expiry. Generation invalidation fences
mutations; it does not prove the old callback stopped. Trusted resolved recovery
or a confirmed-stop worker transition must release the lease before another job
can use that slot, even when the jobs have disjoint resource keys.
GC also protects paths in the durable stage journal, including published bytes
left by a failed final transaction. This foundation conservatively retains that
physical evidence with job history; stage-file discard does not prune blob history.

Usage reservations are cumulative, including settled/no-effect reservations;
unused reservation capacity is conservatively not refunded. Staging charges
bytes before possible effects, including interrupted attempts. Reserve before
an external effect, settle actual usage within the prior reservation, and retain
unknown results. Shared defaults permit zero external calls, model tokens and
cost. No real external handlers run here.

Job receipt SQL keys use a private tagged namespace and persisted logical
operation/original actor/requestId. Shared receipt `payloadSha256` identifies
final output/revision/completion metadata; it differs from the immutable
submission digest, with `StoredJob.finalOutputSha256` binding the two histories.
Legacy write commit/getReceipt keys and rows are unchanged. A legacy logical
write key conflicts with a new tracked write in either direction, but other
operations can share that key. A historical legacy job ID cannot be appropriated
by a new job. Legacy commit/commitRevision reject tracked jobs before publication
and again in the transaction, closing unfenced stale-handler bypasses.
Committed receipt wins cancellation and response-loss replay.

Historical publication assurance accepts a tagged job receipt only when its
exact authoritative completed Job, submission binding, final digest, scope,
output metadata and protected refs agree. Legacy untracked write receipts retain
their original rules. A hash-correct orphan/metadata row is not valid job input.
Reused output stages remain journaled: completion is not automatic discard.
Store restart preserves journal identities but does not reconstruct another
host instance's staging authority; cleanup of such evidence needs host-owned
recovery, outside this repository's discard permission.

New-key reuse after a host restart separates historical assurance from new
publication. An existing artifact bypasses a new host-process barrier only when
its complete metadata exactly matches an output of a schema-valid committed
receipt, with its protected job-reference edge and matching project/idempotency
scope key in the trusted database. Current bytes/hash/length and current
project/root/permission authorization are still verified. Receipt outputs remain
complete even when only the newly published subset goes to the current barrier.
The historical receipt proves that the original storage transaction crossed
its mandatory publication barrier; it does not reconstruct a host file-identity
receipt or claim a new native profile/power-cut result.

This relies on `attestLocalDatabase` establishing the provenance and exclusive
ownership of the database, not merely checking a local-looking pathname.
Untrusted SQL files must not be opened as trusted stores; use authenticated,
verified restore. Filesystem presence, an artifact row alone, an orphan,
a foreign/mismatched receipt or a missing reference edge cannot establish that
assurance. Objects without it require publication and a current barrier.
Restore always requires a current barrier for every destination object before
accepting any imported receipt, even when the backup contains trusted history.

Duplicate stage receipts supplied for reused committed outputs are deliberately
left available to bounded `recover`: their cleanup cannot change an already
committed logical receipt. They are discarded only after the existing trusted
`canDiscardStage` policy and host ownership checks allow it; unknown/live stages
remain explicitly reported. No automatic cleanup under expired authority occurs.
Callers/jobs must retain the original submitted staging IDs until authorized
cleanup/reconciliation; a complete commit receipt does not mean every submitted
stage was consumed. The shared receipt records artifacts, not staging lifecycle.

Public content contracts are imported rather than copied. JSON persistence
encoding is not a new canonical design format: mandatory `canonicalBytes`
comes from F02 for fingerprints/review hashes. `verifyRevision` receives the
revision plus actual verified content/provenance/resource bytes and must enforce
F02's semantic/canonical content rules. Resource hashes are hashes of exact
pinned bytes, not reserialized objects.

Approval lookup binds the full shared `ApprovalContext`: accepted revision
content and lock, project/design, target, repository, scenario, baseline,
render profile and policy. A new context needs a new approval. Draft,
changes-requested or superseded state invalidates the current context's
approval; comments and waiver events cannot grant one. Mandatory
`assessApproval` is a **trusted** evidence/policy lookup: incomplete evidence or
critical blockers cannot be waived, and every outstanding eligible diagnostic
requires an explicit reason/instructions waiver. An imported self-asserted
approval is never inserted through a public bypass.

## F04 maintenance and durability adapter

Storage owns `StorageMaintenance`:

```ts
interface StorageMaintenance {
  inventory(context: OperationContext, maxEntries: number): Promise<{
    stagedIds: string[];
    publishedArtifacts: Artifact[];
  }>;
  removeBlob(artifact: Artifact, context: OperationContext): Promise<void>;
}
```

Compose a **root-specific** wrapper around F04
`inventory(rootId, context, maxEntries)` and
`removeUnreferenced(rootId, artifact, context)`. Unwrap only complete outcomes;
propagate typed failures. F04 roots must be explicitly private/exclusive and
`managedBlobs: true`; the boundary must recheck exact bytes/hash and scope before
removal. Its `authorizeRemoval` callback should synchronously consult
`store.hasRemovalReservation(artifact, context)` inside an async wrapper.
Do not reenter the store queue from that callback.

The reservation exists only during exact guarded removal under the single
writer queue/OS lease, and is cleared in `finally`. Reference checks include
all aliases of a physical content path. A racing commit cannot add a reference
between the reference check and deletion. `authorizeRetention` is mandatory
for pin/release/collection; no legal hold is silently overridden.
When composing F04, set `StorageOptions.snapshotOperationContext` to the host's
shared branded helper. Reapplying that helper in nested host operations returns
the same owned context, preserving the exact removal reservation. Storage
checks frozen metadata/budget, unchanged metadata values and exact authorization/
signal/clock references even when this optional helper is supplied; it is not
an authorization bypass. Non-host adapters use storage's own snapshot boundary.
A configured helper cannot substitute a cloned auth proof.
This version conservatively retains job-receipt evidence indefinitely.
Releasing cache pins does not erase revision, review, job, bundle or legal
references; broad historical deletion is intentionally not exposed.

`canDiscardStage` must consult trusted job state. Return false for unknown
historical F04 staging IDs; cross-instance publication reconciliation belongs
to the host's explicit owned-operation recovery API, not guessed deletion.
Recovery is bounded and reports integrity problems rather than reporting a
repaired success. A rejected/expired cleanup leaves bytes for later authorized
reconciliation.

`ensurePublicationDurable(artifacts, context)` is mandatory before database
reference commits, including restores. Wrap F04's same-named root-scoped
capability when integrated. Its current unavailable directory-entry durability
for generic publication must remain a typed failure; the opt-in NTFS profile
verifies its owned native publication evidence instead. There is **no production success default**.
The local-disk test adapter in `tests/support.ts` is not a production host layer,
has deliberately simplified filesystem behavior, and claims no hostile-writer,
power-loss or macOS guarantee.

## Backup, restore and migration recovery

Backup holds the same serialized writer reservation while validating all rows,
reference chains and bytes. It exports complete immutable data, branch heads,
reviews, receipts and retention pins, plus a canonical metadata digest and
deduplicated exact bytes. The transport codec has a 25-MiB ceiling; oversized
exports fail explicitly, not partially. No streaming/large-project archive
implementation is claimed.
Base64 validation uses a stack-safe character scan with length/padding checks
and a canonical decode/re-encode comparison. A 4-MiB synthetic artifact is
covered through encoding, decoding, verified restore and exact byte hashing.

Restore requires an empty store and mandatory `authorizeRestore(backup, context)`
that authenticates backup provenance and destination authority. Hash checks
alone are insufficient, especially for imported approvals. Nested shared
contracts, exact bytes, parents/cycles, heads, receipt outputs, review chains
and all protected references are checked. Blobs are staged/published first;
rows/references commit together only after the durability gate. Interrupted
restore leaves orphan bytes and an empty database, never a success-shaped
partial project. Application-managed backup file publication also needs the
host's durable write boundary; returning encoded bytes does not persist a file.

Fresh empty SQLite databases initialize atomically. Foreign application IDs,
unknown schema versions, nonempty unversioned databases, wrong project/root/scope
and SQLite integrity errors fail closed. The supported v1->v3 migration adds the content-hash index and private job tables;
v2->v3 adds only private job tables. Neither rewrites accepted artifacts/revisions
or fabricates historical jobs.
Version 1 is the tested synthetic predecessor layout, not a claim that an
earlier storage release or existing user project was migrated.
Each upgrade first creates a uniquely named `.migration-v<old>-<uuid>.sqlite` backup, reopens
and integrity-checks it, and calls mandatory `ensureDatabaseBackupDurable`.
Only then does a transaction alter schema/user_version. Failure retains the
original schema and backup; automatic destructive rollback is not attempted.
Restore a retained database backup to a newly provisioned local destination
with the service stopped, after verifying its version/integrity and matching
blob inventory. DesignIR schema migrations remain F02 operations creating new
revisions, not database history rewrites.

New backups carry `storageVersion: 3`, including original submissions, bounded
usage/effects, durable resource counters and exact stage history. Transport format
1 also accepts supported v2 metadata without inventing jobs. Restore validates
nested private shapes, submission digests, limits, receipt/owner/resource/stage
graph and protected inputs/outputs. All destination blobs still cross the current
mandatory publication barrier. Restore increments job versions/generations and
resource counters, turns live/uncertain executions into interrupted jobs with
quarantined reservations, and marks imported stages historical/recovery-needed.
It never resumes a transplanted lease or host staging capability.
The optional private `StoredJob.restoredLease: true` marks imported,
generation-invalidated lease history. It is valid only on interrupted jobs with
a retained lease and does not consume a destination worker slot: restore did not
launch that execution there. Resource quarantine and exact stopped-lease recovery
remain required, and the source store's slot is unaffected. Confirmed release
clears this marker; a fresh claim is a new locally counted execution. Existing
v3 rows without the marker conservatively count any retained lease, including
older restored histories, until trusted reconciliation. No shared Job schema,
SQLite layout/version, or legacy receipt contract changed for this distinction.

## Test evidence and remaining gates

RED was observed for the absent native binding, missing store implementation,
new references to corrupt existing blobs, object-scoped backup authorization,
duplicate-key transport, accessor-bearing revisions, unverified durability and
interrupted host publication. Tests then drove the corresponding fixes.
Follow-up review also reproduced caller-owned context mutation during an
authorization/durability await, queued identity/budget mutation, and regex stack
exhaustion on valid multi-megabyte base64; these now have passing regressions.
Frozen exact-reference authentication and shared branded context/reservation
compatibility are tested without mutating or freezing caller input.
Synthetic tests cover transactional CAS, idempotency/restart, stage/publication/
DB fault boundaries, abrupt SQLite process exit, approvals and explicit waivers,
retention and GC races, corrupt/missing bytes, migration backup/rollback,
scope/version rejection and a real temporary-file export/restore roundtrip.

Only owned temporary synthetic data is touched. Payloads under
`tests/fixtures/storage` are not Figma data, design fixtures, screenshots or
approved bundles. No user project GC, app/device manipulation, live model call
or existing OneDrive image use occurs.

Job-extension RED observations include the initially absent repository/tables,
lost interrupted-stage byte reservations, cancellation with outstanding effects,
unvalidated backup usage/resource graphs, missing stage enumeration, substituted
worker clocks, legacy job-ID appropriation, missing protected input edges,
orphan-only inputs, and lease expiry at heartbeat/progress transaction exit.
Permanent real temporary SQLite regressions cover those cases, atomic completion
fault points, revision/head rollback, ABA/quarantine, cancel/commit ordering,
operation-aware replay, restore invalidation, v1/v2 migration backup/rollback,
bounded scans, exact four-worker and 20,000-job admission limits, and zero paid
defaults. No uncontrolled race sleeps or user stores are used.

The retained-worker admission follow-up observed RED for worker/recovery
interruption with both unexpired and expired leases. Its regressions confirm
disjoint-resource claims stay blocked across reopen until trusted stop
acknowledgment, including workers with no resource keys. Restore tests distinguish
historical lease evidence from destination worker slots, preserve source occupancy
and resource quarantine, validate/roundtrip the private marker, and verify a new
post-recovery execution counts normally. Scoped verification: 117 storage unit
tests and four storage/native smoke tests, with build, typecheck and package lint.

`jobs-host.smoke.test.ts` composes fresh v3 SQLite with the actual trusted local
session authenticator, branded context snapshots, F02 canonical bytes and native
NTFS publication. It commits jobs, restarts the host, reuses operation-bound
historical outputs and restores under current destination barriers while
preserving legacy receipts. The native fixture's migration durability hook
explicitly fails outside fresh initialization: physical migration backup-file
durability integration remains unresolved, not replaced with a fake success.
Logical migration tests explicitly acknowledge simulated durability only.

Remaining integration gates: production F07 scheduler/F08 fresh execution and
recovery issuer; operation-specific completeness and actual-stop/effect policy;
physical database-backup durability; trusted evidence, retention and backup
authority; F05 permission-aware cache lookup composition.
Actual Windows power loss, hosted CI, public-registry restore, native
cross-platform distribution/macOS execution, and large-project performance
are not established by this lane.
