# @design-studio/project-host

Narrow Windows **fresh fixture-catalog projects only** provisioning for F08.
This is not arbitrary directory adoption, an ACL repair service, an HTTP setup
endpoint, a general filesystem sandbox, or a complete application.

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
