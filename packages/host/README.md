# @design-studio/host

F04 host/runtime primitives, using `@design-studio/contracts` v1.0.0 directly.
No HTTP routes, database, jobs, media validators, model calls or device providers.

## Trusted composition

`authorizeOperation(context, scope, authority)` throws `HostBoundaryError` with
a contract `ErrorCode`. `Authority` is `(AuthorizationContext) => boolean` and
is **mandatory**: the host cannot infer authenticity from valid JSON, a session
ID, or a grant array. Supply a trusted session/store verifier, never `() => true`
in production. `LocalSessionAuthenticator.authority` accepts only the exact
frozen authorization object returned by successful authentication, while it is
unexpired and unrevoked.

`snapshotOperationContext(context)` owns and freezes request metadata and budget
before enqueue/await, while retaining the **exact** authorization reference and
live signal/clock. It never freezes caller data. Auth JSON mutation is rejected
at checkpoints; cloning authorization would destroy trusted provenance. Applying
the helper to one of its own snapshots returns the same object. F03's
`StorageOptions.snapshotOperationContext` composition hook should use this helper
so nested host calls preserve its exact removal-reservation context identity.
All host boundary callbacks operate on these snapshots, not lexical caller
metadata that can change during I/O.

`OperationScope` has `projectId`, optional `actorId`, `resourceKind`,
`resourceId`, and `operation` (the latter fields use contract types).
`OperationGuard(context, scope, authority, timeoutMs?, budgetLimits?)` preserves an absolute
deadline capped by request, session and duration budget; `check()` revalidates
authority and cancellation; `consume("input" | "output", bytes)` counts
cumulatively; `watch()` provides a deadline/cancel signal and async `close()`.
The default trusted ceilings are `DEFAULT_BUDGETS`, not arbitrary request
numbers. Requests exceeding them fail before allocation. Host adapter options
accept an explicit, validated `budgetLimits` configuration for approved larger
limits. Pure `authorizeOperation` validates context/grants; allocation-owning
services must additionally use `OperationGuard` or their own trusted budget
accounting. Always close a watch in `finally`. `SystemClock` uses epoch milliseconds and
abortable, overflow-safe timer chunks. Inject the contract fake clock for
deterministic tests; do not substitute it for production.

## Filesystem

```ts
const files = await ProjectFileSystem.create({
  projectId,
  authority,
  roots: [
    { id: "inputs", path: absoluteInputRoot, access: "read", trustedExclusiveAccess: true },
    { id: "artifacts", path: absoluteArtifactRoot, access: "read-write", trustedExclusiveAccess: true },
  ],
});
```

All paths must be explicit existing absolute real roots without overlapping
aliases. Roots must be private/trusted and not concurrently modified by
untrusted writers. On Windows, provisioning restrictive ACLs remains the
application/installer owner's responsibility; POSIX creation modes are not
proof of Windows ACL isolation. **This is not a hostile-local-writer sandbox**:
Node does not expose cross-platform handle-relative `openat`/Windows reparse
containment for atomically defending every ancestor replacement. Native
containment would be required before claiming that guarantee.

Every `FileRequest` is exactly `{artifactRootId, path}`. Authorization uses
`resourceKind: "artifact"` and `resourceId: artifactRootId`, not an inferred
artifact grant. `path` is portable slash-relative metadata; Node path APIs
translate it for actual host I/O. Reject traversal, absolute/drive/UNC paths,
backslashes, percent-encoding, reserved Windows names, alternate streams,
case/Unicode aliases and symbolic links/junctions. Parent/root identities are
rechecked; bounded binary reads detect size/identity changes.

