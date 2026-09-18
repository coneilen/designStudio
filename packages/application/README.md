# @design-studio/application

F08 fresh synthetic-fixture foundation, based on coordinator-approved
`6b079c7efb958d2946b506203f8866f095385908` plus reviewed storage, host and
installation prerequisites. This is not a general-purpose design studio or an
approved production installation.

Implemented modules use authoritative contracts 1.1.0 (artifact/provider schema
1.0): validated response/exit mapping, exact original catalog verification,
current-policy session issuance, bounded authenticated HTTP dispatch, generated
OpenAPI, staged F06 job-handler composition, and quiescence-sensitive shutdown.
The shared native facade now accepts unchanged fixtures through actual F05/F02,
logical-reference bindings and one F03 v4 transaction; reopens registered roots,
discovers owned jobs, issues fresh exact grants and uses durable conditional
cancellation. Native direct-facade and HTTP-client parity are exercised.

The application must establish trusted installation configuration **before**
opening the project registry/store/listener. Catalog hashes and
`trustedImmutableInstallation: true` do not establish that trust. No CLI,
environment, HTTP or deserialized authorization value can turn it on.

## Evidence and remaining release limitations

- Storage v4 logical-reference binding and owner descriptor discovery are
  coordinator-reviewed and integrated. The facade validates bindings against
  the exact installed catalog while retaining unmodified physical artifacts.
  Discovery is native-current-owner authorized before lookup; it grants no
  execution or receipt-success authority by itself.
- The observed long-path `Native open failed (Win32 3)` regression is resolved
  by coordinator-approved host fix `12d95f3` (local adoption `a7eba4a`). The
  actual owned registered-root smoke now publishes successfully and separately
  verifies the expected pre-v4 logical-reference failure. This is not full
  fixture acceptance evidence.
- A fixed installed executable/dependency/configuration trust boundary is still
  required for the shipped launcher. The reviewed offline installation verifier
  is integrated and actual installed fixture initialization and private-pipe
  acceptance pass in the owned test namespace. An early actual installed render
  waited for action because repeated full-closure rechecks measured
  6.3--6.6 seconds (12.3 seconds concurrently), exceeding the unchanged 5-second
  execution-authority allowance. The reviewed native current-state checkpoint
  is now integrated: actual 5,314-file / 445,940,054-byte test closure measured
  3.38--3.52 seconds serially but 6.32 seconds during ordinary issuance/read
  contention (nine concurrent checks: 27.39 seconds batch). All fresh metadata,
  ACL, namespace, registration and principal checks remain; only pinned bytes'
  repeated SHA streams are omitted. The user approved an installed-profile-only
  15-second authority allowance, capped by remaining original absolute job
  deadline; shared F07 defaults remain 5 seconds and overall job/request limits
  remain 30 seconds. This is not a nine-way concurrency success guarantee.
  The remaining-deadline cap is integrated; no retries or deadline reset are
  introduced.
  The next owned installed run with that approved allowance still failed under
  substantially higher contention: current checks took 56--60 seconds and
  exceeded the unchanged absolute budget. Installed rendering is therefore
  **intermittently unreliable** under the tested contention. Successful
  noninstalled native rendering is not substituted for installed-distribution
  evidence.
  A separate count-matched synthetic metadata probe (5,318 files, 377 directories,
  0.914 MB) measured 2.35 seconds serial / 4.56 seconds paired with the idle pin
  topology. It demonstrated roughly two-second synchronous metadata stalls and
  queue amplification but did not reproduce the actual 56-second failure.
  It is not the same byte/directory workload as the actual installed candidate.
  One subsequent phase-instrumented actual installed run passed in 382.78 seconds
  including candidate assembly/installation: real F08 initialization, private-pipe
  launcher/service acceptance, render completion with six receipt outputs,
  verified draft preview and observed process exits/cleanup. The test used
  disclosed copied native KnownFolder and diagnostic hooks before inventories;
  it is not an unmodified user installation. Numeric phase files passed strict
  validation, but successful console output was suppressed and those files were
  cleaned, so no phase artifact survived. This single functional pass does not
  resolve the previous 56--60-second failure, prove repeatable latency, or meet a
  performance/release gate. No retry was run merely to recover those logs.
