# @design-studio/renderer-host

Windows x64 owned renderer-worker lifetime containment for F04/F06. This is
**not** a renderer, arbitrary-command runner, JavaScript sandbox, browser
installer, network sandbox, scheduler or artifact publication service.
`@design-studio/host`'s `BoundedProcessRunner` still rejects descendants.

The Windows Job binding is shared privately through host's `owned-job` module;
`src/windows-job.ts` remains the compatibility re-export. Renderer callers keep
the original default 64-process profile, containment flags, membership handshake
and native error behavior. The separate capture helper selects the closed
one-process `pat-dialog` profile; no arbitrary process-limit or launcher API was
added to the public host package.

## Trusted configuration and public API

```ts
import { RendererWorkerHost } from "@design-studio/renderer-host";

const host = new RendererWorkerHost({
  projectId,
  providerId: "renderer-static",
  authority, // Trusted verifier; never a default permit or model callback.
  node: { path: installedNodeExe, sha256: approvedNodeHash, maxBytes: 200_000_000 },
  implementation: {
    path: installedRendererEntry,
    sha256: approvedRendererHash,
    maxBytes: 1_000_000,
  },
  tempRoot: privateExistingTempRoot,
  trustedExclusiveAccess: true,
  environment: { TZ: "UTC" },
  limits: {
    startMs: 5_000, idleMs: 5_000, lifetimeMs: 30_000, closeMs: 1_000,
    maxFrameBytes: 10_000_000,
    maxInputBytes: 25_000_000, maxOutputBytes: 25_000_000,
    maxStdoutBytes: 16_384, maxStderrBytes: 16_384, maxRequests: 8,
  },
});
const opened = await host.open(context);
if (opened.status !== "complete") {
  // Propagate unavailable/failed/cancelled/interrupted; never substitute success.
} else {
  const lease = opened.value;
  try {
    const exchanged = await lease.exchange(verifiedRequestBytes, context);
    // F06 must validate the response envelope, PNG bytes and rendering evidence.
  } finally {
    const cleanup = await lease.close();
    // Propagate interrupted cleanup even if an earlier byte exchange succeeded.
  }
}
```

Exports are `RendererWorkerHost`, `RendererWorkerOptions`, `WorkerLimits`,
`PinnedFile`, `RendererWorkerLease`, `CleanupReport` and
`TrustedRendererImplementation`. Only the package entrypoint is supported;
native bindings, bootstrap and frame helpers are private.

`open(OperationContext)` returns `Promise<Outcome<RendererWorkerLease>>`.
`exchange(Uint8Array, OperationContext)` returns
`Promise<Outcome<Uint8Array>>`. Input is snapshotted before awaiting; shared
memory is rejected. No request can specify executable, arguments, environment,
cwd, module paths or code strings. F06 owns the versioned, validated binary
render envelope; the host only transports bytes.

An operation needs the exact configured project and a `provider` /
`providerId` / `execute` grant. `snapshotOperationContext` retains the original
authorization proof, live signal and clock. `OperationGuard` rechecks trusted
authority, scope, original authorization JSON, cancellation and deadline.
Exchanges must use the **same authorization object and clock**, project,
actor and session as `open`. The opening request ID may be exchanged once;
subsequent exchanges require distinct request IDs. Requests never extend the
original lease deadline or budget. Concurrent and replayed exchanges fail.
Do not serialize or clone an authorization proof across application layers.
Immediate revocation during a silent/hung render should abort the live signal;
otherwise authority is rechecked at the next boundary and finite lease expiry
still applies.

Configuration is trusted application/installer policy, never content or model
input. The Node executable must be `node.exe`, hash-pinned from an approved
Node 24.21.0 installation; the bootstrap also checks the actual runtime version.
The configured `.mjs`/`.js` entry is inspected before spawning and rehashed in
the joined worker before import. Paths must be absolute, local, real, regular,
single-link files; the root must be an existing real directory. Inspection is
bounded and checks identity/size/mtime changes.

