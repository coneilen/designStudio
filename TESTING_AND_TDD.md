# Testing and TDD

## F00 acceptance

Acceptance was defined before the package implementation:

- Install one locked TypeScript workspace and build an importable ESM package.
- Match known SHA-256 answers for synthetic bytes, including empty input and a
  bounded view into a larger buffer; repeat without mutating the input.
- Distinguish binary changes and CRLF versus LF rather than normalize bytes.
- Import the built package by its public name in real Node, preserving binary
  bytes and paths containing spaces, non-ASCII characters, and shell metacharacters.
- Propagate missing input as a nonzero consumer exit, not a success-shaped digest.
- Use the same shell-independent scripts on the Windows/macOS CI matrix.

The five unit tests exercise source behavior. Two offline smoke tests exercise
the workspace dependency link, export map, emitted JavaScript, Node built-ins,
argument-array launch, temporary working directories, and error propagation.
Smoke deliberately fails without a prior build; Vitest cannot silently substitute
TypeScript source for the external Node consumer's compiled import.

The package is only a fixture-byte harness. These tests provide no evidence for
DesignIR, source consistency, render fidelity, readiness/approval, golden screens,
Figma access, model quality, adb, or iOS tooling. Product contracts and appropriate
integration/schema/golden tests belong to later approved work.

## Required development loop

Write a behavioral acceptance/regression test, run it, and inspect the expected
RED reason before implementation. Implement the minimum behavior, observe GREEN,
then refactor with the relevant suite still green. Commit the passing test and
implementation together; a deliberately broken commit is not necessary.

Use deterministic synthetic fixtures for the fast suite. Later permission-cleared
external recordings need capture/version/capability metadata and explicit review.
Do not update golden expectations blindly. Live integration tests must be separate
and explicitly authorized; fakes do not prove external feasibility.

## Observed bootstrap evidence (2026-09-16)

Host: Windows 10.0.26200 x64. System Node was 22.14.0 and was not changed.
A workspace-local official Node archive was verified and executed as 24.21.0:

```text
node-v24.21.0-win-x64.zip
SHA-256: 158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541
```

Commands below ran with the per-shell setup in DEVELOPMENT.md. pnpm and tool
versions were also executed, not inferred only from manifests.

| Step | Actual command | Observed result |
| --- | --- | --- |
| RED | `npx --yes pnpm@11.26.0 test:unit` | Exit 1: `Cannot find module '../src/index.js'`; implementation intentionally absent. Vitest 5.0.0 was the initial candidate. |
| GREEN | Same unit command after the five-line implementation | Exit 0, five tests passed. |
| Package RED | `npx --yes pnpm@11.26.0 test:smoke` before first build | Exit 1, both tests failed because `dist/index.js` was absent. |
| Package GREEN | `npx --yes pnpm@11.26.0 build`, then `test:smoke` | Both exit 0, two smoke tests passed. |
| Compatibility correction | `npx --yes pnpm@11.26.0 typecheck` | Vitest 5 declarations failed; changed to 4.1.11 and reran successfully without weakening strict compiler settings. |
| Refactor | Shared bounded test-process helper and explicit `.mjs` consumer instead of inline eval | Final pinned runner: five unit and two smoke tests passed; temporary working directory now also contains spaces. |
| Frozen restore | `npx --yes pnpm@11.26.0 install --frozen-lockfile --registry=<existing mirror canonical endpoint>` | Exit 0 with the portable, pnpm-generated lockfile; no host URLs in that lockfile. |
| Static/compiler checks | `npx --yes pnpm@11.26.0 format`, `typecheck`, `build` | Exit 0; format normalized new Windows-created files to the repository's LF policy. |
| Final Windows gate | `lint`, `typecheck`, `build`, `test:unit`, `test:smoke`, each via `npx --yes pnpm@11.26.0` | All exit 0; 11 files pass Biome, five unit tests and two smoke tests pass. A separate fresh frozen install downloaded/validated all 50 selected Windows packages. |
| Package contents | `npx --yes pnpm@11.26.0 --dir packages/workspace-smoke pack --pack-destination <temporary directory>` | Exit 0; tarball contains only `dist/index.js`, `dist/index.d.ts`, and `package.json`. Nothing was published. |
| Workflow static check | `.tools\actionlint\actionlint.exe .github\workflows\ci.yml` | Exit 0 with actionlint 1.7.12, downloaded from its official release and SHA-256 verified. Not a hosted CI execution. |