- The observed Playwright `ENAMETOOLONG` failure beneath the registered private
  temp root is resolved by approved same-directory worker TEMP encoding
  `5b3db15` (local `0be0711`). All five actual fixture accept/render/job/PNG flows
  pass with sandbox, Job containment and private roots unchanged. Unsupported
  content completes only as explicit partial inspection, never strict fidelity.

The offline installation mechanism is implemented; approval of the final exact
bootstrap and payload inventories remains a separate user decision. No real user
release or installation was approved/executed. Existing-store migration backup
durability remains unavailable.
The actual installed-flow candidate modifies only the copied native KnownFolder
return and disclosed diagnostic hooks before inventory, so all children use one
newly owned test root. Its F08 CLI and renderer entries are real and unchanged.
These test-only inventories
must never be reused as approval for a real release.
Browser enrollment/navigation is not supported; preissued-cookie HTTP tests
exercise only Origin/CSRF guards. No Figma, handoff compiler, model, device,
vault, app installation, arbitrary file import or live user-data workflow exists.

## Boundary conventions

Validated success envelopes and final facade JSON/binary results are detached
snapshots. Callers may mutate returned designs, resource locks, revision metadata,
diagnostics or receipt descriptors without altering the installed fixture policy,
canonical accepted bytes, or later authorization/discovery decisions. Validation
alone does not provide object ownership; the return boundary explicitly copies
nested state and never freezes caller-owned inputs.

Artifact download metadata, content and local output publication share one frozen
command operation: request identity, absolute deadline, monotonic epoch clock and
live cancellation signal. Installed freshness checks, current-principal issuance,
native staging/publication, durability and final binding checks cannot start a
new timeout or extend that deadline. Pending callbacks are awaited to actual
settlement; project/installation close refuses while a publication is active.
An expiry does not roll back a native rename: already visible or uncertain bytes
remain for inspection, never silently discarded or reported as a fresh success.

Only the native download path can retain private, object-bound completion evidence
after **all** publication, durability and current-policy checks finish within the
original deadline. It binds the exact returned physical artifact, original command
object/identity/deadline/clock/signal, output root/path/hash and source descriptor.
That single-use evidence permits delivery after completed cleanup even if the
deadline has since expired. A generic delayed publisher, copied result, different
command, or unfinished/expired verification cannot manufacture that exception.
No schema, persistent receipt, approval or generalized authorization is added.

HTTP authenticates exact loopback Host/peer and raw singleton headers before
dispatch. CLI bearer rejects browser Origin/Cookie/Fetch-Metadata; cookie mode
requires exact Origin even for GET and independent CSRF for unsafe methods.
No unauthenticated bootstrap/health/static route. Bodies are JSON control messages
at most 64 KiB; headers 16 KiB, target 2 KiB, socket ceiling 32 and admitted
request ceiling 8. Framing ambiguity, compression and upgrades are rejected.
Messages and logs never contain client payloads, credential values or raw errors.

The response boundary distinguishes accepted jobs, queried state, terminal work
and comparison verdict. Job responses use `FoundationVersionedJobResponse`.
Logical request/idempotency identity is independent of physical trace IDs.
Staged rendering injects F07's stage-only fenced filesystem; only F07 may commit
the final job/receipt/outputs transaction. Stop must report real callback
quiescence, including pending authority/recovery calls, before releasing storage.
Fresh render output IDs are not known at token issuance. A private, bounded
current-attempt capability is recorded only after the actual F07 fenced stage
adapter returns a complete journaled physical receipt. It binds original proof,
actor/project/job/request, attempt/generation/lease and exact staging/hash/path
metadata. The store authorizer permits only the exact artifact **write**, after
live original-proof and root-write checks. No read or other resource grant is
inferred, no token is cloned/widened, and F03 still enforces fence/journal/barrier/
completion validation. Partial, stale, imported or caller-described stages do
not create capabilities. Settlement/quiescent shutdown drops them.