`stage(request, bytes, context)` snapshots bytes and produces a SHA-256 artifact
with generic `application/octet-stream` media type. This asserts byte integrity,
**not media validity**. Consumers must keep semantic MIME/decoding evidence
separate and never modify the staged metadata. A staged artifact belongs to
this instance, project, actor, session and request. `publish(staged, context)`
validates and snapshots the complete staging ID/artifact request before enqueue.
It verifies those identities, exact metadata and actual bytes, then atomically
links on the same filesystem without replacing an existing destination and
removes its staging link. Existing destinations conflict, even with equal bytes.
If link succeeds but stage unlink fails, the result is `interrupted` /
`OUTPUT_UNCERTAIN`: the destination is visible, not rolled back. Retry the exact
owned `publish` to verify original inode, exactly two links, metadata and bytes,
then remove only its staging link. Unknown links never receive this exception
to the ordinary single-link read rule. Do not use `close`/`discard` to bypass
an interrupted publication; reconcile it first.
No caller-visible partial file is published. `discard` removes only an owned
unpublished stage. `close()` cleans only this instance's private staging files;
never existing project data. Mutation/read operations serialize per instance.
Previously accepted work drains before queued close. Every queued operation
rechecks the lifecycle before accessing files: work queued behind a successful
close fails with `FORBIDDEN`, including reads and stages, without creating files.
Repeated close is safe. A close rejected for interrupted publication leaves
the boundary usable for the existing owned-retry recovery path.
F03 owns cross-instance maintenance, database references and crash recovery.

`closePreservingStages()` uses the same serialized lifecycle and busy/uncertain
publication refusals, but leaves every pending stage file and directory
physically unchanged. After quiescence it closes admission and releases only
in-memory metadata, for native capture attempts whose existing job journal must
survive interruption. Later preserve-close or ordinary close is a no-op: it
cannot silently delete those retained files or recreate staging directories.
Reads/stages/publish/discard remain refused. A failed uncertain-publication
close retains the live boundary and exact metadata for authorized reconciliation.
This is disposal, not stage adoption, effect settlement, recovery completion or
deletion authority; the default `close()` behavior on an open boundary is unchanged.

Published paths round-trip without assuming the input and artifact roots match:
`read({artifactRootId: "artifacts", path: published.path}, context)`.
The root ID is retained by the caller alongside the contract artifact; it is
not secretly prefixed into `Artifact.path`.

### Managed blobs, recovery and durability

`ProjectRoot.managedBlobs: true` explicitly provisions the `blobs/<sha256>`
namespace as application-owned, including crash orphans. Stage paths must match
the exact supplied bytes. `inventory(rootId, context, maxEntries)` bounds all
listed directory entries (1..20,000), rehashes published blobs within cumulative
byte/time budgets, and returns `{stagedIds, publishedArtifacts}`. Historical
stage IDs are evidence, not authorization to discard them. Corrupt/link-aliased
blobs fail explicitly. An unreconciled two-link publication blocks ordinary
inventory/read until explicit recovery.

`removeUnreferenced(rootId, artifact, context)` requires the configured
`authorizeRemoval(artifact, context): Promise<boolean>` reservation callback,
exact managed metadata and current hash/size/inode. There is no default permit.
F03 owns reference protection and cross-instance serialization; its adapter
should consult `store.hasRemovalReservation` without re-entering its queue.
F04 does not infer unreferenced status from a path or inventory entry.

After restart, `reconcilePublication(rootId, artifact, stagingId, context)`
requires a separate `authorizePublicationRecovery` callback from trusted
recovery policy. It proves a unique historical staging name, real managed
destination, exact expected hash/length and the same two-link inode pair before
unlinking that specific staging link. It neither removes historical directories
nor grants general cleanup. Current-instance stages must use owned `publish`.

The default `publicationProfile: "portable-atomic"` retains
`publicationDurability: "file-flushed-atomic-visibility-not-power-loss-durable"`.
Staging calls file `fsync`; **generic directory-entry persistence across power
loss is not established**. Its `ensurePublicationDurable` remains explicitly
unavailable. The opt-in Windows profile below issues and verifies actual native
OS-request evidence; no callback boolean promotes generic files.

