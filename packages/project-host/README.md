# @design-studio/project-host

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
pinned Windows x64 Node 24.21.0 distribution, bootstrap scripts, native bridge,
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
executables. Candidate Node bytes must match the explicitly trusted running
24.21.0 runtime. The SQLite addon is checked against the existing ABI137 binary
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
is claimed from these small fixtures. F08 will measure three serial current
checks and one nine-concurrent batch, separately from a full rehash sample,
inside its next otherwise-required owned actual-candidate run. Report individual
and maximum durations, not a statistical percentile or sub-five-second guarantee.

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