Observers discover newly committed output references under current native-owner
policy and obtain fresh ordinary read grants; they never borrow write capabilities.
The original wait deadline/signal/actor remain fixed. A bounded refresh handles
only the completion transition between descriptor lookup and byte-verified get.
F07's preliminary conservative interruption requires an exact purpose-scoped
recovery proof; retry, resolved state and cleanup additionally require a trusted
decision. Authorization failures remain typed failures, not silent timeout loops.
Completed/failed intake may leave redundant or uncertain staged files: shutdown
revokes the retired host boundary rather than invoking its discard-all close
while evidence remains. Registered roots persist; no recovery deletion or approval
is implied. Native fixtures are limited to the one installed synthetic project
and at most 100 retained application jobs; no implicit pruning is performed.

Build before tests; use the existing pinned Node/pnpm and workspace tools.
Scoped unit tests use fake or owned inputs; the native smoke uses only the
existing internal KnownFolder seam in a newly owned temporary root. It never
provisions the user's actual LocalAppData. No installs or browser downloads occur
inside tests.

## Validation commands

Build dependencies before strict typechecking. Unit and noninstalled native suites
use existing workspace tooling; `F06_RENDER_SMOKE=1` enables all five actual
renderer flows without changing goldens or performance reports.

```powershell
pnpm --filter @design-studio/application... build
pnpm --filter @design-studio/cli build
pnpm typecheck
pnpm exec vitest run --project unit --project smoke packages\application\tests packages\cli\tests
pnpm --filter @design-studio/application openapi:check
pnpm exec biome check packages\application packages\cli
```

The costly, explicitly gated installed test additionally requires
`F08_INSTALL_GATE=1`, approved existing offline test cache/store paths and
`F08_DIAGNOSTIC_ARTIFACT` naming a new file in an existing real test-run artifact
directory. This is test-only reporting configuration, never production CLI
authority or a project destination override. Reports are strictly bounded and
validated numeric data, written before candidate cleanup; failures preserve the
original functional result and fail diagnostic validation. The retained runs and the remaining reliability blocker are detailed below.

## Retained installed diagnostics

Two sequential, separately authorized Windows x64 / Node 24.21.0 diagnostic
runs used merged production source `c3f8941429ff7fd62d957ab5b5d184a49e586882`.
Only the candidate copies received the exact owned KnownFolder seam and phase
instrumentation before inventory. No production checks, guards, native sharing,
authority allowances, deadlines or catalogs changed. These are test candidates,
not user-approved release inventories.

| Measurement | `baseline-01.json` | `baseline-02.json` |
| --- | ---: | ---: |
| Whole test including assembly/cleanup | 473.50 s | 403.98 s |
| Functional outcome | Completed, six outputs, verified preview | `DEADLINE_EXCEEDED` during render observation; preview not reached |
| Capture complete | Yes, seven payload reports | Yes, seven bootstrap and six payload reports |
| Inventoried files / bytes | 5,343 / 446,069,619 | 5,346 / 446,079,200 |
| Parent startup / full recheck | 5,670 / 5,892 ms | 5,606 / 5,727 ms |
| Parent serial current checks | 3,506 / 3,421 / 3,482 ms | 3,448 / 3,278 / 3,536 ms |
| Nine-way stress batch | 27,187 ms | 26,633 ms |
| Render service maximum current check / active count | 6,234 ms / 2 | 6,638 ms / 2 |

