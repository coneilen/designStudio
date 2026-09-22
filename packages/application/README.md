# @design-studio/application

## Native reference evidence

The separate diagnostic-successor commands require the version-5 native
diagnostic capability in addition to the reference capability. The server
derives `diagnostic_<digest>` from a fixed domain, project, **original** reference
job ID and its exact verified receipt digest; decoder version, policy version
and caller request IDs cannot create another slot. The CLI still selects the
original capture request, never an arbitrary acquisition ID or raw URL.

Eligibility revalidates the original capture/source/URL binding, original
reference request/grant, completed atomic receipt, unavailable HTTP200
`INVALID_INPUT` evidence without a PNG, and exactly one settled known GET.
The old grant may be expired and remains immutable; it cannot authorize the
successor. The fresh proof includes predecessor record/receipt/approval/request/
evidence identities and the separate diagnostic policy. New consent uses a
distinct confirmation and fresh short-lived approval. Current origin, URL expiry,
cooldowns, authority and the complete publication inventory are checked again
before admission. The same physical-read meter, one GET/DNS, 30-second absolute
deadline, 25-MiB byte bounds and pixel/decoder caps apply.

The existing immutable job admission transaction consumes the server-derived
slot once. The new job uses a separate handler/resource key; no original job,
counter, grant, retained stage or receipt is rewritten. Failures also burn the
slot. Historical reference inspection and the original policy hashes/namespaces
remain unchanged; a successor cannot become another predecessor. Planning,
approval and inspection never make an image request.

For captures with a retained failed predecessor, historical filesystem
membership excludes only the exact proof-bound original reference descendant,
after validating its record/receipt hashes, handler, authority, source resource
key, receipt scope and exact protected input/output/stage graph. The original
capture-recovery validator remains unchanged; unrelated jobs, mutations and
uncertain stages are not filtered by timestamps or name prefixes.

The native capture facade separately exposes explicit reference planning,
approval, download and inspection under the installation's closed reference
supplement. Its dedicated read-only proof loader never calls original-capture
reconciliation: it requires an already completed version-pinned capture and
verifies its job, atomic receipt, artifact hashes, source, selected node, version,
bounds and render-map membership. Nodes and source snapshots can exceed 256 KiB
within the aggregate bound; small control artifacts retain a 256 KiB cap.

An immutable offline approval receipt protects the proposal and canonical
reference request, reusing the original committed empty resource snapshot.
Unused expired approvals can be explicitly renewed through a fresh proposal
binding the prior approval hash and next generation (at most 32); lost responses
replay the exact existing grant without extending its deadline. Native ownership
and no-replace receipts serialize renewal races. Any admitted job forbids renewal.
A deterministic `reference-download` job is
reserved before transport and cannot be replaced by changing request IDs.
Independent completion verification binds exact staged image/evidence bytes to
the current original execution. No old source/manifest/result, capture recovery
grant, conversion receipt or capture budget is rewritten. Reference evidence
records dimensions, bounds, scale, color knowledge, counters, errors and the
exact original artifact/version relation. Dimension mismatch or unknown color
remains partial. Conversion/renderer consumption is not part of this capability.

Reference admission may preserve an earlier failed capture's known retained
stage only when the completed successor's protected recovery grant proves the
exact original failed row and historical filesystem digest. The candidate
historical inventory is the protected closure of the remaining immutable jobs,
not a timestamp or filename-prefix guess. Later valid conversion receipts and
private exports remain in the fully checked current graph. Unknown, changed,
foreign, pair-linked or ambiguously published stages still refuse; no stage is
discarded, adopted or relabeled. Histories whose exact committed digest cannot
be reconstructed from that bounded closure require review.

All physical artifact reads, including repeated storage receipt verification,
stage/publication verification and EOF probes, reserve from one invocation-wide
25 MiB private-plus-network allowance before allocation or reads. Small control
artifacts apply their per-read bound before storage verification. The meter stays
owned while service cleanup is unconfirmed; it does not reset between internal
inspection phases. Evidence records private reservations through its preparation;
later publication and response verification remain subject to that same meter.