The smoke binary fixture `00 ff 0d 0a 61 62 63` has the independent .NET
`SHA256.HashData` oracle
`6c054d2caf0b5ac869dac381d6995fba75212ea0532f3500bacac9a344378802`.
The empty/`abc` unit cases use standard known-answer digests, not expectations
computed with the function under test.

## Running and interpreting checks

### Default unit and hardware-native phases

`pnpm test` and `pnpm test:unit` run a membership check, portable tests with two
workers, then the exact hardware-native inventory with one worker and no file
parallelism. Both phases are failure-gated; the workflow shows them as separate
steps and does not run the combined command again. This intentionally changes
native test scheduling, not product authorization, lease or time-budget rules.

The overall Workspace CI job watchdog is **45 minutes**. The earlier increase
from 15 to 25 minutes covered two local phases measured at 851.19 seconds.
With expanded coverage, hosted run `35952509962` passed all 146 portable files
in 1181.45 seconds and all 27 native files in 234.14 seconds, plus roughly
50 seconds of setup/build work. The 25-minute job watchdog then cancelled smoke
about 33 seconds after it started; smoke was **incomplete, not passed**.
The 25-to-35-minute change is a bounded infrastructure allowance, not a runtime
performance guarantee or a per-test, hook, product deadline, lease or operation-
budget increase. Existing 5-second tests and the explicit 60-second cold native
driver keep their limits. All assertions and sequential phases remain failure-
gated; no retries, `continue-on-error`, worker, partition, skip or cache changes
are introduced.

The subsequent 35-to-45-minute increase adds ten minutes of bounded **overall
job** headroom. Hosted run `36187615159` at `edaba07` passed all 150 portable
files (2,286 tests, four skips) in 1352.74 seconds; the portable workflow step
took 22 minutes 35 seconds. Native testing then ran for 11 minutes 31 seconds
before the 35-minute job watchdog cancelled the job. Only seven of 27 native
file summaries were present, with no reported test failure or timeout; native
completion was **not established**, and smoke was **skipped**. The full hosted
native cost remains unknown. Forty-five minutes is bounded headroom, not a
completion guarantee: all remaining native and smoke tests must actually pass.
Test/hook allowances, native 30-second/25-MiB limits, workers, partition,
step order and failure gates are unchanged. The portable pass does not prove
the earlier six timeout causes fixed, and observer timestamps must be used
rather than buffered reporter delivery times when comparing phases.

Two non-timing reference-fixture groups explicitly use a fixed synthetic policy
clock: the realistic diagnostic input-budget case, and the retained predecessor
proof/state/graph/export table. Their prerequisite captures and legacy-reference
receipts must be established before those assertions are meaningful; hosted I/O
duration is not the behavior these cases measure. Default fixture clocks, real
clock sleeps, native performance/cold validation, scheduler/deadline tests and
all operation/test limits are unchanged. Explicit logical advances still expire
jobs and approvals, and the timestamp-tie negative remains exercised.
Separate controls advance the actual capture execution clock to lease expiry
and the legacy-reference clock by 5001 ms before effect settlement: the real
`Execution.check` still rejects with `LEASE_LOST`, and the real settlement ledger
still rejects with `CONFLICT` before decoding. Outer envelope translations can
differ; these synthetic controls establish the mechanism, not the exact timing
or translated cause of an earlier CI run. Physical byte-budget and history
integrity assertions remain unchanged.

