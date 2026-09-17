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
