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
verifies those identities, exact metadata and actual bytes, then atomically
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
F03 owns cross-instance maintenance, database references and crash recovery.

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

`publicationDurability` is explicitly
`file-flushed-atomic-visibility-not-power-loss-durable`. Staging calls file
`fsync`; **directory-entry persistence across power loss is not established**.
`ensurePublicationDurable(rootId, artifacts, context)` validates scope/input
then reports `unavailable` / `UNSUPPORTED_FEATURE` on the current adapter.
F03 must not create a power-loss-durable commit receipt from this result.
No callback injection is represented as a working native flush implementation.

Bounded native feasibility checked the official
[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw),
[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
and [CreateFileW caching](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior)
documentation. `MOVEFILE_WRITE_THROUGH` is `0x8`, not reserved `0x10`; its explicit
copy/delete flush language does not establish the current same-volume hard-link
protocol. Write-through file handles document NTFS metadata/rename flushing,
suggesting a future same-handle no-replace rename adapter, but the end-to-end
guarantee and package binding remain unverified. Koffi 3.2.1 has exact optional
Windows prebuilds but also a wrapper install script; fswin 3.25.1108 metadata
did not establish the required write-through API. Neither was installed or
executed. No volume flush, administrative access or global change was attempted.

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
uses only `AsyncEntry.getSecret(signal)`, never enumeration, password strings,
provisioning, deletion, CLI tools or plaintext fallback. Its capability label
is `native-binding`, not evidence of a successful live vault lookup.

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
and callback failures conceal sensitive details even for typed errors. Borrowed bytes are
zeroed on success, failure and timeout. JavaScript cannot erase immutable strings,
native copies or a malicious consumer's copies; this is lifetime hygiene, not
a cryptographic erasure or arbitrary callback sandbox guarantee.

`Redactor` masks registered UTF-8/encoded credentials, authorization headers and
URL credentials/query/fragment metadata. Avoid logging untrusted objects or
design content in the first place; it is not an all-secrets detector.
`decideEgress` defaults deny and records provider, data classes and evidence IDs
separately from configured policy. Every class and exact provider must be
allowed, with a trusted `model-egress` grant and nonzero external-call budget.
An allowed decision is not a transmission receipt, token/spend reservation or
permission for an arbitrary adapter to send content. No transmission occurs here.

## Evidence and commands

From the root: build before typecheck; tests are co-located under `tests/`.
Focused tests first failed for missing modules, then passed with implementations.
A concurrent first-stage regression separately failed before serialization
was added. Additional observed RED/GREEN regressions cover post-link unlink
failure/recovery, overlarge caller budgets, secret arrays/keys/typed errors,
and mutation of process arguments or staged bytes during asynchronous checks.
Virtual deadlines use the unmodified contract fake clock; real deadline and
cancellation cases wait until an owned subprocess is running before stopping it.
Tests use synthetic contexts and freshly owned temporary directories,
binary fixtures, the exact running Node executable and trusted test scripts.
The shared contract driver exercises the real runner/locator failures.
No real user credentials, devices, source repositories or model calls are used.
Windows execution does not establish macOS runtime or live-vault behavior.
