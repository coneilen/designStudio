# @design-studio/project-host

## Version-6 retained-validation supplement

`reference-validation-policy.json` is separately inventory-bound by release
policy v6. It adds only `figma-reference-recovery-plan`, read-only grants,
deny-egress, zero calls/publications, and unchanged 30-second/25 MiB/raster
limits. All four older policy files/digests and namespaces remain immutable;
v1-v5 leases and structural objects cannot acquire this capability.

Retained artifact/output reads alone use a separate native root/child lease
brand. Current project/installation/principal authority supplies the exact
registered root, never a CLI path or SID. The root keeps the strict protected
owner/SYSTEM DACL; every intervening directory must have exactly its two
inherited allow grants (full-control mask, object/container inheritance, no
propagation exceptions). Unprotected leaves require the same exact inherited
file profile. Protected file leaves must satisfy the original strict predicate.
Protected subtrees, extra/foreign/deny/ambiguous ACEs, broken inheritance,
reparse points, aliases and multiply linked files are refused, not repaired.
Root, parent and leaf read pins deny write/delete sharing and remain owned
through body reads, final inventory, decoder join and proof assembly. Fresh
authority and full-chain native owner/DACL/identity checks bracket body reads.
Ordinary `pinRead`/`inspect`, installation/helper/runtime, manifest and immutable
database admission still require their original protected control profiles.
This host-created-descendant compatibility fix changes no policy JSON or any
of the five policy hashes, rights, byte limits, namespaces or installed releases;
the ACL predicate itself is source/inventory-bound, not a new hashed policy field.

`installation-native.test.ts` includes a cold-native retained-validation driver
which runs exactly the realistic application lineage/PNG case using real native
protected roots, actual host stage/publication and production descendant pins.
Its **new 60-second driver watchdog** covers cold startup, fixture history and
joined child closure; it does not increase the 30-second production operation,
the existing 60-second application fixture, or any older test's timeout.
The driver uses the owned-probe abort/actual-close path, bounded output and a
minimal child environment. Its test-only `DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE`
mode is not read by production code and cannot select a private path.
The exact existing native-file partition and ordinary portable run are unchanged.
The child independently asserts 5,698,575 physical bytes + 29 EOF reservations
= 5,698,604 charged private bytes, zero network/provider/vault use and no pins
remaining; ordinary strict reads of those inherited descendants still deny.

The native work owner pins the canonical main database and parent directory
for read with write/delete sharing denied. It rejects any WAL, SHM or rollback
journal before/after admission, including empty companions. Current installation,
principal, owner/DACL, ancestor/project authority, native file identity,
device/inode, single link, size and modification time are rechecked. It never
repairs security, copies/checkpoints a database or changes old project records.
The main metadata database itself is bounded to 25 MiB before SQLite integrity
inspection; its page reads are not misreported as metered artifact-body reads.
For this pinned immutable **database only**, ctime is not a content-equality
criterion: synthetic reads observed ctime-only drift with unchanged data,
identity, size and mtime; its cause is unknown. Ordinary artifact ctime/link
checks are unchanged. Native tests must independently prove writes, truncate,
delete, rename and live-writer admission are denied and source bytes preserved.

The v6 command explicitly initializes the exact pinned SQLite addon in a cold
main-thread command process, before any other addon load. A synchronous,
no-await environment scope enables URI parsing during native require and restores
the previous process environment even on failure. **SQLite URI parsing remains
process-global thereafter**; environment restoration does not undo it. Unknown
prior loads, binding aliases/identity changes and Worker initialization deny.
Ordinary store paths still reject caller URIs and require native attestation.
The only new URI is generated internally from the pinned canonical database
path with fixed `mode=ro&immutable=1`. No existing WAL is ignored.

All native pins, including fresh recheck pins whose close fails, remain owned.
Close attempts independent pins, retains failures and releases work authority
only after actual closure. This capability does not adopt historical staging
ownership or authorize an offline recovery write.

## Separate native credential capture profile

`figma-capture-v1` is a closed Windows x64 profile distinct from the fixture
release. Its exact canonical policy authorizes only `capture` / `pat-helper`
roles and native project/credential/selected-frame commands. API access is fixed
to `https://api.figma.com`, with four calls and an original 30-second work deadline;
the independent image-origin list remains empty. Version-1 fixture metadata, catalog policy and `installations` namespace
are unchanged. Capture releases use version-2 policy and `capture-releases`;
wrong-profile roles fail before admission.

Candidate tooling accepts
`--profile figma-capture-v1 --workspace <build> --node-root <pinned runtime> --sqlite-binding <approved binding> --output <NEW candidate>`.
It reuses physical dependency copying, inventory, pinned Node, bootstrap preflight,
native installation publication and resolution guards. No fixture catalog/browser
is repurposed. Packaging refuses until the actual capture CLI and PAT-helper
compiled roles exist; provisioning alone is not a shipped input command.
Installation still requires independent approval of BOTH exact payload and
bootstrap digests. No capture candidate or installation is approved implicitly.
Capture roles include the capture/import workspace packages and the pinned
SQLite binding. This changed policy selects a new independently approved
namespace; it does not upgrade or adopt the old credential-only project profile.

Recovery-capable candidates retain those exact base capture-policy bytes and
add `capture-recovery-policy.json`, a separately closed supplement bound to the
base digest. Version-3 trusted release metadata binds its exact digest and the
payload inventory must include it. Fixture/version-1 and existing capture/
version-2 validation remain supported for their original roles; neither can
authorize `figma-recover`. Recovery admission is private state on the actually
verified installation lease, not a JSON property or caller configuration.
The CLI checks it before opening a project for recovery. No new role, namespace
lookup, migration, project copy, credential reference or old-job authority
override is introduced. Independently approved new bootstrap/payload inventories
are still required; changing packaging source does not approve or install them.

Diagnostic-capable version-5 release metadata additionally binds
`capture-diagnostic-policy.json` and its exact digest in the verified payload
inventory. Version-2/3/4 leases cannot mint diagnostic authority, even when new
command code is present. The original base, recovery and reference policy bytes,
project namespaces and credential identities are unchanged. This separate
supplement permits only one freshly consented diagnostic successor of the exact
completed HTTP200/INVALID_INPUT/no-PNG reference receipt; it does not reset the
original job or authorize a live invocation merely by being installed.

Reference-capable version-4 release metadata additionally binds the exact
`capture-reference-policy.json` inventory member. Both historical base and
recovery policy bytes, namespaces, credential references and old job identities
remain unchanged. Version-1/2/3 or structural caller-created leases cannot
authorize reference actions. The separate supplement permits only
`https://figma-alpha-api.s3.us-west-2.amazonaws.com`, never a wildcard or a
caller-provided URL. Reference authority grants no credential use and does not
read credential readiness, journal fingerprints or the vault.