Reopen is read-only for admitted jobs, including queued/interrupted jobs and
unknown effects; it cannot redispatch network work. A known no-HTTP effect is
distinct from a known denied response or unknown effect. Stages/orphan
publications without the exact historical proof block new admission.
In-process uncertain publication retains the
existing close-only owned recovery object; a crash does not prove publication or
authorize cleanup/adoption. Failures remain actionable and nonretryable without
printing private signed query strings. Bounded service-stop failures retain the
original operation cause separately from the cleanup code, block another
operation, and allow only the original owner's close retry.

F08 fresh synthetic-fixture foundation, based on coordinator-approved
`6b079c7efb958d2946b506203f8866f095385908` plus reviewed storage, host and
installation prerequisites. This is not a general-purpose design studio or an
approved production installation.

Implemented modules use authoritative contracts 1.4.0 (artifact/provider schema
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
exercise only Origin/CSRF guards. The fixture profile exposes no Figma, handoff compiler, model, device,
vault, app installation, arbitrary file import or live user-data workflow exists.

## Separate native selected-frame capture

`@design-studio/application/capture` exports `openNativeCapture(project)`, with
no root, vault, transport, grant or authorization callback overrides. It accepts
only a live native capture-profile project, not the fixture profile or a copied
object. `execute({operation, requestId, ...}, signal)` supports capture (explicit
single-frame URL), inspect, source-bound draft conversion and explicit artifact
output to a single safe filename in that project's private outputs root.
The runtime is an owned facade; cloning its methods into a foreign facade does
not establish admission. The caller must await `close()` before closing the
project/installation. Failed or cancelled execution is not quiescence proof:
close joins the existing JobService and original callbacks, then closes store,
filesystem and native work loan. A retained close/startup cleanup error must be
retried by its owner; it never authorizes a replacement network attempt.
Native capture uses `closePreservingStages`, not ordinary unpublished-file
discard: unknown spent effects keep their private original stage bytes, stage
directories and existing job journal identities across shutdown/reopen.
Closing a quiescent boundary is not completed recovery or permission to retry,
adopt or delete retained source. Visible uncertain publication still refuses
closure and retains its exact reconciliation metadata.

The runtime retains an exact private ledger for uncertain job, intake,
conversion and export publications. After joining JobService/original work,
close performs one current-authorized cleanup pass **before** releasing the
store/filesystem. Only the retained, already-visible publication can resume;
cleanup contexts have no provider/credential/egress authority and never renew
the original work deadline or commit a job/legacy receipt. A resolved flush
does not retroactively make the failed command successful.
`NativeCaptureCleanupRequired` carries sanitized original/cleanup codes,
nonsecret pending identities and a close-only retry owner. A five-second
acknowledgement bound can return that owner while the original cleanup promise
remains tracked; subsequent retries join it rather than starting another pass.
No resource is reported closed merely because the acknowledgement timed out.

Inspection/replay under the actual exclusive native writer loan does not infer
a live executor from a saved queued/running state or an unexpired lease.
This synchronous facade denies concurrent execution and joins its own service.
Other nonterminal execution records are conservatively quarantined through
the existing F07 recovery policy/repository, preserving original deadlines,
unknown/reserved effects and stage identities. No vault read, network replay,
new completion receipt or conversion/export acceptance is implied. An orphaned
capture returns interrupted/action-required, not accepted.

`recover({operation: "recover", requestId, failedJobId, nextRequestId, ...},
signal)` is a separate offline method on the same owned facade. It requires
native admission of the closed recovery-policy supplement and never calls
credential readiness, vault use or the scheduler. Without confirmation it
returns bounded proposal facts; with the exact proof and versioned confirmation
literal it commits one immutable authorization artifact/receipt. It does not
reconcile, relabel, overwrite or restart the failed job.

The proof includes the exact original row/version/generation, effects and usage,
canonical input/resources, credential-journal fingerprint, policy identities,
private stage/receipt/reference graph, and one normalized next request.
The admitted one-attempt histories are direct failure (job generation 1) and
the native stopped-handler interruption/resolution path (job generation 3).
Both retain execution fence 1; the source resource's reservation generation is
an independent counter across jobs and must only describe a released resource.
Retained stages must match the original attempt, expected disposition and one
consistent historical lease/host/fence group. No current lease is invented for
a stopped job, and unsupported restoration/requeue histories remain refused.
Native-scoped inspection verifies retained stage bytes read-only and refuses
unowned stages, missing/aliased bytes or ambiguous publication. Ordinary
completed stage journal rows are accepted only with their exact committed output
receipt; they are not treated as permission to adopt an unfinished publication.
Export-root files without an established persistent ownership proof remain
unsupported for this action. Response/quota/credential validity remain unknown;
known future or indeterminate rate-limit constraints are never waived.

Replay compares the immutable original snapshot separately from exactly verified
authorization, seed and successor writes. Only exact identities, contents,
receipts and protected references are projected out, never a name/prefix family.
The source resource's successor fence must match that one bound job. Receipt
insertion and successor submission each recheck storage state inside their
SQLite transaction. Successor insertion is durable consumption, with no mutable
spent flag or gap between spending and job creation. Its handler rechecks the
authorization before credential/provider work. The exclusive native project
loan and facade execution exclusion serialize app processes and in-process work;
this remains a trusted-current-user boundary, not a hostile same-user sandbox.

The recovered successor's fixed resources already have a protected receipt.
After its seed commit, only that invocation's redundant resource stage is
released under its original host owner. No old stage is deleted. A crash leaving
that unjournaled intake residue refuses later recovery rather than adopting it.
Exact committed acknowledgment replay survives reopen and successor insertion;
publication uncertainty retains existing close-only ownership. A failed
successor creates no new grant, and the original grant never covers a third
request, even after a successful successor. No HTTP recovery route is added.

Each command snapshots input before awaits. Native authority fixes current
actor/project/credential and scopes, retains the scheduler's exact work signal,
and caps the original 30-second capture deadline by authorization/declared
credential expiry. Installed-code/Node verification is startup, not a reset
inside the work deadline. The composition alone opts its filesystem into the
four-call capture budget; shared filesystem defaults remain unchanged.
Only the requested job is schedulable. Existing owner discovery, SQLite jobs,
effect reservations, stages and fenced receipt commit provide idempotency and
persisted cooldown/unknown-effect refusal; there is no new database schema or
automatic retry. Replay inspects existing evidence without reading the vault
or repeating network calls, under fresh current native authority.

The facade starts the existing scheduler for the whole active attempt, rather
than running one admission turn and only waiting. Default 100-ms turns renew the
unchanged five-second lease while asynchronous provider work is pending.
Submission/start/wait are enclosed by bounded stop-and-join on every exit;
failed shutdown retains the service and original failure for close-only retry.
Completed observer turns retire their own authority, so a capture can exceed
128 turns without exhausting the native authority's unchanged 128-live-context
cap. Worker authority, current-policy checks, original signals, the 30-second
deadline, four-call/four-DNS limits and no-retry behavior remain unchanged.

This is not a latency guarantee for native staging or finalization. Heartbeats
share the execution/storage serialization lanes, and timers cannot run while
synchronous native I/O blocks the event loop. A stage or commit that itself
outlives the lease still fails closed; no parallel unfenced renewal is added.
Synthetic facade regressions use real authority/jobs/SQLite/capture with mocked
native admission, synthetic credentials, in-memory filesystem durability and
provider responses. They
cover six- and 28-second provider delays, more than 128 default-rate turns,
original provider-error evidence, cancellation/deadline, exceptional exits,
retained bounded-stop ownership and expired serialized finalization. They do
not exercise installed/native-I/O latency, a real vault or Figma.

Authenticated conversion takes no artifact/hash/proof argument. It reloads the
actual private capture job, matching actor, logical request, installed policy,
handler/version, settled effects, committed receipt, canonical request,
manifest, source and exact raw artifacts. The neutral converter issues no
identity. Original nodes-envelope bytes and selected pointers stay unchanged
even when extra API siblings exist; only the selected subtree is converted.
Source maps name the actual physical SourceSnapshot; projection evidence and
output descriptors name physical byte hashes. The draft resource lock retains
the companion snapshot's logical ID and canonical byte hash (not an impossible
self-referential physical ID). The existing core consumes that companion
snapshot directly; no new logical-store authority is inferred. Conversion uses existing
standalone stage/commit receipts and remains blocked or needs-review, never
render-ready, approved or an implementation handoff. Missing fonts, fills,
rights, unsupported structures and reference limitations remain explicit.