File/byte totals exclude the two outer inventory files; every native check also
opens those files. The nine-way batch is stress evidence, not an ordinary
concurrent-success guarantee or a new accepted budget. Child birth identities
and actual OS exits were observed before reading reports; reports were persisted
before test-root cleanup and independently revalidated afterward. The artifact
envelope deliberately separates `functionalPassed` from `captureComplete`.

Retained files are in the originating session's
`files\installation-runs` artifact directory (session
`73f99cfb-79f9-4e57-bb60-24589454ad92`), not inside the cleaned installations:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `baseline-01.json` | 11,534 | `21a929a183a78a3f24b135891abf37cecb1c8d33fa7cfaa4dc8c9d025d876907` |
| `baseline-02.json` | 34,413 | `e699f97c62c1160768983fd5c931694e6faad9e4bab70143447638b94c813ec3` |

The first successful run still had a **26,555 ms** initial payload verification
and **26,379 ms** maximum heartbeat gap. Its observer captured only checkpoint
phases, not startup internals. The second run added startup phases, process
CPU/RSS deltas and bounded inclusive timings around complete checked
`open`, `inspectHandle`, `checkAcl`, `pin` and `checkHash` operations. It did
**not** reproduce that outlier or the historical 56-60-second checks.
Bootstrap startup verification ranged from 5.07 to 6.94 seconds; payload startup
verification ranged from 5.46 to 6.43 seconds (including the renderer).

In the second render service, the five current checks totaled 21,411 ms elapsed,
with maximum enumeration 3,546 ms, file-pin loop 2,723 ms and sampled RSS
417 MiB. Summed per-check process CPU deltas were 10,703 ms user / 10,422 ms
system. Overlapping checks include sibling process work, so these CPU deltas
are **not** exclusive per-request attribution. Process-wide native timing
totals were open 9,369 ms, inspect 11,607 ms, ACL 3,276 ms, pin 16,498 ms and
hash 2,059 ms. These groups are **nested/inclusive**, include other project-host
activity and must not be added as disjoint costs. Maximum individual checked
open/inspect/pin calls were approximately 3/6/6 ms, not multi-second stalls.
Different observer cost and copied closure bytes prevent treating the two runs
as a controlled production performance improvement/regression.

The second renderer actually started: relative to service process birth,
claim was 45.844 s, worker open 46.695 s, renderer verification 49.052-54.928 s,
and worker opened 55.699 s. The client's bootstrap finished at service-relative
30.233 s. CLI command timing begins **after** bootstrap/main/session setup,
not at outer/service launch. If dispatch began promptly after that bootstrap,
worker opening used about 25.5 seconds of the 30-second command window, leaving
about 4.5 seconds for rendering, fenced publication and observation. This is
an approximation: command-start and per-check absolute timestamps were not
retained. Source establishes one CLI deadline across design GET, render POST
and wait GET, while the job has its separately persisted original submission
deadline. The failure proves an **observation timeout**, not a failed job or
an absent/present final receipt. No final job state was recovered or invented.

The test-only collector now imports from copied `installation.js`, rather than
`index.js`, because the bootstrap preflight imports the former directly.
Both copies are inventoried before execution; the unchanged builtin-only
preflight verifies the bootstrap module inventory and installs its guard
**before** importing the observer's nonbuiltin dependencies. The earliest
builtin-only preflight itself remains uninstrumented. Native timings wrap whole
checked JS operations, never interpose between FFI failure and `GetLastError`.
Sampling failures preserve operation results/errors, mark capture incomplete
and fail reporting after quiescence. Version-two reports remain bounded to
16 KiB and strict numeric/enum fields; version-one artifacts remain readable.

**Remaining blocker:** ordinary installed completion is still intermittent,
and the original 56-60-second checkpoint cause remains unknown. No third run,
deadline increase, cache/coalescing/yield change or release candidate is implied.
Repeated reliable actual completion and exact user bootstrap/payload approval
remain separate gates.