**The entire installed dependency closure must be trusted and immutable**:
Node, this package's bootstrap/dist files, host/contracts/native prebuilds,
renderer implementation, and all transitively imported code/resources. An
entry hash does not authenticate its imports. `trustedExclusiveAccess: true`
asserts installer ownership/private writers for those resources and the temp
root, not just a convenient temporary folder. Do not configure writable
repository code, model-authored scripts or unreviewed modules. As with the
host's pin conventions, this does not atomically defeat a hostile local writer
replacing ancestors; Windows ACL provisioning belongs to the installer.

Environment starts empty, not from `process.env`. The only configurable keys
are case-insensitive `SystemRoot`, `WINDIR`, `LANG`, `TZ`; duplicate aliases,
NULs and overlong values are rejected. Windows roots must match the actual
system root and TZ may only be `UTC`. `PATH`, `NODE_OPTIONS`, `NODE_PATH` and
all other keys are forbidden. The host supplies `TEMP`/`TMP` and cwd as a new
unique child of its owned temp root. It removes only that new directory after
observing worker exit and an empty Job.
On Windows, only child `TEMP`/`TMP` use the checked extended local-drive spelling
of that same freshly created directory, before bootstrap/implementation import.
The ordinary cwd, authorized root, public identity and cleanup path do not change.
The public host `extendedDrivePath` helper supplies the existing encoding policy;
it confers no authority and does not permit caller-supplied extended, UNC or device
roots. No relocation, ACL expansion, global long-path setting or sandbox/Job flag
change is involved.

This avoids pinned Playwright's `mkdtemp` failure at deep registered roots.
The opt-in `registered-temp.smoke.test.ts` runs the actual private project-host
KnownFolder test seam, verifies the pinned browser inventory, and requires
sandboxed pipe-based Chromium launch, a profile beyond legacy MAX_PATH, in-memory
PNG output, unchanged binding checks and observed graceful worker/Job cleanup.
Run with `F06_RENDER_SMOKE=1`; `F06_BROWSER_ROOT` may select an explicitly approved
already-present browser payload for this test, otherwise it uses the standard
`.tools\renderer-browser-1.63.0` fixture location. It never downloads a browser.
The child-environment component test separately checks import-time values,
ordinary cwd and unchanged external namespace rejection.

**Long `file://` navigation remains unsupported.** In the bounded investigation,
ordinary file URLs at 279/285 characters failed with `ERR_FILE_NOT_FOUND` even
though extended TEMP allowed browser startup and in-memory rendering. F06's
existing in-memory document/resource path is unchanged; this fix does not claim
general browser filesystem URL compatibility or relax its input/network policy.
Expected temporary-directory allocation I/O failures (including `ENOSPC` and
`EACCES`) return `unavailable` / `PROVIDER_UNAVAILABLE` with the OS error code.
No Job handle or worker is created, and no path is cleaned when allocation
did not succeed. Unexpected programming errors remain rejected promises.

## Fixed bootstrap and private protocol

The parent creates an unpredictable `Local\design-studio-<uuid>` named Job
with verified `KILL_ON_JOB_CLOSE | ACTIVE_PROCESS_LIMIT` (`0x2008`), a fixed
64-process ceiling, no breakaway flags, and a **non-inherited controller
handle**. Name collisions fail, never adopt another Job. Only Windows x64 has
demonstrated ABI/native evidence. The binding verifies pointer width,
alignment, 144-byte extended limit structure and relevant offsets, flags,
return values and calling-thread `GetLastError`. `CreateJobObjectW`'s NULL
failure is distinguished from other APIs' INVALID_HANDLE_VALUE.

Only the fixed, source-hash-pinned `src/bootstrap.mjs` runs outside the Job.
Before any implementation import or request handling it loads trusted narrow
bindings, opens the parent's named Job with ASSIGN_PROCESS|QUERY, assigns
**GetCurrentProcess**, verifies membership, and closes its temporary Job
handle. It has no pre-join descendant-spawning path. No arbitrary PID or the
application/CLI process is ever assigned. Closing the temporary handle before
ACK leaves the parent as sole controller. Parent death before joining denies
membership; after joining, last-controller-close kills the Job tree even if
the worker has already exited.

Node owns the worker child handle and transport. Windows fd3 is a private
**overlapped duplex pipe**; ordinary synchronous inherited pipes blocked the
first real asynchronous handshake and are deliberately not used. fd1/fd2
are separate, drained, byte-bounded diagnostics, never protocol or returned
raw logs. There is no listener, port, Node IPC object deserializer, user
profile or shared browser.

