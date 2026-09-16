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