Reference approval is offline, exact-proof-bound and expires after at most five
minutes (earlier when the stored URL has a recognized earlier expiry). A separate
explicit invocation admits one deterministic acquisition job with one GET, one
DNS lookup and one original absolute deadline of at most 30 seconds. The approval
expiry caps that deadline. A consumed attempt is never refreshed by a new command,
process, request ID or URL refresh. Packaging source now describes this additional
capability; no candidate, installation, origin approval or live download is
authorized by that source change.

`verifyCaptureInstallation` creates a process-owned live lease, not a structural
JSON grant. `openCaptureProject(lease)` creates one new app-ID project under the
native KnownFolder `DesignStudio\capture-projects` namespace; passing its logical
ID later reopens only its exact principal/profile/native-identity registration.
No path adoption, fixture binding, environment root or caller trust Boolean is
accepted. Native file/ACL primitives and registry checks are shared with the
fixture implementation. The current-user boundary is not a same-user attacker
sandbox.

Each project holds an exclusive data-read handle on its private credential lock
file, preventing overlapping app processes. Its nonsecret journal has at most
1024 canonical, chained, no-replace records of at most 8 KiB each, flushed by the
native publication primitive. Records contain only exact owned reference,
pending/ready/absent/uncertain state and declared expiry/scopes. Torn or gapped
history refuses further work and requires explicit reconciliation; it is never
silently adopted, rewritten or filled with plaintext credentials.

Credential admission rejects impossible capacity from the exact bounded filename
inventory before reading record bodies: setup/update require eight slots and no
action is admitted at full capacity. If capacity might allow the action, the
entire chained history is still authenticated before any vault access. Cancellation
interrupts this read-only admission without skipping verification on a successful
path or changing the original native operation deadline.

### Capacity and durable cleanup reserve

The total remains **1024 records**, with no rollover, pruning, second index or
in-memory-only reservation. The closed capture policy names this limit and the
eight-slot normal-operation reserve. Admission reads and validates durable
history under the project's exclusive lock before any vault lookup:

| Action/state | Admission and append behavior |
|---|---|
| Setup/update | Require eight free slots before any backend call; intent remains durable before mutation. |
| Status | Require one free slot, not eight. Unchanged ready/absent observations do not append; failed reads append nothing and never mean absent. Pending setup/update can reconcile with one terminal record. |
| New removal | Require two free slots: pending-remove plus confirmed absence. |
| Pending-remove retry | Require one free terminal slot. Every retry is a new explicit confirmed action with current authority and exact-entry read. Duplicate intent and ambiguous-delete metadata retain pending-remove without appending. No automatic retry. |
| Status of pending-remove | At fewer than eight free slots, observing present retains the removal intent. Observing absent appends the terminal absence record. At normal capacity, an authorized present observation may reconcile to ready. |
| Confirmed terminal absence | A later acknowledgement/cleanup error remains an interrupted operation, but does not overwrite durable observed absence with uncertain state. |
| Full/malformed history | Reject before backend access. No assumption that an old exhausted history can be repaired by deleting credentials or erasing evidence. |

Why eight slots suffice: an admitted setup/update may append intent, a terminal
record whose acknowledgement fails, and then uncertain state (three slots).
Restart reconciliation uses one slot, leaving at least four. Removal intent
uses one; any number of separately authorized ambiguous deletions/present-status
observations consume zero additional slots; confirmed absence uses one. At least
two slots remain in this worst case. A crash leaving only setup/update intent
uses less space and is still reconcilable; the eight-slot rule never blocks its
status recovery. The append policy also enforces admission for new intent writes,
not only the facade's preflight.

This is a durable **state history**, not a counter/audit of every attempted action:
repeated identical status, pending-removal retry and equivalent uncertainty states
are deliberately deduplicated. Present status during low-capacity pending removal
does not claim that the pending intent has been cleared. The fixed reference and
current native ownership/one-use action authority are revalidated on every call.

`openCaptureCredentials(project)` admits only an actual live native capture
binding. It composes the fixed-entry adapter and internal one-use action authority
with current native principal checks, an exact-reference confirmation and a
fresh at-most-30-second admin context. No admin operation is added to public
Operation/Job vocabulary. Merely opening the facade does not construct or read
a vault entry. `status` is an explicit exact-entry credential read; setup never
overwrites, and update/remove need their separately confirmed target. All vault
actions still require independent user authorization.

Active credential owners prevent project closure, and project owners prevent
installation release. Startup cleanup failures retain the installation borrow
and return a close-only `CaptureStartupCleanupRequired` for retry. The private
composition imports the already-built host implementation inside the declared
workspace dependency; no public host admin constructor/loader override is added.
Default tests use only exact owned TEMP roots and synthetic native vault methods. Most
candidate fixtures are inert; the explicitly named no-UI process probe uses the
approved pinned Node bytes with a synthetic lifecycle peer. Neither establishes
live vault or dialog behavior.

`acquireCaptureWork(project)` accepts only the process's actual registry-owned
project. Its work loan excludes simultaneous credential/dialog work. Fixed-scope
native authority is issued internally using the current principal, project,
installed policy, original deadline and declared credential expiry. It accepts
neither an authority callback nor caller grants. Aborting an issued context's
own or parent signal revokes that exact authorization, detaches its listeners
and removes it from the unchanged 128-live-context limit. Scheduler observers
are retired after their turn, not retained until the original deadline;
unrelated/active worker contexts are not revoked by observer retirement.
`credentials()` reads only the
fixed app-owned entry through ScopedCredentialStore; no lookup occurs on import
or construction. Original readers remain held through actual settlement, and
late buffers are zeroed before close can release the native loan.

## Fixed owned PAT dialog role

The capture role inventory names `packages\cli\dist\capture-main.js` and
`packages\project-host\dist\pat-dialog-helper.js`. The helper/controller live in
this package to keep capture-project admission in the same runtime registry
instance; they do not import a second physical project registry as proof.
`startCapturePatDialog` accepts only an actual live CaptureProject and acquires
its private helper-owner count synchronously before async admission/spawn.
Project close cannot succeed while that owner or a credential owner is active.

The parent launches only the pinned Node and exact fixed helper path, with
stdin/stdout/stderr ignored and one inherited overlapped fd3. It accepts no
caller executable, module, environment, action callback, root or transport.
The helper's small prejoin code consumes bounded INIT and joins a one-process
Job before expensive installation verification or UI imports. Its fixed
installed path derives the bootstrap root; native verification and resolution
guards are established before the dynamically imported UI implementation can
receive START. Parent verifies expected PID membership before START, holds its
installation/project leases, and does not trust a callback or JSON grant.

The private host Job bridge is shared with renderer-host through an internal
compatibility re-export. Its only profiles are renderer (64 processes, unchanged)
and PAT dialog (one process), with the original kill-on-close/non-breakaway
flags and native membership checks. This is not a generic public launcher.
Tests which load that native Job bridge require Windows **x64**, including the
controller tests whose spawned process is mocked. Windows arm64 is not claimed
as a verified Job ABI. Pure mocked deadline/protocol tests remain portable.