Nine closed read-only conversion diagnostic cases and the two retained
predecessor negatives `diagnostic-missing-protection` and
`diagnostic-receipt-mutation` prepare fresh genuine authenticated history in a
**60-second setup hook**, separately from their existing **60-second assertion
body**. Cleanup keeps the default **10-second hook**. This increases aggregate
fixture wall-time opportunity; it is not an unchanged total duration or a
native deadline fix. Fault injection, actual inspection/diagnostic planning,
negative metadata/receipt/protection assertions and before/after/read-ledger
checks remain in the body. Original setup/body promises and SQLite/pin owners
are joined before deletion or mock reset; no fixtures or receipts are shared.
Closed phase telemetry is armed on the original runner signal before allocation
and reports full initial capture settlement, a validated error code, body and
cleanup timing without private content. A native initial capture deadline
still fails setup: its 30-second budget and real clock sleep/watch are unchanged.
Local successful captures do not explain the earlier hosted native deadline.
Large-report and realistic byte-budget cases retain their original data and
validators; no padding reduction, clock workaround or automatic retry is used.

Six specifically named scheduler, persistence, stage-refresh and closed-diagnostic
cases additionally emit **test-only closed resource observations**. The observer
is disabled for every other name. Each selected case emits at most 128 JSON
records / 64 KiB total, at most 2 KiB per record, and at most 90 one-second
pending samples. Four records / 8 KiB are reserved for once-only abort, cap,
unresolved-owner and closure summaries; exhaustion is explicit. Real unref
observer timers never advance the synthetic clock or change a test/native limit.
Existing setup/body/stop/queue/delete boundaries and spies supply only numeric
counts. Missing or unexpected internals are `null`/unavailable, not zero.
No paths, SQL, IDs, test names, callback contents or error strings are emitted.

Observations include monotonic and wall timestamps because reporter output can
be buffered. CPU and memory are whole **own-process** measurements, not
thread-exclusive or per-phase usage; filesystem counters are operations, not
bytes or queue depth. Event-loop sample count zero is not proof of zero delay.
Queue sequence counts distinct promise identities seen at observation points,
not every enqueue or queue length. Reported observer time is cumulative
measurement/output overhead before that record, not a correction to test time.
Sampling/counter/sink/resource faults are closed flags/counts and cannot mask
the original failure. Timer/monitor/listener closure is not claimed until
actual observed work and owners settle; pending work is never joined or
cancelled by the observer. The existing ownership risks and the hosted
six-failure cause remain unproven; this instrumentation is not a timing fix.

The storage cancellation-control tests separate queued-context snapshotting from
capacity admission. The snapshot case still mutates the caller's request after
queueing a real cancellation and checks the original identity. The capacity case
prepares a fresh owned SQLite store with **127 genuine sequential control
transactions in `beforeEach`**, under the unchanged default 10-second hook limit.
Its default 5-second test body verifies the persisted 127 records, admits control
128 with exactly one version increment, refuses 129 without changing any record,
and replays control 0 at capacity without budget/usage mutation. No rows are
manufactured or shared across cases. Original setup promises and store queues
are joined before cleanup; cancellation during a late open or an actual seeded
write is tested separately and prevents the next seed transaction.
This separates bounded fixture preparation from the operation under assertion,
not a product latency guarantee or a test/hook allowance increase. The earlier
hosted timeout is retained as failure evidence; a fast isolated run does not
establish the hosted I/O cause.

`tests/unit-partition.ts` is the reviewed exact-file inventory. The checker uses
the original `packages/**/*.test.ts` discovery minus the original smoke/default
exclusions, then compares that set against **actual Vitest project discovery**.
It rejects omissions, duplicates, overlap, absent native files and wildcard/smoke
entries. New files remain portable unless explicitly classified. Initially the
union is 172 files (171 existing plus one membership-regression file), partitioned
into 145 portable and 27 native files. Existing OS skip predicates stay inside
their files; classification does not change non-Windows behavior. The subsequent
owned-subprocess regression file defaults portable, bringing the current union to
**146 portable + 27 native = 173 files**.

Hardware tests exercise real native ACL/NTFS admission and publication, Windows
Job/process ownership, or native storage-driver behavior on owned temporary
fixtures. Portable tests may still use real SQLite with synthetic host boundaries.
Native renderer-host tests run authored child modules, not a browser renderer.
Capture fixtures use synthetic credential adapters and denied real keyring
constructors; network fixtures are mocked or isolated loopback. This phase is
not permission for real vault, UI, installed-project or provider access.

