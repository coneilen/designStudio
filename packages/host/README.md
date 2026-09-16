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
`OperationGuard(context, scope, authority, timeoutMs?)` preserves an absolute
deadline capped by request, session and duration budget; `check()` revalidates
authority and cancellation; `consume("input" | "output", bytes)` counts
cumulatively; `watch()` provides a deadline/cancel signal and async `close()`.
Always close a watch in `finally`. `SystemClock` uses epoch milliseconds and
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
No caller-visible partial file is published. `discard` removes only an owned
unpublished stage. `close()` cleans only this instance's private staging files;
never existing project data. Mutation/read operations serialize per instance.
F03 owns cross-instance maintenance, database references and crash recovery.

Published paths round-trip without assuming the input and artifact roots match:
`read({artifactRootId: "artifacts", path: published.path}, context)`.
The root ID is retained by the caller alongside the contract artifact; it is
not secretly prefixed into `Artifact.path`.

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
unavailable, never plaintext fallback. The injected native backend port is not
itself proof of a Windows/macOS vault integration. Only trusted callback code
may receive secret bytes; returned plain data is checked for known-secret
leakage and callback failures conceal sensitive details. Borrowed bytes are
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
was added. Tests use synthetic contexts and freshly owned temporary directories,
binary fixtures, the exact running Node executable and trusted test scripts.
The shared contract driver exercises the real runner/locator failures.
No real user credentials, devices, source repositories or model calls are used.
Windows execution does not establish macOS runtime or live-vault behavior.