The binary codec permits only eight fixed message kinds, a 32-byte per-run nonce,
sequence 0/1, at most eight frames per direction, a two-frame bounded queue,
at most 256 control bytes and at most 4096 accepted bytes. Partial/read/write
buffers are owned and zeroed; outgoing frames remain borrowed until the actual
write callback settles. JSON/string token framing is not used. Normal cleanup
requires CLOSED/scrub evidence, child `close` and empty Job membership; forced
kill or an unconfirmed scrub cannot produce a credential result. Retained
cleanup is explicit and keeps the project helper count until observed quiescence.

CLOSED is provisional, not a terminal transcript proof. Before delivery the
controller requires actual peer EOF with no queued extra frames, partial header/
body or prior receive failure, then actual child close and empty Job membership.
The terminal validation state survives local disposal; closing a stream cannot
turn an invalid transcript into a valid one. Extra bytes after CLOSED fail even
if the first receipt claimed successful cleanup. Staged credential bytes are
zeroed on violation. Resource owners can be released after proven process/pipe
quiescence without delivering a credential or reporting scrub-confirmed success
for a bad protocol.

Five-second startup/close bounds and five-minute input time are distinct from
admin time and never silently refreshed. The no-UI process probe exercises
real Job membership, private bytes and observed child exit with a synthetic
peer, not the real UI or full installed-helper startup cost.

Separately authorized supervised evidence on the corrected native role reached
READY using a fresh owned TEMP capture closure/project. The user confirmed
masked dummy text, multiline-paste rejection and Cancel; the binary transcript
reported ERROR 1/CLOSED 3 with confirmed scrub, normal child exit and empty Job.
No forced termination occurred, and identity-checked TEMP cleanup completed.
Only the approved copied KnownFolder substitution preceded the test inventories;
helper/controller/UI code and fixed argv/limits were unchanged. This is one
observed dummy cancellation path, not all native paths or repeatable production
latency. Human observations are separate from machine evidence.

The fixed helper delegates only its already-authorized START to private
`pat-dialog-input`; that module imports the real collector directly, with no
production callback override. Input expiry aborts input without poisoning a
clean binary channel. A control wait may then span only the remaining original
deadline-plus-five-second terminal budget. The controller likewise transitions
its input wait to one fixed terminal deadline on cancellation/error/acceptance;
ERROR, CLOSED, peer EOF and process exit share that allowance, never a renewed
five seconds per frame. Pre-deadline cancellation retains its cause, and accepted
bytes cannot be delivered after the original input deadline.

Scrub confirmation still requires genuine collector cleanup, valid terminal
transcript/EOF, normal helper exit and empty Job. Failed cleanup, partial/foreign
frames, missing EOF or abnormal/forced exit remain unconfirmed. A child that has
not actually exited keeps its owner/close retry even after the wait bound.
Fake-clock tests exercise both endpoint orders, START-delivery offset, near-
deadline cancellation, late accepted-byte zeroing and hung teardown without
native UI. The supervised READY-but-interrupted attempt remains failed evidence;
no actual Win32 timeout or user behavior success is inferred from those tests.
For otherwise valid cancel/deadline receipts, the first locally recorded stop
cause takes precedence; a later helper deadline cannot relabel an earlier
manual cancellation. Protocol, transport and cleanup failures still override
ordinary cancellation and never become confirmed cleanup through this rule.

An independently authorized isolated Windows keyring check also passed actual
synthetic byte write/read equality/delete/absence through the corrected pinned
adapter. The measured null/numeric-array declaration mismatches and earlier
failed attempts are retained as private evidence; no test entry remains. That
backend check used generated test scope, not a production native-project grant
or full installed enrollment. Real PAT setup, real source capture, exact
production release approval and deployment remain unperformed and gated. No
generated test service/account names or private artifacts are repository data.

Narrow Windows **fresh fixture-catalog projects only** provisioning for F08.
This is not arbitrary directory adoption, an ACL repair service, an HTTP setup
endpoint, a general filesystem sandbox, or a complete application.

The separately approved offline installation mechanism is described below.
It does not turn a repository checkout into an approved executable release.

## Trusted composition

```ts
const registry = await WindowsFixtureProjects.open({
  applicationId: "design-studio",
  catalogIdentity: reviewedManifestSha256,
  catalogBytes: originalShippedManifestBytes,
  trustedImmutableInstallation: true,
  fixtures: [{
    projectId: "project_synthetic",
    artifactRootId: "foundation_artifacts",
    permissionScope: "foundation_fixture_owner_v1",
  }],
});
const principal = registry.currentPrincipal();
// Only the explicit local CLI "fixtures init" entrypoint calls create.
const binding = await registry.createFixtureProject({
  projectId: "project_synthetic",
  artifactRootId: "foundation_artifacts",
  permissionScope: "foundation_fixture_owner_v1",
});
await binding.attestLocalDatabase(binding.paths.database, binding.scope);
```

`FixtureProjectOptions` is installed, trusted constructor policy, never request
JSON. The package copies bounded, non-shared `Uint8Array` catalog bytes **before**
hashing and snapshots/freeze-copies the scope list before its first await. The
SHA-256 must match the installed lowercase hexadecimal constant. It does not
parse or reserialize the manifest, establish its provenance from that hash
alone, or inspect referenced assets. F08 independently reads the original
shipped manifest and verifies its reviewed identity; F08/F05 verify referenced
bytes before use.

`trustedImmutableInstallation: true` records an **explicit precondition**, not
an attestation of the full installed executable/module/native-binding closure.
That closure and private roots must not have untrusted concurrent writers.
This shares the host's trusted-writer boundary: hostile same-principal code,
administrators, compromised installed code and malicious kernel/filesystem
providers are outside the guarantee.

`CurrentPrincipal` is an opaque, instance-owned, frozen result of native token
inspection. Its stable `actorId` is `windows-` plus SHA-256 of the actual SID.
It is not an `AuthorizationContext`, grant, token handle, client SID, or
serializable authentication proof. Caller-supplied IDs/grants never establish
identity. F08 must bind its own authorization/session policy to this result.

## API and lifetime

`WindowsFixtureProjects.open(options)` returns `Promise<FixtureProjectRegistry>`.
It obtains native KnownFolder/token evidence and opens/verifies the fixed
application registry namespace. Missing application namespace directories may
be created privately; **no project is implicitly created**.