The isolation was proposed after hosted runs showed a long portable
reference/SQLite proof suite overlapping native installation, durable journal
creation and capture tests. Failures included a genuine 30-second operation
deadline, lease loss in prerequisite setup, and native fixture/test timeouts.
Those observations do not identify a specific hardware, endpoint-security or
runtime root cause. Running the same assertions under an explicit isolated
workload is evidence about that workload only, not proof of broad performance.
No deadline, test timeout or hook allowance is raised by this partition.
The previously approved **60-second allowance for only the 1,023-record native
journal preparation hook** remains a documented exception; ordinary tests,
operation budgets, global hook defaults and production leases are unchanged.

The first isolated portable run still failed three admission matrix tests:
each enclosed 10–15 fresh subprocesses in one five-second test. Those independent
inputs are now named parameterized cases with their own fresh owned temporary
root and one original production probe per case (the runtime-closure positive
also needs its second consumer process). Vitest's `test.for` supplies each
case's original runner signal. All 25 invalid package scenarios, both package
positives and all 15 browser-inventory shapes/byte boundaries remain covered.
Test granularity and totals change; per-case timeouts and byte limits do not.
The probe helper retains process isolation and joins actual child `close`, not
just an early `execFile` abort rejection, before fixture cleanup. Nonzero exit,
bounded-output errors and malformed JSON are not replaced with success results.

Run the six README commands in order. `test` is an alias for unit tests, not the
whole CI gate; run `test:smoke` separately after `build`. CI performs both.
Tests need no outbound services after dependencies are restored, but are not an
OS-level network sandbox. They use no real user designs or devices.

Windows local execution is evidence only for this host/toolchain. The hosted
Windows job, macOS job, public-npm frozen restore, and other CPU architectures
remain unverified. Review the registry/SHA-1 provenance limitation in
DEVELOPMENT.md at G0; do not interpret CI YAML or a local mirror restore as an
upstream supply-chain or macOS acceptance result.

## F01 foundation acceptance and observed TDD

F01 was authorized under the Windows-first synthetic-foundation G0 exception
on integration base `5a8ea5d79f74f11edadb03d1afdd84dfa25b8ee9`. It preserves the
F00 harness. Acceptance covers synchronized schemas/types, strict authoring and
artifact shapes, scoped fake-provider behavior, exact fixture byte identities,
and public built-package imports. It does not claim semantic resolution,
rendering, comparison, source import, real host adapters or implementation
readiness. DESIGN_IR.md and exported `SEMANTIC_CASES` assign those checks to
their owning later packages without fake successful semantic results.

All commands used the pinned Node 24.21.0/pnpm 11.26.0 toolchain and worktree-
scoped cache/state/store. The previously verified portable Node was executed
read-only; no other checkout was edited.

| Step | Actual command/result on Windows |
| --- | --- |
| Acceptance RED | `pnpm exec vitest run --project unit packages/contracts/tests`: exit 1, three suites fail because `src/index.js` / `src/testing.js` do not exist. Tests were written first. |
| First boundary GREEN | Boundary/provider selectors: 41 tests pass; complete first fixture gate: 43 tests pass. |
| Focused artifact RED | `... artifacts.test.ts`: three expected failures for handoff path/media refinements, async accepted/completed distinction, and an initially assumed font version. Actual public font name table established 1.003, not 1.001. |
| Host-boundary RED | Provider/artifact selectors: new filesystem/credential/clock/fake completion exports absent and invalid calendar date accepted; expected failures recorded before behavior. |
| Refactor/GREEN | Named recursive JSON arrays/objects and derived all-definition generation root fixed the generator's circular alias/unreachable types without weakening schema unions or strict typing. All 54 contract tests passed. |
| Package RED | Contract smoke before build: exit 1 `ERR_MODULE_NOT_FOUND` for `packages/contracts/dist/index.js`. An earlier attempt was blocked by pnpm's stale dependency-state guard while the portable lock restore was being updated; that was not counted as behavior RED. |
| Portable restore | Manifest-only resolution through the existing canonical trusted mirror emitted zero explicit tarball URLs; a frozen restore succeeded. No integrity/URL editing, global config changes or TLS weakening. |
| Process regression RED | A scripted nonzero process exit incorrectly retained `complete`; the focused provider test failed before fixing the fake boundary to report `PROCESS_FAILED` or `OUTPUT_LIMIT`. A misplaced nested-test attempt was corrected first and is not counted as behavior RED. |
| Resource-scope regression RED | The reusable provider harness exposed same-ID wrong-resource-kind grants reaching unavailable instead of forbidden in all three fakes. Fixed the test boundary to match resource kind, ID and operation together; production authorization remains F04. |
| Persisted-byte RED | Comparing staged Git blobs to the fixture manifest caught automatic line-ending normalization of the synthetic MIT license. Marked both license resources byte-preserved in fixture-local attributes and re-staged; every staged resource/license hash then matched. |
| Integrated gate | `contracts:generate`, `fixtures:check`, `lint`, `typecheck`, `build`, `test:unit`, `test:smoke`: all exit 0. 36 generated contract outputs and 26 fixture outputs checked; 60 files passed Biome; 62 unit tests (57 contracts + 5 F00) and 3 built-process smoke tests (1 contracts + 2 F00) passed. |

