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
  acceptance pass in the owned test namespace. Actual installed rendering
  currently waits for action because repeated full-closure rechecks measured
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
return before inventory, so all children use one newly owned test root. Its F08
CLI and renderer entries are real and unchanged. These test-only inventories
must never be reused as approval for a real release.
Browser enrollment/navigation is not supported; preissued-cookie HTTP tests
exercise only Origin/CSRF guards. No Figma, handoff compiler, model, device,
vault, app installation, arbitrary file import or live user-data workflow exists.

## Boundary conventions

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
original functional result and fail diagnostic validation. The reporting fix
has focused owned-temporary tests; the full installed run was not repeated.