| Method / property | Contract |
| --- | --- |
| `registry.currentPrincipal()` | Synchronous native-principal checkpoint and opaque current-principal result. |
| `registry.createFixtureProject(scope)` | Explicit, asynchronous NEW project creation; exact installed `FixtureScope` only. Existing reservations conflict, even if incomplete. |
| `registry.openFixtureProject(projectId)` | Asynchronous verification of an already committed registration; unknown or incomplete projects fail. No creation/adoption of a project, SQLite initialization, or record rewrite. |
| `binding.scope`, `binding.catalogIdentity`, `binding.principal` | Frozen exact installed scope/catalog/native actor binding. |
| `binding.paths` | Frozen exact `database`, `artifacts`, `inputs`, `outputs`, `temp` paths for trusted application composition. |
| `binding.attestLocalDatabase(path, scope)` | Mandatory `StorageOptions`-compatible async hook; exact path and all three scope fields, then current native/registry verification. Resolves `void`, never a caller-supplied boolean. |
| `binding.recheck()` | Async principal, ancestor/root/file identities, protected owner/DACL, local NTFS, reparse/link and immutable record checks. |
| `binding.close()`, `registry.close()` | Async, idempotent checked native handle release. Registry close also closes its bindings. Never delete data. |

Use-after-close and close-during-recheck fail explicitly. Registry create/open/
close operations serialize; binding rechecks detect concurrent closure before
returning. Native directory/file handles deny delete sharing but permit the
reads/writes needed by SQLite. The database's own exclusive writer lock and
application/schema/project checks remain F03's responsibility.
Close attempts every owned release even when one fails, retains the failure,
blocks further use, and permits a close-only retry for remaining releases.

A child process receives **only the logical project ID** and independently
loads installed policy and calls `openFixtureProject`. No API accepts a
serialized principal/binding/attestation. HTTP must never provision. Catalog
hash changes select a separate namespace, not implicit adoption or migration.

## Native boundary and persistence

The lazy bridge uses exact optional `koffi` **3.2.1** and the existing pinned
platform-prebuild convention. Non-Windows/non-64-bit hosts and missing prebuilds
are explicit unsupported/unavailable failures; no fallback, scripts, cnoke,
compiler, elevation or global settings are used.

Native calls are synchronous and use the immediate calling-thread
`GetLastError`, BOOL/HANDLE sentinels, HRESULT or returned Win32 status as
appropriate. Pointer/security-attributes/token-user/file-information/ACL/ACE/
rename layouts are checked. SID strings and security descriptors use checked
`LocalFree`, KnownFolder strings use `CoTaskMemFree`, real token/file handles
use checked `CloseHandle`; pseudo process/thread handles are never closed.
Original failures are retained when operation and resource release both fail.

- `OpenProcessToken(TOKEN_QUERY)` / `GetTokenInformation(TokenUser)` obtain the
  actual SID. `OpenThreadToken` distinguishes `ERROR_NO_TOKEN`; every actual
  impersonation token is refused, including same-SID tokens whose restrictions
  could differ. No impersonation or privilege changes, account lookup, external
  directory query, environment identity, or credentials are used.
- `SHGetKnownFolderPath(FOLDERID_LocalAppData)` locates the root; no environment
  path is trusted. The fixed namespace is
  `LocalAppData\DesignStudio\fixtures\<full-catalog-digest-base64url>`.
  Logical project IDs map to full SHA-256/base64url reservation names, then
  generated UUID project children. Raw client IDs never become path segments.
- Every owned directory uses `CreateDirectoryW` with explicit owner/current-SID
  and SYSTEM full-control protected DACL **at creation**. Directory ACEs
  propagate only those trustees to future files, including SQLite WAL/SHM.
  Database/record files use explicit protected descriptors and `CREATE_NEW`.
  There is no mkdir-then-repair window. Existing namespace directories must
  already satisfy the policy; no foreign/null/permissive ACL is repaired.
- Native open/query verifies final path, owner, protected non-null exact two-ACE
  DACL, expected kind, no reparse point, single file link, fixed local media and
  NTFS. All ancestors are inspected and retained; private ancestors are
  rechecked before creation/open and during binding recheck. No parent ACL
  modification is attempted.
- Atomic directory reservation excludes concurrent same-ID creators. The
  original zero-byte database identity, generated role-root identities,
  ancestor identities, native principal, catalog and exact scope go into a
  bounded private record. A native write-through `CREATE_NEW` pending file,
  `WriteFile`, preflush, same-handle no-replace `FileRenameInfo` and postflush
  publish that immutable canonical record. No overwrite or portable-link
  success fallback is used.

Missing/torn/noncanonical/conflicting registrations or incomplete reservations
require action. No filenames/hashes are used to reconstruct unknown state.
Creation failure leaves its exact partial reservation intact; a subsequent
create conflicts. Explicit reopen succeeds only if a full valid committed
record is already present, including after an uncertain postpublication error.
There is no public cleanup, delete, ACL-change, repair or arbitrary-path API.

The original database file/volume identity, not an empty-file content digest,
establishes fresh-file provenance. Legitimate SQLite writes can change bytes
without losing that identity; foreign replacement SQL cannot acquire it.
Registration authority relies on the private/trusted-writer boundary, not a
cryptographic defense against same-user rewriting of the entire registry.

Publication evidence is **documented NTFS write-through OS requests, not
power-cut tested**. Newly created parent-directory persistence, hardware cache
behavior and physical durability are not established. This package does **not**
solve old-schema migration-backup durability; that remains genuinely gated.

Bounds: catalog at most 1 MiB; 1..64 configured scopes; 1..128 ASCII
`[A-Za-z0-9][A-Za-z0-9._-]*` identifier characters; at most 64 live bindings;
64 KiB registration records with a 65,537-byte bounded overrun probe; at most
32 KnownFolder path components; final database path at most 240 UTF-16 units
to leave SQLite sidecar/path headroom. Native calls are cooperative synchronous
operations, not hard-real-time or forcibly cancellable OS calls.

## Evidence and scoped commands

Build before typecheck; run focused tests from the repository root:

```powershell
pnpm --filter @design-studio/project-host... build
pnpm typecheck
pnpm exec vitest run --project unit packages\project-host\tests
pnpm exec vitest run --project smoke packages\project-host\tests
pnpm exec biome check packages\project-host
```

Windows x64 / Node 24.21.0 / pnpm 11.26.0 / TypeScript 7.0.2 / Vitest
4.1.11 were used, with root `maxWorkers: 2`, strict types and no `skipLibCheck`.
The prebuilt Koffi loaded with scripts disabled. Retain Koffi's upstream license
and native dependency notices when distributing.

The initial test suite was observed RED for the missing implementation. Actual
native execution then exposed a KnownFolder GUID byte-order error and long-path
creation/SQLite limits, corrected before GREEN. Separate observed RED/GREEN
regressions cover private ancestor ACL changes before reopen/create, noncanonical
record edits, and shared-memory catalog refusal.
An injected close-result regression separately failed with 18 outstanding
tracked leases, then passed after close drained every binding and ancestor
instead of stopping at the first failure.