The five foundation cases and 19 public-artifact shape examples are deliberately
authored, not copies of the P02 probe or confidential product data. ABeeZee
Regular is unmodified OFL-1.1 font data with a pinned public source commit,
actual metadata, byte hash and full license. Fixture tests check all declared
bytes and referenced component/token/asset/font identities; they do not execute
a general dependency resolver. No browser golden was generated.

Generated schema/type files and generated fixture JSON use deterministic
generator formatting rather than independent Biome rewriting. Build checks
schema/type drift and CI separately checks fixture drift; source/config/tests
remain covered by Biome and strict TypeScript. Windows local evidence is not a
hosted CI/macOS run, public-npm restore, live Figma import, font rasterization,
device capture or M1 acceptance.

### F01 follow-up: injected-clock deadline regression

Coordinator review reproduced a test-utility bug: `invokeFake` calculated the
remaining duration with the injected clock but expired it with real
`setTimeout`. Advancing a fake clock past the deadline and releasing a
schema-valid scripted Figma result could incorrectly return `complete`.
This was fixed in a separate follow-up commit, not by changing public schemas,
profiles or deferred production-adapter requirements.

| Step | Actual evidence |
| --- | --- |
| RED | `pnpm exec vitest run --project unit packages/contracts/tests/deadlines.test.ts`: exit 1, all 8 new cases failed. Virtual advances of 1,000/1,001 ms and the shorter 100-ms duration budget returned complete; expiration never called the injected sleep. |
| GREEN | `pnpm exec vitest run --project unit packages/contracts/tests/deadlines.test.ts packages/contracts/tests/providers.test.ts`: exit 0, 17 cases passed; strict `pnpm typecheck` also passed. |
| Fix | Schedule expiry with `Clock.sleep`, retain the effective absolute deadline, and reject complete/partial replies observed at or after expiry. Cancel and await the deadline sleep, abort remaining scripted work, and remove the caller's cancellation listener on every settled path. Suppress only the expected abort of the owned deadline sleep; unexpected clock/script failures remain errors. |
| Cleanup coverage | Pending work expires by advancing virtual time without releasing its reply or waiting for wall time. Success/cancellation/script failure drain tracked sleepers; late releases cannot change a cancelled result. An unexpected clock failure is surfaced and remaining scripted work is cancelled. |
| Integrated gate | Schema and fixture drift checks, lint, strict typecheck, build, 70 unit cases and 3 smoke cases passed: the previous 65-case baseline plus 8 regressions. No dependency, schema, profile or fixture changes. |

### Integration follow-up: workspace dependency test discovery

After adding a dependent workspace package, the coordinator observed that the
unit project's custom `exclude` replaced Vitest's defaults. The collector
traversed `packages/host/node_modules/@design-studio/contracts/tests` and ran
65 contract cases again through the workspace link. Earlier multi-package
execution totals therefore included duplicate cases, not additional coverage.

