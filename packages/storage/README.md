# @design-studio/storage

F03 local storage core, package version 1.0.0. Shared artifact/revision/review
contracts remain `@design-studio/contracts` schema 1.0. The private SQLite schema
is version 2. No renderer, asset decoder, authorization issuer, job scheduler,
handoff compiler, live provider, or competing filesystem implementation is here.

**Production composition is gated, not implicitly ready.** The stable native
SQLite backend is exercised on Windows. The required real host publication
durability gate is not yet satisfied: F04's Node filesystem establishes
file-flushed atomic visibility, not power-loss-durable directory entries.
`ensurePublicationDurable` must fail when that capability is unavailable;
storage then commits **no** artifact/revision/job reference. Tests use an
explicit test-only durability acknowledgment. Neither those fakes nor SQLite
WAL tests establish filesystem power-loss safety.

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

| API | Behavior |
| --- | --- |
| `stage(bytes, context)` | Copies bounded bytes, requests `blobs/<lowercase SHA256>`, checks verbatim shared staging metadata. |
| `verify(reference, context)` | Resolves trusted project metadata and reads/checks actual length and SHA-256. |
| `commit(outputs, context)` | Implements shared `ArtifactStore`; publishes and verifies bytes, requires durability acknowledgment, then atomically stores artifacts, protected job references and `CommitReceipt`. |
| `commitRevision({branch, base, revision, outputs}, context)` | Adds immutable revision/parent/lock storage and branch CAS in the same receipt transaction. Null base initializes a new root only; otherwise both expected revision and exact quoted content-hash If-Match must match. |
| `getRevision`, `getHead`, `getReceipt` | Authorized snapshot/head/receipt access. Receipt retrieval/retry checks actual output bytes. |
| `appendReview`, `listReviews`, `applicableApproval` | Immutable actor-bound append chain; exact context and trusted evidence applicability, never manifest self-assertion. |
| `pin`, `releasePin`, `collectGarbage` | Policy-authorized bundle/job/legal/cache retention. Immutable revision/review/job receipt references are never cache-evicted. |
| `recover` | Reports orphan paths and corrupt/missing committed artifacts; discards only stages the mandatory trusted job policy proves abandoned. Unknown stages are retained explicitly. |
| `backup`, `restore` | Complete metadata/byte snapshot and verified transactional restoration into an empty provisioned store. |
| `encodeBackup`, `decodeBackup` | Bounded versioned UTF-8 JSON/base64 transport; duplicate keys, invalid encodings and unsupported shapes fail. Decoding does not authenticate approval provenance. |

`requestId` is the logical idempotency key for the current shared ArtifactStore
contract. Scope is project + trusted actor + `write` + requestId; payload
identity includes exact output metadata and revision/base/branch content.
Changing payload or job ID under that key conflicts. F07 must reuse both
requestId and jobId for retries; it must not replace them per network attempt.
Committed receipt wins cancellation/response-loss races. Stage/publish/transaction
failures leave at most staged/orphan bytes, never newly committed partial pointers.
Noncomplete host publication preserves interrupted/unavailable/cancelled outcomes
and error codes, and never invents a receipt.

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
must remain a typed failure. There is **no production success default**.
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
and SQLite integrity errors fail closed. The supported v1->v2 migration adds
the content-hash index without rewriting accepted artifacts/revisions.
Version 1 is the tested synthetic predecessor layout, not a claim that an
earlier storage release or existing user project was migrated.
It first creates a uniquely named `.migration-v1-<uuid>.sqlite` backup, reopens
and integrity-checks it, and calls mandatory `ensureDatabaseBackupDurable`.
Only then does a transaction alter schema/user_version. Failure retains the
original schema and backup; automatic destructive rollback is not attempted.
Restore a retained database backup to a newly provisioned local destination
with the service stopped, after verifying its version/integrity and matching
blob inventory. DesignIR schema migrations remain F02 operations creating new
revisions, not database history rewrites.

## Test evidence and remaining gates

RED was observed for the absent native binding, missing store implementation,
new references to corrupt existing blobs, object-scoped backup authorization,
duplicate-key transport, accessor-bearing revisions, unverified durability and
interrupted host publication. Tests then drove the corresponding fixes.
Synthetic tests cover transactional CAS, idempotency/restart, stage/publication/
DB fault boundaries, abrupt SQLite process exit, approvals and explicit waivers,
retention and GC races, corrupt/missing bytes, migration backup/rollback,
scope/version rejection and a real temporary-file export/restore roundtrip.

Only owned temporary synthetic data is touched. Payloads under
`tests/fixtures/storage` are not Figma data, design fixtures, screenshots or
approved bundles. No user project GC, app/device manipulation, live model call
or existing OneDrive image use occurs.

Remaining integration gates: F04 root/authority/maintenance composition and
directory-entry/backup-file durability; F02 canonical/semantic verifier;
trusted evidence, retention and backup authority; F07 staged-job ownership and
receipt/idempotency binding; F05 permission-aware cache lookup composition.
Actual Windows power loss, hosted CI, public-registry restore, native
cross-platform distribution/macOS execution, and large-project performance
are not established by this lane.