Real owned Windows tests exercise actual token and KnownFolder observations,
protected ACL-at-creation/query, registry no-replace and competing child-process
creation, independent child reopen/re-attestation, Node SQLite WAL writes while
retaining original DB identity, unknown/foreign/missing/tampered registrations,
same-byte native-identity replacement, hard links, junctions, permissive/null
DACLs, ancestor ACL changes, exact scope/path denial, bounds and close races.
The SQLite test uses Node's built-in SQLite, not evidence of F03's complete
storage/application integration.

Provisioning tests replace **only the internal KnownFolder return** with a
fresh exact `mkdtemp` namespace. The production package has no folder override
or test entrypoint. Separate observation exercises the real KnownFolder API
without creating anything there. Test cleanup verifies that generated root's
native Node file identity, real path and non-reparse directory kind, closes
bindings, and removes only that exact namespace. Native ACL tampering is
test-only and restricted to its newly generated descendants. No production
DesignStudio store, user project, vault, device, Figma or credential is accessed.

Labeled mock tests cover missing prebuild, unsupported host, creation failure,
and combined verification/release failure. They are edge/control-flow evidence,
**not native proof**. The real HANDLE-count test warms token/KnownFolder and
fixture calls, then repeats 20 token/KnownFolder/open/recheck/conflict/close
cycles with a tolerance of two handles. Cold KnownFolder initialization
allocates cached process resources; this establishes bounded repeated-call
behavior, not zero cold-start allocation. No real `CloseHandle` failure was
observed; the failure test throws only after actually closing its owned handle.
One isolated verbose measurement recorded cold **184**, warmed **228**, and
after 20 cycles **228** handles (tolerance **2**). An earlier un-warmed
measurement was 203 to 228 and correctly failed its 205 threshold; it included
KnownFolder's first-call cache initialization and was not evidence of a
per-operation leak.
The final full unit run recorded 203 / 228 / 228 with the same tolerance.
The focused suite contains 24 passing unit tests and a built-package export
smoke check that excludes native/path/test factories from the public surface.

The lock importer was generated in a clean manifest-only scratch workspace
using the approved canonical mirror, then frozen-restored with scripts disabled.
Only ten importer lines are added; a byte-for-byte comparison (normalizing
newlines) verified all existing package/integrity/snapshot records unchanged.
Windows arm64, other operating systems, non-NTFS volumes, live production-root
provisioning, power-cut recovery and full application integration are unverified.

## Offline fixture installation mechanism

**No real release is approved by this implementation.** The user selected the
offline release model and requires approval of the exact final release before
installation. There is no signing infrastructure, automatic approval receipt,
development-worktree success switch or successful production test callback.
Ordinary repository calls to `verifyFixtureInstallation()` return
`ACTION_REQUIRED`. The packager refuses before allocating output when actual
integrated application/CLI build entries are absent.

The user's initial trust decision covers the complete selected bootstrap:
pinned Windows x64 Node 24.21.0 executable and original LICENSE, bootstrap scripts, native bridge,
all bootstrap dependencies, inventories and policy. Executing an untrusted
bootstrap to ask whether it is trusted is **not safe**. Its self-checks establish
integrity relative to the externally selected bytes, not provenance. Local
`--approve-*` flags are explicit release-selection confirmations, not evidence
that somebody reviewed the bytes, and are never accepted from HTTP or job data.

### Candidate creation, approval, installation and launch

From the final **integrated, built** source and already acquired, independently
reviewed runtime/browser/SQLite artifacts:

```powershell
pnpm --filter @design-studio/project-host build
node packages\project-host\scripts\package-candidate.mjs `
  --workspace D:\approved-integrated-build `
  --node-root D:\approved-artifacts\node-v24.21.0-win-x64 `
  --browser-root D:\approved-artifacts\renderer-browser-1.63.0 `
  --sqlite-binding D:\approved-artifacts\better_sqlite3.node `
  --output D:\new-offline-candidate
```

The tool neither downloads nor installs dependencies, runs package scripts,
compiles native code, updates OS settings, nor executes candidate source
executables. The fixed runtime profile selects **only `node.exe` and `LICENSE`**,
with exact reviewed byte lengths and SHA-256 pins; the running 24.21.0 executable
must match the same pin. Runtime source roots/files must be exact canonical local
physical paths, without junction/symlink/case aliases or multiply-linked files.
Both files are checked before allocating candidate output, then copied to new
single-link files and rechecked against the fixed pins and exact two-file tree.
There is no caller-selectable file list, environment switch or CLI override.
Bundled npm, Corepack and setup wrappers remain available in development inputs
but are not shipped. The SQLite addon is checked against the existing ABI137 binary
pin, and all 299 Chromium r1243 inventory files against the reviewed renderer
inventory. Those integrity checks do not replace release selection.

Output is `payload/`, `bootstrap/`, `payload-inventory.json` and
`bootstrap-inventory.json`. Candidate metadata prints both SHA-256 identities
and `candidate-awaiting-user-release-approval`; it is **not an approval**.
Present both inventories, identities, upstream provenance/notices and remaining
limitations to the user after the actual F08 integration. Only after that exact
user approval would the user execute, from the independently trusted candidate:

```powershell
.\bootstrap\runtime\node.exe .\bootstrap\install.mjs `
  --approve-manifest <user-approved-payload-inventory-sha256> `
  --approve-bootstrap <user-approved-bootstrap-inventory-sha256>