`tests/test-discovery.smoke.test.ts` invokes the actual unit collector in a
bounded child process and rejects any collected `node_modules` path. It failed
RED with the linked contract tests before the configuration fix. The unit
project now extends `configDefaults.exclude` with its smoke-test exclusion,
preserving default dependency-directory protection. The collector regression
then passed GREEN, followed by build, strict typecheck, lint and 117 distinct
unit/smoke cases on the current F01 plus early-F04 integration.

### Integration follow-up: bounded native test concurrency

Combining native process/Job and storage suites exposed three 5-second harness
timeouts under default file-level concurrency. The same cases passed in a
single-worker diagnostic run, and the complete suite passed with two workers:
449 passed and one explicitly unsupported-host-only case skipped on Windows.
Root Vitest now caps file workers at two to avoid competing executable-hash,
process startup and native cleanup fixtures overwhelming one shared host.
This does not change product deadlines, assertions, or runtime job concurrency.

## F01-F08 Windows integration checkpoint (2026-09-17)

The foundation packages, application facade and CLI are integrated locally.
The final combined Windows run passed 1,354 tests, with six explicit skips
(unsupported-host behavior and opt-in installation, diagnostic and performance
cases). Build, strict root typechecking, lint, 40 generated contract outputs,
26 fixture outputs and OpenAPI drift checks passed. The `.mts` declaration
extension now follows the same explicit LF checkout policy as TypeScript source.
Native fixture tests cover all five original fixture cases from unchanged
resource identities through acceptance, fenced render jobs, committed receipts
and verified preview bytes. The unsupported-feature fixture uses inspection,
not a strict or approval pass. Generated schemas, fixture data and OpenAPI have
separate drift checks. Review corrections have regression coverage for revoked
restore authority, partial-stage evidence, pending authority callbacks, long
native/temp paths, request snapshots, intentional text clipping, installer
package-name traversal, and CLI startup/shutdown evidence.

For the combined local check, with the documented pinned browser and SQLite
artifacts already available:

```powershell
$env:F06_BROWSER_GATE = '1'
$env:F06_RENDER_SMOKE = '1'
pnpm build
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm fixtures:check
pnpm --filter @design-studio/application openapi:check
pnpm exec vitest run --project unit --project smoke
```

Leave installation/candidate/metadata-probe gates and performance/golden-update
flags unset for this run. Installation mechanism tests were separately exercised
in exact owned temporary namespaces; they never provision real user roots.
The F08 actual-entry installed test passed once before the final CLI lifecycle
corrections. It was not rerun to claim installed-release coverage for those
corrections; pinned-Node subprocess and native fixture regressions cover them.
Earlier installed freshness checks intermittently took 56-60 seconds, and the
passing run lost its numeric phase artifacts. Neither a root cause nor reliable
installed latency is established. The subsequent report-persistence correction
was tested separately without another full candidate run.

The final expanded unit collector completed independently in 29.11 seconds but
exceeded its prior 30-second child timeout under combined native-suite load.
Its bounded harness allowance is now 60 seconds (65-second outer test), retaining
all dependency-path assertions and the two-worker limit. No product, render
performance, authorization, or job deadline was changed by this harness correction.
The explicitly approved installed-profile issuance allowance is separately
documented in the application package and remains capped by the original job
deadline.

The final release's unmodified bootstrap/payload inventories and user approval
remain separate from test candidates. No real installation, push, pull request,
main merge, hosted CI/macOS run, or later product phase is implied by this checkpoint.

### PR CI follow-up

The first PR run failed on both hosted lanes. macOS encountered backslash fixture
paths and Windows-only native dependencies; CI now targets only the approved
Windows foundation scope instead of advertising a passing macOS matrix.

Windows failures included strict real-path rejection of temporary roots. An
owned local directory-alias reproduction produced the same renderer-host
`PATH_FORBIDDEN` failure; resolving `TEMP`/`TMP` through the new CI setup script
made that exact test pass. The script exports only the canonical existing
directory via `GITHUB_ENV` before tests create their owned roots. A subprocess
regression verifies alias resolution and unchanged target identity, and verifies
that missing temporary roots do not publish environment changes. Production
alias checks, authorization, deadlines, and native publication rules are unchanged.
Hosted success must still be established by the new PR run.