Bounded native feasibility checked the official
[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw),
[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
and [CreateFileW caching](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior)
documentation. `MOVEFILE_WRITE_THROUGH` is `0x8`, not reserved `0x10`; its explicit
copy/delete flush language does not establish the current same-volume hard-link
protocol. Write-through file handles document NTFS metadata/rename flushing,
suggesting a same-handle no-replace rename adapter. The follow-up below establishes
that the prebuilt binding and actual request sequence work, not a blanket
hardware/power-loss guarantee. fswin 3.25.1108 metadata did not establish the
required write-through API and was not installed. No volume flush,
administrative access or global change was attempted.

### Opt-in Windows NTFS write-through profile

The coordinator-approved initial bounded probe is test-only, under
`tests/windows-write-through.probe.ts`; it cannot adopt an existing directory.
It creates a new owned temporary root, checks its identity, restricts operations
to owned flat filenames, and removes only that root at completion. Koffi 3.2.1
is now an exact **optional** dependency with exact optional platform prebuilds.
Installation used `--ignore-scripts`; neither the wrapper's cnoke install script
nor a compiler was run. The shipped Windows x64 prebuild loaded successfully
on Node 24.21.0. No new root install/build policy is required.

Two real Windows x64 tests passed on the owned NTFS fixture:

- `CreateFileW` with `GENERIC_READ | GENERIC_WRITE | DELETE` (`0xc0010000`),
  exclusive share mode `0`, `OPEN_EXISTING` (`3`), and
  `FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT` (`0x80200000`);
  reject directories/reparse points/multiple links, and confirm NTFS through
  `GetVolumeInformationByHandleW` on that file handle.
- Successful file preflush, same-handle `SetFileInformationByHandle`
  `FileRenameInfo` (`3`) with zero `ReplaceIfExists`, correct UTF-16 byte
  length/alignment, postflush, unchanged volume/file identity and checked
  `CloseHandle`. Binary bytes, spaces and Unicode filenames survive.
- Existing-destination rename returns Win32 `183`; neither file changes and
  the source handle closes. Unowned/traversal inputs are refused.

The probe first failed with a missing harness; initial FFI execution exposed
the distinction between a null pointer and a numeric `uintptr_t` template
handle, which was corrected to zero before the native sequence passed.

The concrete feasible route is an **explicit local-NTFS OS-request profile**:
the [CreateFileW caching contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior)
documents NTFS flushing metadata/rename changes resulting from write-through
requests, and
[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
documents no replacement when `ReplaceIfExists` is false. The probe issues that
same-handle request followed by `FlushFileBuffers`; it does not use
`MoveFileEx`, copy/delete, delayed operations, volume handles or admin access.
The precise evidence label is
`documented-ntfs-write-through-request-not-power-cut-tested`.

Production opt-in is
`ProjectFileSystem.create({...options, publicationProfile: "windows-ntfs-write-through-v1"})`.
The lazy adapter in `windows-native.ts` / `windows-publication.ts` uses the tested
request sequence, verifies the source/destination handle path and NTFS volume/
file identity, and retains all buffers/handles through synchronous native calls.
Canonical local drive paths are encoded internally with the extended-length
Windows prefix for both open and rename, following project-host's native path
convention. This supports owned roots/staging/blob paths beyond legacy MAX_PATH
without a global long-path setting. Caller-supplied extended/device/UNC namespaces,
alternate streams, traversal and normalization aliases remain forbidden; the
prefix is not an authorization bypass. Handle-returned paths must be the exact
local drive namespace and are decoded back to ordinary paths for receipt identity.
The public `extendedDrivePath(ordinaryPath)` helper exposes only this checked
encoding policy for trusted host composition. It rejects external namespace
spellings rather than normalizing them. Its result proves no authorization,
existence, containment, ACL or NTFS property; callers must establish those
separately before using it for a native operation or an owned child environment.
Native UTF-16 length/component bounds remain enforced. An owned long-path
regression reproduced `Native open failed (Win32 3)` before the conversion fix
and now verifies publication, binary read, durability evidence and no-replace.
No asynchronous FFI callback outlives its buffer; every successful open has
checked close handling. Cancellation/deadlines are checked before mutation,
including after preflush. Once rename commits, flush/close complete even if
cancellation or a deadline arrives; an uncertain post-rename failure returns
`interrupted` / `OUTPUT_UNCERTAIN`, never a cancellation-shaped rollback.
Kernel calls are synchronous/cooperative checkpoints, not forcibly interruptible
or hard-real-time operations.

On success, the boundary records private, instance-owned root/path/artifact-hash/
file-identity/profile evidence. `ensurePublicationDurable(rootId, artifacts,
context)` snapshots the bounded requested set before enqueue, rehashes actual
bytes, reopens the file to match its native identity/path, and returns
`{durable:true, profile:"windows-ntfs-write-through-v1"}` only for those receipts.
It never promotes a generic link publication, a supplied boolean or reconstructed
metadata. F03's required durability port must propagate all noncomplete outcomes
and accept the profile explicitly in trusted composition.

After a native post-rename flush failure, the owning `publish` retry verifies the
recorded committed file identity/hash and flushes it before issuing evidence.
`discard` cannot remove that visible artifact. A failed `close` on interrupted
publication leaves the boundary usable for retry. Across instance/process restart,
native evidence is not invented: unknown orphans remain gated and require trusted
reference-safe recovery/restaging. Persistent native publication journals are not
silently inferred from filenames or hashes.

Real production-profile tests cover valid evidence, modified bytes/identity/
metadata, omitted entries in a mutated caller list, no-replace preservation,
missing prebuild without unrelated read failure, pre-mutation cancellation,
post-mutation deadline completion, injected post-rename flush failure, and
checked HANDLE cleanup/retry. Windows x64 is exercised; Windows arm64/macOS
execution and power-cut recovery are not claimed. Newly provisioned parent-
directory persistence, hardware cache behavior and release filesystem/host
coverage remain separate validation obligations. This explicit local-NTFS
OS-request profile is not a universal physical durability guarantee.

## Process and tools

`ConfiguredToolLocator({projectId, authority, tools})` accepts only explicitly
approved absolute executable paths, platform sets, SHA-256 identities and a
finite executable-inspection byte limit. It performs no PATH, repository, adb
or Xcode discovery. An approved executable is a trusted immutable host resource;
the same private-writer precondition applies to it and its working directories.
Missing optional tools report `unavailable` only when requested.

Each `ApprovedTool` supplies exact `{args, cwd}` commands, an explicit environment
(not inherited `process.env`), and `spawnsDescendants: false`. Shell script
executables and runtime injection environment variables are rejected. Imported
content may select an already-authorized request; it cannot add configuration.
`BoundedProcessRunner(locator)` validates argument arrays, exact configured
executable/arguments/cwd, individual stdout/stderr limits and combined output
budget. Binary streams remain bytes. Nonzero exits return `partial` with
`PROCESS_FAILED` and retained binary evidence; missing executables are explicit.
Deadline/cancellation/output overflow terminates only the owned direct child
and waits for its close event. No global resets or name-based kills occur.
Descendant-spawning programs are unsupported until an OS job/process-group
containment adapter is supplied; this is not arbitrary-code sandboxing.

## Local sessions, credentials and egress

`LocalSessionAuthenticator({clock, hosts, origins})` issues independent 256-bit
in-memory session and CSRF credentials. Host entries require explicit loopback
host/port, origins are exact HTTP origins, never null/wildcard. Transport code
must pass the actual peer address and reject duplicated/malformed HTTP headers.
Do not trust forwarded addresses. CLI bearer mode rejects all browser Origin,
Fetch-Metadata and cookie credentials. Browser cookie mode requires an allowed
Origin for **every** request and CSRF for unsafe methods; absence is not plugin
access. F08 must compose cookie `HttpOnly`, `SameSite=Strict`, host/path scoping
and secure transport rules, header parsing, pairing and credential delivery.
Do not persist these tokens to browser storage, logs, URLs or CLI arguments.

`ScopedCredentialStore` requires a configured project/provider/reference
allowlist, trusted authorization and `Redactor`. No backend means explicit
unavailable, never plaintext fallback. `NapiCredentialBackend({entries})` is
a real, lazy Windows Credential Manager/macOS Keychain read path using pinned
`@napi-rs/keyring` 2.0.0 and its exact optional platform packages. Each entry
maps one contract credential reference to configured service/account; the adapter
uses only `AsyncEntry.getSecret()`, never enumeration, password strings,
provisioning, deletion, CLI tools or plaintext fallback. Its capability label
is `native-binding`, not evidence of a successful live vault lookup.
Cancellation is checked before/after native work. The native call is deliberately
not passed an AbortSignal: N-API abort-wrapper rejection does not prove the
underlying native read has settled. Late returned bytes are zeroed and rejected.

`nativeVaultCapability()` loads the module without constructing an entry.
The Windows x64 prebuilt module loaded on Node 24.21.0 with install scripts
disabled and no compiler; missing binding/unsupported host remains explicit.
Injected-native tests exercise the byte API, missing entry, error and abort
paths. **No actual user's vault was read or modified.** Windows live access,
locked/permission prompts and all macOS native execution remain unverified.
The package is MIT; retain its notices and native dependency notices when
distributing. No dependency build-policy exception is needed for the tested
prebuilt path.

Only trusted callback code
may receive secret bytes; returned plain data is checked for known-secret
leakage (including nested keys, byte arrays and encodings), finite output bounds,
and callback failures conceal sensitive details even for typed errors. Original
read/consumer promises are awaited, not raced away on cancellation or deadline.
Late success is rejected after live authority revalidation. Borrowed bytes and
scoped redaction remain owned until the original work settles, then are cleared
on success or failure. `pendingUses` reports retained ownership; `interruptedUses`
counts those with a cancelled/deadline watch. An arbitrary native call or trusted
consumer that never settles can retain ownership indefinitely: an operation
deadline is not proof of completed cleanup. Callers must not release project or
installation resources while `use` remains pending.
JavaScript cannot erase immutable strings,
native copies or a malicious consumer's copies; this is lifetime hygiene, not
a cryptographic erasure or arbitrary callback sandbox guarantee.

`Redactor` masks registered UTF-8/encoded credentials, authorization headers and
URL credentials/query/fragment metadata. `addSecret` returns an idempotent
release function; overlapping registrations are reference-counted, so one
operation cannot remove another's redaction. Avoid logging untrusted objects or
design content in the first place; it is not an all-secrets detector.
`containsSecretValue` applies the existing callback-result check to parsed
private capture data, including encoded strings and numeric byte-array aliases;
it does not weaken the credential callback return guard.
`decideEgress` defaults deny and records provider, data classes and evidence IDs
separately from configured policy. Every class and exact provider must be
allowed, with a trusted `model-egress` grant and nonzero external-call budget.
An allowed decision is not a transmission receipt, token/spend reservation or
permission for an arbitrary adapter to send content. No transmission occurs here.

### Internal credential-administration primitives (not an enrollment command)

`credential-admin.ts` and `credential-admin-vault.ts` are deliberately **not**
exported from the public package. No CLI/HTTP route, installed capture profile,
native project enrollment or real-user authority issuer is wired yet. Constructing
these primitives or supplying a callback is not production trust evidence.
The next reviewed composition must provide the verified native current-principal
and project leases, existing live `Authority`, one boundary instance per owned
reference, and a durable private `CredentialAdminJournal`; there is no default
permit, in-memory production journal or plaintext fallback.

The internal issuer admits exactly `setup`, `status`, `update` or `remove`
following trusted local user confirmation of that action/reference. This is
separate from the public `Operation`/Job vocabulary, which remains unchanged.
Capabilities are frozen runtime identities in a private WeakMap, scoped to
actor/project/provider/reference/action, consumed once, and rechecked across
awaits. JSON, structural clones, stale authority and cross-principal use fail.
Prompt interaction must finish before issuing the short-lived work capability;
do not extend expired authority after a five-minute user interaction.

The byte adapter targets only `figma_rest` / Windows Credential Manager with
an app-created UUID reference. Its service is `DesignStudio.FigmaPAT.v1.` plus
the SHA-256 of actor/project/reference; its account is an opaque actor digest.
No caller service/account/target, credential enumeration, other provider/user
lookup or password-string API exists. `setSecret`, `getSecret` and
`deleteCredential` settle without native AbortSignal wrappers.
The loader injection is an internal deterministic test seam, not a public
production override.

Setup checks its exact new entry for collision and refuses overwrite; update
requires an existing owned entry and separately confirmed action, and remove
requires its exact confirmed target. Status **is vault access**, not a free
capability probe: the binding lacks metadata-only presence, so it performs one
authorized read and immediately clears the bytes. Output includes only reference,
presence and explicitly user-declared expiry/scopes, never a token prefix,
fingerprint, account profile or verified permission claim.

Before write/delete, await durable nonsecret intent. Ambiguous/failed/late native
mutation or verification returns `OUTPUT_UNCERTAIN`, retains pending/uncertain
journal state and never rolls back automatically. Failed journal cleanup is
explicit. Other mutations require separately authorized status reconciliation;
an exact pending removal may instead be retried only through a new explicitly
confirmed remove capability and fresh authorized exact-entry read. This is not
an automatic retry or permission to update an uncertain setup/update entry.
Native composition reserves journal capacity before lookup and can retain
pending-remove across ambiguous deletion/status observations to protect its
terminal absence record.
Uncertain expiry claims are not promoted by a presence-only read. The original
promise and owned token bytes remain live until native work settles; `pending`
does not become false merely because cancellation was requested. Caller-supplied
owned token bytes are copied within a 4096-byte printable-ASCII bound, cleared on
admission/rejection, and the private copy is cleared after work quiesces.

This is an OS-current-user boundary, not a sandbox against software running as
that same user. Tests use synthetic native adapters and journals; no real vault
entry has been read, created, replaced or deleted for this slice. Live native
behavior, permissions and crash recovery require separate approved evidence.

## Evidence and commands

### Private native PAT input modules

The private `pat-input`, `pat-edit`, `pat-channel`, `windows-pat-dialog` and
`owned-job` modules support the capture profile; none is a new public host
credential/launcher endpoint. The single-line Windows EDIT uses ES_PASSWORD,
bounded ASCII typing and complete UTF-16 paste validation before insertion.
EM_SETLIMITTEXT is defense in depth, not permission to accept truncated text.
Only WM_PASTE/Ctrl+V handling opens the clipboard; the clipboard's global
allocation is never freed, zeroed or modified by the app. Only bounded owned
copies are scrubbed. Current clipboard synthesis and Windows control-internal
copies are not claimed erasable.

Koffi callbacks are registered, kept alive on the owning thread and released
only after observed owned HWND destruction and successful native cleanup.
The bounded PeekMessage pump yields to Node IPC/cancellation rather than blocking
the event loop in GetMessage. Native callback errors, reentrant paste, timeout
and cleanup faults cannot return accepted token bytes. This is an app-owned
normal-desktop dialog, not secure desktop, Windows login or credential-provider UI.
Callback failures remain sticky during closing, including callbacks invoked by
DestroyWindow after acceptance. Receipt of WM_NCDESTROY, successful subclass
removal, successful default-procedure return and callback/class unregistration
are separate observations. Final checks run after destruction callbacks unwind;
any failure clears accepted bytes and reports sanitized primary/cleanup codes,
never an exception through the native callback boundary or inferred scrub success.

All default UI tests use an explicit mocked-Koffi safety check before invoking
the adapter. Real Job/pipe no-UI probes import no dialog or clipboard module.
No real UI, clipboard or vault proof is claimed. Later user-approved synthetic
display testing must verify actual masking, gesture/paste routes, ABI/callback
lifetime and window/process teardown before any real token enrollment.

From the root: build before typecheck; tests are co-located under `tests/`.
Focused tests first failed for missing modules, then passed with implementations.
A concurrent first-stage regression separately failed before serialization
was added. Additional observed RED/GREEN regressions cover post-link unlink
failure/recovery, overlarge caller budgets, secret arrays/keys/typed errors,
publication-request mutation after enqueue, close-then-stage/read ordering,
and mutation of process arguments or staged bytes during asynchronous checks.
Virtual deadlines use the unmodified contract fake clock; real deadline and
cancellation cases wait until an owned subprocess is running before stopping it.
Tests use synthetic contexts and freshly owned temporary directories,
binary fixtures, the exact running Node executable and trusted test scripts.
The shared contract driver exercises the real runner/locator failures.
No real user credentials, devices, source repositories or model calls are used.
Windows execution does not establish macOS runtime or live-vault behavior.