```

This command was **not executed against a live installation namespace** during
development. Its engine was exercised only inside verified temporary test roots.
The installer prints the fixed installed bootstrap entry; run it with its
adjacent `runtime\node.exe`, the literal role `cli`, and ordinary F08 arguments.
The browser worker continues using renderer-host's reviewed source-pinned
bootstrap, Job join, nonce/frame protocol and observed cleanup. No raw browser
spawn or `NODE_OPTIONS` workaround replaces that boundary.

The payload contains compiled workspace modules and their package metadata,
contract JSON schemas, renderer-host's required `src/bootstrap.mjs`, original
fixture catalog/assets/license, native SQLite binding, complete public browser
inventory, and complete transitive package contents/notices. Package-manager
links are resolved during **candidate assembly**, then materialized as new
physical files, never shipped as pnpm junctions/symlinks. Conflicting versions
or source resolutions for one flat package name fail closed rather than
silently select an alternative. Source-store hardlinks may be read as candidate
inputs; every destination is a new single-link file and is rehashed.
Workspace tests/caches/sources not part of the reviewed runtime file set are
not shipped. The tool does not automatically approve new source versions.

Outer bootstrap inventory covers **every** bootstrap file, including scripts,
runtime, policy and the inner module inventory. It excludes only itself, which
resides alongside the bootstrap directory and whose exact hash the user selects.
There is no circular self-hash. A builtin-only `preflight.mjs` embeds the hash of
`bootstrap-modules.json`, covering the physical bootstrap dependency tree. That
inner inventory intentionally excludes entry/preflight scripts and runtime;
all remain covered by the **outer user approval**. Preflight checks module bytes,
physical paths and exact inventory before registering synchronous Node hooks and
only then importing project-host/host/Koffi. This early byte check is within the
trusted-bootstrap/private-writer boundary, not hostile-writer race containment.

### Private installation and the public browser exception

Installation uses native KnownFolder:
`LocalAppData\DesignStudio\installations\<combined-inventory-digest-base64url>\<generated-UUID>`.
There is no production destination override or directory adoption.
Atomic private reservation excludes same-release races; an unknown partial
reservation is retained and action-required, never overwritten, repaired or
automatically removed. Exact source inventory is verified/pinned before writes.
Files stream through `CREATE_NEW`, are flushed, and are finalized only through
handles returned for that exact new installer-owned entry. Existing arbitrary
paths cannot obtain a finalization handle.

Final protected DACLs grant current principal **read/execute** (`0x1200a9`) and
SYSTEM full control; writable creation handles close before attestation.
Only `payload\browser` and its exact approved Chromium descendants additionally
grant BUILTIN\Users read/execute. The user separately approved this public-binary
reader exception after the real sandbox differential. **No Users write grant**
is present. Node, JS/modules/addons, bootstrap policy, catalog, project databases,
profiles, credentials and temporary output remain private. Browser contents must
remain the approved public binaries/resources/notices, never application data.
Native reattestation rejects extra trustees or reader grants outside that subtree.

The current user owns the files and can change a DACL. Thus this is **not**
immutability against hostile same-user code or administrators. Exact inventory,
protected ACLs, native path/identity checks, trusted installed writers and retained
`FILE_SHARE_READ` handles provide the declared boundary. File pins deny new
write/delete sharing and are compatible with actual Node/addon/browser loading;
directory handles do not magically freeze all namespace mutations. Arbitrary
hostile trusted code could bypass JS hooks or call native APIs and is not sandboxed.
Windows system DLLs/kernel/platform remain an explicit OS trust boundary.

After full destination verification a protected no-replace write-through record
binds native principal, generated root identity and both inventories. Reopen
checks exact canonical metadata, file bytes/lengths, all identities/ACLs and
ancestor paths/local NTFS; extra, missing, reparse, hardlinked or altered entries
fail. NTFS request evidence is not power-cut/hardware/new-parent durability proof.
No migration-backup durability is conferred by installation.

### Public installation API and teardown

```ts
const installation = await verifyFixtureInstallation();
const guard = registerFixtureInstallationGuards(installation);
// Only now dynamically import application code / start work.
// Await actual worker.close(), child exit and Job-empty evidence first.
guard.close();
await installation.close();
```

`FixtureInstallationLease` exposes readonly `identity` and frozen
`paths: {node, bootstrapEntry, cliEntry, rendererEntry, fixtureCatalogRoot,
browserRoot, sqliteBinding}`, plus asynchronous `recheck()` and `close()`.
The public verifier takes **no paths, IDs, hashes, booleans or JSON proof**.
It operates only in the selected pinned bootstrap runtime, with the module's
exact fixed installed placement and native KnownFolder registration.
Extra Node command-line loaders/flags and `NODE_OPTIONS`/`NODE_PATH` are refused.
`registerFixtureInstallationGuards` accepts only this process's live
WeakMap-owned verified lease; serialization/forgery cannot resurrect one.

The synchronous resolver covers ESM, CommonJS `require` and `createRequire`.
Loaded files must be exact inventoried paths; builtins are the explicit runtime
boundary. Bare package resolution must stay under the selected physical
bootstrap or payload package root, never global or ancestor fallback.
The broader native-verified guard is registered **before** the restrictive
preflight guard retires, with no unguarded import window.
Direct native `dlopen`, browser resources and OS image dependencies require the
separate complete native file inventory/pins; JS hooks alone do not attest them.

The parent holds its lease while children/jobs run. Each child independently
verifies the installed release and owns its own pins. The fixed renderer entry
must import only the reviewed verifier TCB, verify/register, and then dynamically
import the rendering implementation after the existing host bootstrap has joined
the Job. Guard deregistration is explicit; lease close refuses live guards.
Guard/lease close must follow real quiescence, never a callback timeout.
The CLI outer bootstrap deliberately retains its final native pins for the
entire process lifetime; it does not infer quiescence from import completion or
Node's `beforeExit`. The exit hook deregisters the outer guard, and OS process
teardown releases the final pins. F08 still must observe child/job termination
before deciding to exit. Forced process death releases OS handles; it is not
evidence that some uncontained descendant stopped.
Cleanup attempts every owned handle, preserves original failures, blocks reuse
after failed close, and permits close-only retry. No installation data is deleted.

Bounds: combined inventories at most 20,000 files and 2 GiB, each file at most
512 MiB, each manifest at most 8 MiB, canonical ASCII relative paths at most
220 characters, streamed reads/writes in 1 MiB chunks and bounded directory
enumeration (40,000 entries). Unsupported shapes/version conflicts fail rather
than widen resolution. Operations are synchronous native checkpoints, not
hard-real-time cancellation. Large installation verification can take seconds;
F08 startup budgets must account for the complete closure.

### Installation evidence and remaining gate

Observed RED/GREEN: absent native finalizer and manifest/resolver primitives;
outside ESM/CommonJS/createRequire resolution denied by exact Node 24.21.0;
hostile preflight dependency/inner-inventory edits and omitted/extra files;
source-pin leak on destination-create failure (one leaked pin before fix);
empty-directory inventory mismatch; installed bootstrap trailing-separator
comparison; installation close failure draining and close-only retry.
Synthetic engine tests cover dual identity rejection, seal/reopen, record
tamper, unexpected private-path DACL, incomplete reservation and guards/lifetime.
They are labeled **synthetic**, not release provenance or full application proof.

The complete candidate workflow was exercised with real physical dependencies,
full copied Node runtime, pinned SQLite addon and 299-file browser inventory;
only F08 CLI/application entries were synthetic and only native KnownFolder
return was replaced to the exact freshly generated TEMP namespace. It packaged,
installed, sealed and launched a separate copied Node child which independently
verified all native identities/ACLs/inventories, registered guards and rechecked.
No actual F08 release or production approval was fabricated.

The compatibility probe holds native read-share pins while Node imports physical
Playwright/Koffi, loads SQLite and renders a page through sandboxed, Job-contained
Chromium. It captures sandbox/pipe flags and checks observed worker exit and
Job emptiness before releasing pins. The browser-reader differential observed
private copied browser `browser.newPage` failure even without browser pins;
browser-only Users read/execute made it pass without sandbox weakening.
Full exact before/after native DACL observations are emitted only by that
explicit opt-in test. Test cleanup rechecks generated identities before
test-only owner-ACL restoration and removes only its exact owned namespace.

Opt-in commands (approved artifacts must already exist at documented test
locations; no implicit download):

```powershell
$env:FIXTURE_INSTALL_COMPATIBILITY='1'
$env:FIXTURE_INSTALL_PUBLIC_BROWSER_READ='1'
pnpm exec vitest run --project smoke packages\project-host\tests\installation-compatibility.smoke.test.ts
$env:FIXTURE_INSTALL_CANDIDATE_GATE='1'
pnpm exec vitest run --project smoke packages\project-host\tests\candidate-workflow.smoke.test.ts
```

The compatibility probe's ordinary writable root is short and private. F08's
exact registered long temporary hierarchy exposed Playwright `ENAMETOOLONG`
before browser launch; that separate renderer-host path-spelling fix belongs to
the host/F08 integration. No temp/profile reader-ACL widening is authorized or
implemented here. The optional registered-temp probe mode is not passing evidence.
Actual integrated F08 CLI/render flow, final user selection of both release
identities, and any real per-user installation remain explicit subsequent gates.

Final mechanism validation on this branch: **34 unit tests and all 3 opt-in
package/candidate/browser smoke tests passed**, with build-before-strict-root
typecheck and scoped Biome checks. The complete synthetic-entry candidate/child
case took 235.4 seconds; the guarded native browser case took 44.7 seconds,
using a 54-character private temporary root. These timings include candidate
assembly/verification and are not F08 latency acceptance results.
The generated dependency change is four importer lines adding renderer-host
only as a test dependency; all other lockfile bytes were compared unchanged.

Candidate admission correction: workspace and resolved dependency manifests
must use lowercase, Windows-safe canonical npm package names (including scoped
names); dependency keys are validated before lookup or optional-platform skips.
Duplicate workspace names, case aliases and requested/resolved name mismatches
are refused before materialization. Every computed dependency destination also
must be a strict descendant of its exact `node_modules` root before allocation.
External browser inventory reads are bounded to 8 MiB; all 299 entries, paths,
hashes, file/aggregate sizes and aliases are validated before source traversal.

The observed regression RED attempted an out-of-root allocation for
`../../../escaped-package`; a test-only filesystem interceptor blocked it
**before any escape write**. After the fix, malformed names are rejected at
admission with zero intercepted allocation attempts and unchanged owned-root
sentinels. Another RED accepted a browser inventory over the byte cap; tests
now verify acceptance at exactly 8 MiB and refusal one byte beyond. These
admission tests do not install or approve a production release.

For the synthetic candidate smoke **only**, `FIXTURE_INSTALL_TEST_STORE` and
`FIXTURE_INSTALL_TEST_CACHE` may select explicit absolute, already populated
offline pnpm locations. Defaults remain this workspace's `.tools\pnpm-store`
and `.cache\pnpm`. Relative/drive-relative/empty overrides are rejected before
test allocation. These paths feed only the nested `--offline --ignore-scripts`
pnpm restore; they do not alter production installation/verifier paths or add an
online fallback. Both v11 store content/index and package metadata are required:
a frozen outer restore using another store does not necessarily populate them.
Use approved existing quiescent locations rather than merging database indexes.
Nested restore failures include bounded code, stdout and stderr while preserving
the original cause; pnpm often reports missing offline metadata on stdout.

### Current continuously pinned installation checkpoint

`FixtureInstallationLease.checkCurrent(): Promise<void>` is an explicit
metadata/current-state checkpoint after full startup verification. It shares
the same verification path as `recheck()`: bounded exact directory inventory;
fresh native opens of every expected file/directory; owner and exact protected
DACL (including the browser-only reader exception); final path, volume/file
identity, kind, reparse/single-link rules and local fixed NTFS; original manifest
file lengths; bounded reread/comparison of the mutable registration record;
ancestor identities/ACLs; principal and closed/closing state before and after
asynchronous work. It is not a WeakMap liveness-only or guard-registration check.

The sole omission is rereading/hashing the already verified payload files,
including their pinned inventory/policy files. Full startup verification and
`recheck()` still stream/hash all bytes. The original manifest snapshot and
startup native handles remain owned and continuously retained with read-only
sharing, denying ordinary Win32 write/truncate/delete/replacement access.
The checkpoint compares the freshly opened identities and original lengths
to those retained startup observations. Registration handles permit writes,
so their bounded byte comparison is **never omitted**. Directory sharing does
not freeze namespaces or DACLs, hence those checks remain fresh on every call.

This optimization inherits the explicit trusted installation/writer/OS boundary:
it does not detect raw-volume/kernel tampering or hostile writable mappings that
bypass normal file sharing, nor claim a hostile-current-user/admin sandbox.
There is no TTL, cached-success reuse, coalescing, authorization minting or
deadline/budget change. Resolver guards remain separately required and held
through actual quiescence. Closing/failing to close a lease invalidates both
checkpoint methods; overlapping closure is checked before returning.

Native fixture tests compare full/current visited file and ancestor paths,
observe positive native read counters during startup/full recheck and zero
payload reads during current checks, exercise nine concurrent checks and
close-during-check, and verify actual write/rename denial and fresh namespace,
ACL and registration-tamper rejection. Native length/identity and principal
faults are separately labeled injected cases. No full installed-candidate timing
is claimed from these small fixtures. The separately authorized actual F08
diagnostics measured three serial current checks and one nine-concurrent stress
batch, separately from full rehash samples; their retained outcomes are in the
[application evidence](../application/README.md#retained-installed-diagnostics).
They do not establish a percentile or sub-five-second guarantee.

### Bounded checkpoint phase diagnostic

An internal, test-only collector can record numeric checkpoint phase samples.
It is not exported from the package entrypoint, requires `VITEST=true` when
explicitly installed, and is absent/no-op by default. It does not change which
files are inspected or hashed, ACL/inventory checks, guards, request policy,
concurrency, deadlines or budgets. Timing occurs at completed pin/phase
boundaries, not between a failing native call and `GetLastError`. Samples are
buffered (maximum 2,048), with no per-file paths, SIDs, hashes or request data.
Pin-level phase counts/times, native handle snapshots, process CPU/RSS, active
check count and a separately armed 10 ms heartbeat distinguish synchronous work
from async elapsed time that includes sibling work. Process CPU and event-loop
metrics are not per-request attribution.

The opt-in owned diagnostic is:

```powershell
$env:FIXTURE_INSTALL_METADATA_PROBE='1'
$env:FIXTURE_INSTALL_METADATA_OUTPUT='C:\approved-session-artifacts\new-measurement.json'
pnpm exec vitest run --project smoke packages\project-host\tests\installation-metadata-probe.smoke.test.ts
```

It creates one synthetic metadata-scale tree, not a release candidate, and never
packages/downloads real runtime/browser content. The first approved run matched
only the observed **5,318 file count**, not the unavailable real directory/depth
histogram or 445,944,566-byte content. Synthetic shape: 377 directories, 913,689
bytes, 299 browser-reader files and 157-character installed-root spelling.
Cases run once: one service check with two retained leases/two guards; two
concurrent checks on that same service lease; then the same two checks with an
idle parent holding one lease, outer child two leases/two guards, and client
child one lease/one guard. Six permanent pinsets span four processes in the last
case. All diagnostic children close and actually exit before parent pins and
the exact identity-checked owned test root are released.

Observed case walls: **2,350 ms**, **4,505 ms**, and **4,565 ms** respectively.
Serial synchronous file-pin work was 1,849 ms, directory pins 73 ms,
enumeration 204 ms and temporary release 162 ms. Each concurrent file-pin loop
remained approximately 1.83–1.90 seconds. A sibling's 431-byte registration
read measured 1,951–2,004 ms elapsed while the other synchronous loop ran;
that is queue amplification, not proof of slow registration I/O. Maximum
heartbeat gaps were 1.97–2.00 seconds. Service handles returned from a
22,993 peak to the 11,602 baseline after concurrent cases.

This demonstrates synchronous event-loop starvation and roughly doubled
completion time under two same-process checks. Idle read-pin roles alone did
**not** reproduce the actual F08 56–60 second failure in this single synthetic
comparison. Real closure shape/content, other active work and OS/storage
effects remain unmeasured. No percentile, five-second acceptance result or
production bottleneck attribution follows from these samples. Cooperative
yielding between complete native operations is a possible separately reviewed
responsiveness remedy, not implemented here and not a demonstrated cure for
the actual failure. Further actual-flow phase capture requires coordinator
approval; this diagnostic must not trigger repeated packaging or weaken checks.

Diagnostic failure isolation: timing/phase/end callbacks never throw sampling
or saturation faults into the checkpoint's security or cleanup flow. The
collector retains only the first sampling cause plus bounded numeric
`failure: {samplingErrors, overflowed, droppedSamples}` state and stops storing
samples after a fault. Trace end is idempotent and always decrements activity,
including failed start/end sampling. After all checks settle, `capture.close()`
detaches the collector and **throws explicitly** for any capture fault or
overflow; a partial/faulted capture must never be reported as valid evidence.
The diagnostic child waits for all concurrent checkpoints to settle, preserves
any original checkpoint failure as the cause when capture reporting also fails,
and clears its heartbeat on every result path. Focused tests cover the exact
2,048-sample boundary, start/phase/end sampler faults, duplicate end, and native
checkpoint failure with all temporary handles released. No performance probe
was repeated for this reporting-only correction.

The subsequent actual F08 observer also covers startup verification and both
bootstrap/payload module instances. Its additions are copied-code-only test
instrumentation, sealed before inventories, not production configuration.
Version-two numeric reports retain per-phase process CPU/RSS and bounded
inclusive checked-operation timings. The builtin-only preflight still installs
its guard before importing this test TCB; no timing hook interrupts native
error-result handling. See the application evidence for the complete capture
with a functional deadline failure and the unresolved 26/56-second outliers.

### Approved minimal runtime profile and historical closure analysis

The full-distribution packager used for the retained baselines copied the pinned
Node distribution **once**, into `bootstrap\runtime`. The approved minimal
profile now copies only the fixed executable and original notice there. Both
bootstrap and payload verifier instances still intentionally verify that same
closure and retain their own pins. There is no second physical payload Node
distribution and neither verifier pass is removed.

Read-only source accounting at merged production source `c3f8941`, before later
documentation edits, projected the following current uninstrumented categories.
This is **not** a recovered inventory of either cleaned test candidate:

| Category | Files | Source bytes |
| --- | ---: | ---: |
| Bootstrap Node distribution | 1,994 | 106,986,507 |
| Bootstrap dependencies (13 packages) | 965 | 7,685,747 |
| Payload direct workspace packages | 292 | 2,474,674 |
| Payload dependencies (64 packages) | 1,751 | 39,519,381 |
| Approved browser inventory | 299 | 286,993,336 |
| Original fixture catalog | 32 | 348,079 |
| SQLite binding | 1 | 1,902,080 |
| Generated/control files | 6 | Not projected |

The 5,340-file projection excludes the two outer inventories and test observer
helpers. Runtime composition is `node.exe` (93,580,104 bytes), `LICENSE`
(160,555 bytes), bundled npm (1,926 files / 12,509,702 bytes), corepack
(54 / 623,878), and twelve top-level wrappers/setup/documentation files
(112,268 bytes). The fixed CLI and renderer launch paths use `node.exe`;
bootstrap scripts use builtins and guarded bootstrap dependencies, not bundled
npm/corepack or setup scripts. No adjacent runtime DLL is in this distribution.

The user approved the **profile design only**: fixed `node.exe` plus `LICENSE`,
two files / 93,740,659 bytes. It omits 1,992 offline-tooling files / 13,245,848
bytes from the source profile above, while keeping the unchanged executable,
original full Node notice and every application/native/browser dependency and
its notices. Development inputs are not deleted or modified.

| Selected file | Exact bytes | SHA-256 |
| --- | ---: | --- |
| `node.exe` | 93,580,104 | `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32` |
| `LICENSE` | 160,555 | `ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9` |

These pins identify the already reviewed input bytes; they do not authenticate
an untrusted bootstrap or confer approval on a resulting release. Fixed-entry
launches use that executable, Node builtins and separately inventoried
dependencies; bundled npm/Corepack/setup scripts are not invoked. The profile
is not a general Node development distribution.

Observed RED/GREEN covered missing notice and aliased source admission reaching
candidate allocation before the fix (a test interceptor stopped that allocation).
The focused cases now reject missing/wrong executable or notice, source junctions,
noncanonical/case aliases and hardlinks before output; copy only the two pinned
single-link files despite extra source tooling/caller arguments; reject source
changes after admission; and reject unsupported CLI selection flags. Synthetic
native engine cases independently reject reinjected `runtime\npm.cmd` and
`runtime\node_modules\npm` before creating any installation namespace.

Every shipped file retains the existing fresh namespace/identity/ACL/length
checks and continuous pins; startup hashing, resolver guards, all absolute
deadlines and actual-quiescence requirements are unchanged. Reducing unnecessary
shipped TCB work is **not a demonstrated cure** for the intermittent 56-60-second
checks. Three separately approved sequential actual minimal-profile flows passed
with exact two-file runtime inventories, identical 3,354-file / 432,861,345-byte
test closures, ordinary two-check overlap and complete retained numeric capture.
See the [bounded repeatability evidence](../application/README.md#approved-minimal-profile-repeatability).
No historical outlier cause, statistical latency guarantee or two-second profile
is established. Further runs and final release packaging require review; no exact
bootstrap/payload release or live installation is approved by this design choice.