Each binary frame is:

| Bytes | Meaning |
| --- | --- |
| 4 | Big-endian body length, checked before body allocation |
| 32 | Per-lease cryptographic nonce |
| 1 | Frame kind |
| 4 | Big-endian monotonically increasing request sequence (control = 0) |
| remaining | Bounded binary payload |

Bootstrap sends empty JOINED only after closing its join handle. The parent
checks actual Job membership for its own child, then sends empty START.
Only then does bootstrap verify/import the renderer entry and send empty
READY. Each REQUEST has one matching RESULT. Unknown, out-of-order,
duplicate, incorrect-nonce and oversized frames terminate the lease.
Bootstrap errors are bounded generic codes; implementation exception text
and diagnostic contents are not disclosed. Control kind values are internal,
not a public application protocol; F06 should use `exchange`, not fd3.

The trusted module exports:

```ts
export async function render(
  bytes: Uint8Array,
  context: { signal: AbortSignal },
): Promise<Uint8Array>;
export async function close(): Promise<void>; // Optional; no arguments.
```

`render` is sequential. When the worker event loop responds, cancellation/
closure aborts the module signal and invokes optional `close` without waiting
for a hung render. Job teardown is forced when the grace allowance expires,
including for CPU-blocked code. A module must not keep/reopen Job handles,
read protocol configuration, tamper with containment, or treat data as code.
Do not inherit fd3 into descendants. Browser page/context management and
Chromium sandbox policy remain F06's responsibility.

## Bounds and cleanup semantics

All limits are explicit finite positive integers; there are no unlimited or
implicit defaults. Trusted constructor ceilings are:

| Limit | Maximum |
| --- | --- |
| `startMs`, `idleMs` | 30,000 ms each |
| `lifetimeMs` | 300,000 ms, still capped by original operation/session/budget |
| `closeMs` | 5,000 ms for grace, then at most another 5,000 ms for observation |
| `maxFrameBytes` | 25 MiB of payload |
| `maxInputBytes`, `maxOutputBytes` | 250 MiB per lease, also capped by original host budget |
| `maxStdoutBytes`, `maxStderrBytes` | 1 MiB each, cumulative per lease |
| `maxRequests` | 1,000 accepted exchanges per lease |

Wire input/output includes the 41-byte frame overhead and startup messages.
Output also includes stdout and stderr; active exchanges count their
diagnostics/wire bytes against their own operation budget. Budget ceilings
default to host `DEFAULT_BUDGETS`; larger request ceilings need an explicit
validated `budgetLimits` from trusted policy. File-pin inspection bounds are
separate from render payload accounting. F06 must leave protocol headroom.
Idle begins after readiness and after each exchange, not during active work.

Pre-admission rejection (foreign context, invalid input, request-count
exhaustion, replay or concurrency) does not disturb a healthy lease. Once
accepted, cancellation, deadline, worker failure, protocol/budget failure or
revoked original authorization retires the **whole** lease and awaits owned
cleanup before returning the failure. No stale response wins cancellation;
there are no retries or success-shaped failure values.

`close()` and `closed` return the same stable cleanup outcome. Cleanup is an
owned capability and remains callable after authorization expiry/cancellation.
It uses a separate finite monotonic-clock allowance, not an already-cancelled
operation clock. Epoch-clock changes cannot extend this allowance.
It requests graceful module closure, then calls
`TerminateJobObject` when needed, polls Job membership and observes Node's
child `close` event. A pre-membership hung worker can additionally be killed
through its **owned direct child handle**, never by process name or PID.

Complete cleanup returns `{workerExitObserved:true, jobEmptyObserved:true,
mode:"graceful"|"forced", exitCode, signal, terminalFailure?}`. Graceful requires
the close ACK and zero worker exit; forced includes crashes. `terminalFailure`
retains the lease's typed failure reason, if any. Complete cleanup is **not**
successful rendering or committed output. OS/handle/query/exit observation or
directory-cleanup errors return `interrupted` with no invented reaping report;
the primary error is retained in the internal error cause chain. An exchange
whose cleanup fails returns `INTERRUPTED` rather than cancellation-shaped
success. Do not reuse such a lease or automatically adopt its leftover temp
directory. Repeated close returns the same evidence, not a new cleanup claim.