Conversion design identity and standalone operation receipts now bind the
trusted current converter policy (`fixed-v2`, implementation revision 0.3.0).
An already converted capture can produce a distinct corrected v2 draft without
overwriting its prior v1 receipt or artifacts. Explicit legacy replay retains
the original v1 identity formulas; candidate output never selects a downgrade.
The internal conversion helper does not authenticate a capture or expose a new
caller policy/receipt injection surface: committed-source admission remains in
the native composition. Synthetic portable SQLite tests cover old-receipt
reopening, policy coexistence, deterministic reuse and integrity rejection;
they do not start a native application or perform live reconversion.

Synthetic integration tests exercise the actual native dispatcher/private
project/database/jobs/capture code with synthetic vault bytes and a local TLS
server through test-module mocks only. The copied SQLite role is inventoried
and attested, but a test-only LocalStore spy loads the **hash-identical approved
test binary** outside the disposable installation: Windows retains mapped DLLs
until process exit. This is **not exact installed-role DLL-load proof**.
There is no corresponding production override. Those integration tests exercise
no real user entry or Figma request.

Separate supervised evidence now covers one dummy-only native dialog cancellation
path: READY, user-confirmed masking/multiline rejection/Cancel, ERROR 1/CLOSED 3,
confirmed scrub, normal helper exit, empty Job and exact owned TEMP cleanup.
Earlier failed native attempts are retained privately. A separate current-user
Windows byte-backend check also passed fresh absence/write/read equality/delete/
absence through the pinned default adapter after correcting measured native
null/numeric-array return forms; no dummy entry remains.

Neither check establishes full installed enrollment, real PAT validity, all
native failure/timeout paths or repeatable production startup cost. Exact user
release/dependency/DLL approval, fresh real project/enrollment, Figma permission/
seat/quota, asset/font rights and independent CDN-origin policy remain explicit
later gates. No real Figma capture, user capture installation or model upload has
occurred. Default empty CDN origins produce truthful three-call partial capture
before contacting the returned host. Private evidence and test key names are
not repository fixtures.

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

**Full-runtime finding:** ordinary installed completion was intermittent, and
the original 56-60-second checkpoint cause was not established. Those baseline
runs did not authorize further runs, deadline/cache/coalescing/yield changes or
release packaging. Later profile-design approval and bounded repeats are
documented separately below.

The user subsequently approved the fixed minimal Node **packaging design**:
unchanged pinned `node.exe` plus original `LICENSE`, with all application,
browser and native dependencies retained. The packager implements that selection,
not a reduction in per-shipped-file verification. The two retained runs above
predate this profile; they are not minimal-profile performance evidence.
The separately reviewed repeats below do not approve an exact release or live
installation.

### Approved minimal-profile repeatability

Production profile commit `28aca32148d34e42db2882b50e70b3c285f74c29` was followed
by one explicitly approved owned run, then two explicitly approved sequential
repeats with an early-stop rule for failure or an observed interval of at least
30 seconds. The exact-runtime assertion was committed as `905d34c` before the
repeats; it had already passed in the first run. All three used identical
production/test code, offline inputs and version-two instrumentation. Shipped
documentation was held unchanged until all repeats finished. Each fresh owned
KnownFolder/diagnostic destination was necessarily distinct.

All three artifacts record **`functionalPassed: true`, `captureComplete: true`**:
actual initialization, private-pipe acceptance, completed render with six receipt
outputs, verified preview, observed owned process exits and cleanup passed.
Before installation, the decoded bootstrap inventory was asserted to contain
**exactly** `runtime/node.exe` and `runtime/LICENSE` with the approved lengths and
hashes. Full startup hashing, current checks, native pins/ACLs, guards and
quiescence remained unchanged, as did the original 30-second command/job budgets
and installed 15-second authority allowance capped by remaining job lifetime.