The cleanup control frame has a fixed size outside the exhausted request
budget; late output is discarded, separately bounded during cleanup, and
cannot become a render result. Kernel calls are synchronous cooperative
checkpoints, not hard-real-time cancellable calls. Job lifetime containment
does not impose a CPU/memory sandbox or prevent a trusted module's filesystem
or network access; F06 must validate payloads and enforce browser isolation.

## Native dependencies, evidence and F06 handoff

Dependencies: workspace `@design-studio/contracts` and `@design-studio/host`;
exact optional `koffi` **3.2.1**, `@koromix/koffi-win32-x64` **3.2.1** and
`@koromix/koffi-win32-arm64` **3.2.1**. Restore used `--ignore-scripts`, with no
cnoke/compiler/global/admin changes. Native import is lazy; missing bindings
are `unavailable`, never a portable stub. Preserve dependency license notices.
The lock delta adds only this package's importer, reusing existing resolutions.

Observed RED before implementation: missing native Job module, then missing
lease module. Subsequent real regressions exposed the Windows synchronous
pipe deadlock, diagnostic bytes escaping the per-request budget, and revoked
authority leaving a lease idle; all have permanent passing tests.
Additional observed RED/GREEN cases cover primary-error retention on failed
cleanup, monotonic cleanup timing, watch-admission state, and cancellation
during the final asynchronous startup/request-watch teardown.

Windows x64 / Node 24.21.0 evidence uses only new controlled Node workers and
unique owned temporary roots: join before import/descendant creation, denied
membership and malformed IPC, binary exchange, nonce/length/sequence limits,
project/grant/session and identity rejection, cancellation/deadlines,
import failures/hangs, worker crash, stdout/stderr/transport budgets, idle and
hung-close fallback, repeated close, and unchanged native process-handle count
after 100 Job create/close cycles. Injected native-unavailable, membership and
CloseHandle failures are explicitly edge tests, not native containment proof.

The separate-controller death test first observes the worker gone while its
new detached-but-contained Node descendant remains in the Job, then kills
only the controlled owner process. A SYNCHRONIZE-only process handle observes
the descendant exit; it never holds a Job handle. An unrelated sentinel
survives. Detached here avoids Node/libuv's own worker-exit cleanup confound;
the test verifies it **does not break out of this Job**.

Final local evidence: 27 package unit cases and one built-public-package smoke
case passed. The unsupported-host-only case is skipped on this Windows x64
host. Combined host/renderer-host regression execution passed 93 unit cases;
dependency-ordered build, strict root typecheck and scoped Biome checks passed.
The allocation-failure review follow-up adds observed RED/GREEN `ENOSPC` and
`EACCES` cases after real pin/root preflight, asserting no Job/worker creation
or unallocated-path cleanup, plus a programming-error propagation regression.
The follow-up passes all 30 package unit cases (one unsupported-host-only
skip), the built-package smoke case, package build, strict root typecheck and
scoped Biome checks on Windows x64.

Build before typecheck and tests (the real worker loads built internal files):

```text
pnpm build
pnpm typecheck
pnpm exec vitest run packages/renderer-host/tests --project unit
pnpm exec vitest run packages/renderer-host/tests/package.smoke.test.ts --project smoke
pnpm exec biome check packages/renderer-host
```

When deliberately editing the bootstrap, format it to LF first, compute its
SHA-256, update the reviewed constant in `src/index.ts`, rebuild and rerun the
actual worker tests. Git attributes pin `.mjs` line endings; mismatched shipped
bytes fail closed.

F06 should consume the coordinator-integrated public package, configure its
installed trusted implementation and byte envelope, and start with one
exchange per render. Actual Playwright 1.63.0 / Chromium shell 153 r1243,
`chromiumSandbox:true`, nested browser Jobs, profiles, rendering fidelity and
browser/network controls have **not** been acquired, launched or validated
here. Never enable breakaway or disable the sandbox to pass integration.
Windows arm64 and macOS are explicitly unavailable/unverified.