| Measurement | Minimal 01 | Minimal 02 | Minimal 03 |
| --- | ---: | ---: | ---: |
| Whole test including assembly/cleanup | 268.99 s | 268.93 s | 268.56 s |
| Inventoried files | 3,354 | 3,354 | 3,354 |
| Inventoried bytes | 432,861,345 | 432,861,345 | 432,861,345 |
| Parent startup / full recheck | 3,507 / 3,687 ms | 3,644 / 3,887 ms | 3,935 / 3,905 ms |
| Three serial current checks | 1,938 / 1,816 / 1,868 ms | 2,093 / 2,038 / 2,115 ms | 2,020 / 2,052 / 2,006 ms |
| Nine-way stress batch | 16,830 ms | 16,982 ms | 16,318 ms |
| Render service current maximum / active count | 4,121.5 ms / 2 | 3,980.9 ms / 2 | 4,026.7 ms / 2 |
| Worker opening interval | 7,151.3 ms | 6,510.6 ms | 6,947.7 ms |
| Renderer full verification | 3,894.4 ms | 3,651.0 ms | 3,847.6 ms |
| Service maximum heartbeat gap | 4,197.0 ms | 4,249.1 ms | 4,232.1 ms |
| Maximum heartbeat gap across processes | 4,512.0 ms | 4,494.6 ms | 4,273.5 ms |
| Bootstrap startup range across processes | 3.706-4.051 s | 3.480-4.029 s | 3.462-3.722 s |
| Payload startup range, including renderer | 3.894-4.322 s | 3.651-4.314 s | 3.763-4.096 s |

Every run retained 15 complete reports (eight bootstrap, seven payload); the
additional pair compared with the failed baseline is the now-reached preview
process. All report faults/incomplete indicators were zero. After each cleanup,
the artifact was independently re-read through the strict parser and checked
for exact inventory totals and the early-stop threshold before proceeding.
No checkpoint/startup/worker/heartbeat outlier reached that threshold; the largest
assessed interval in each run was its separately labeled nine-way stress batch.
That batch is not a nine-client or nine-way authority success guarantee.

The reduction versus `baseline-02.json` is **exactly 1,992 files**, with no observer
file-count change. Counts exclude the two outer inventories, which remain
verified. The net byte reduction of 13,217,855 reconciles to the 13,245,848-byte
runtime reduction minus 27,993 bytes of intervening copied README edits
(application two copies: 12,222; CLI two: 456; project-host three: 15,315).
The measured totals predate this result documentation and are not a final
unchanged-code release inventory.

The first minimal run's five render-service current checks totaled 12,917 ms
elapsed; enumeration/file-pin/release maxima were 2,242/1,664/141 ms and sampled
RSS peaked at 381 MiB. Service inclusive native totals were open 6,032 ms,
inspect 8,338 ms, ACL 2,263 ms, pin 10,228 ms and hash 1,774 ms. Corresponding
second-run totals were 5,803/8,032/2,150/9,960/1,774 ms and third-run totals
5,761/8,270/2,163/9,868/1,751 ms. These nested groups include other project-host
activity and must not be added as disjoint costs. No individual checked native
open/inspect/pin operation showed a comparable multi-second stall.

Artifacts remain beside the baselines in the same session's
`files\installation-runs` directory:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `minimal-profile-01.json` | 41,044 | `be18be191453af4f171615f1b48b2ce6bb058900ee4b328adde7979a95554f5c` |
| `minimal-profile-02.json` | 41,068 | `94e0b2a52307bfd212adff9a6282a86367d9a45db5bdf9e3f537fcc605c8cf5a` |
| `minimal-profile-03.json` | 41,194 | `b5e63e5bceac9005de1b83498aa03f78bb5a393d8694519f289dae2496591907` |

**Conclusion and remaining gate:** removing unused runtime tooling demonstrably
reduced verified closure work, and three sequential actual flows establish
bounded repeatability for this workload with ordinary two-check overlap.
They do **not** establish a statistical latency guarantee, a two-second profile,
or the root cause/elimination of the historical 26/56-second outliers. No fourth
run, automatic retry, new optimization, release candidate or production install
was authorized by these results. Final integrated-code release packaging and
exact user bootstrap/payload approval remain separate review gates.
