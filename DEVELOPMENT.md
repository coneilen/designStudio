# Development

## Pinned toolchain

Ratified against published package metadata and local execution on 2026-09-16.
Root `package.json` owns development dependencies; `pnpm-workspace.yaml` names
the workspace-smoke and contracts packages and enables strict engines/peers, exact saved versions,
and explicit dependency-build approval. Automatic package-manager switching and
automatic installs before scripts are disabled in favor of explicit errors.

| Tool | Exact version | Rationale / compatibility |
| --- | --- | --- |
| Node.js | 24.21.0 | Current Active LTS line; `.node-version` and package engines pin the same patch. |
| pnpm | 11.26.0 | Published JavaScript distribution, Node >=22.13; avoids requiring pnpm 12's native pin resolver in this host environment. |
| TypeScript | 7.0.2 | Stable compiler with Windows/macOS native packages; strict NodeNext ESM, no `skipLibCheck`. |
| Vitest | 4.1.11 | Node 20/22/24+ supported; source tests and separately selected built-package smoke tests. Strict declaration checking passes with these pins. |
| Vite | 8.2.2 | Stable compatible Vitest dependency/peer, Node >=22.12 (or ^20.19); test tooling only, not a browser/rendering choice. |
| Biome | 2.5.12 | Local formatter, import organization, and recommended static analysis; Node >=14.21.3. |
| `@types/node` | 24.13.4 | Matches the selected runtime major. |

Sources: [Node release status](https://nodejs.org/en/about/previous-releases),
[Node checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt),
[pnpm installation/compatibility](https://pnpm.io/installation),
[pnpm CLI settings](https://pnpm.io/settings/cli),
[pnpm build policy](https://pnpm.io/settings/build), and package metadata queried
with `npm view <package>@<version> engines dependencies peerDependencies --json`.

Rejected candidates were actually tried, not assumed unsupported: pnpm 12.4.0
executed via `with current`, but its normal project-pin resolver failed TLS
against public npm on this host. Vitest 5.0.0 ran tests but its published
declarations failed strict typechecking (including missing `@vitest/expect` and
`MarkOptions`). Vite's `latest` tag was `8.3.0-beta.1`, so it was not selected.
These are environment/package observations, not claims that all newer releases
are unusable.

## Local runtime without global changes

Use an existing version manager's per-shell selection, or extract the official
Node 24.21.0 archive into ignored `.tools`. Verify its SHA-256 against the official
release checksums before using it. Select the archive matching your OS/CPU; do not
copy a Windows binary to macOS.

After extracting `node-v24.21.0-win-x64.zip`, for PowerShell:

```powershell
$env:PATH = "$PWD\.tools\node-v24.21.0-win-x64;$env:PATH"
$env:npm_config_cache = "$PWD\.tools\npm-cache"
$env:PNPM_HOME = "$PWD\.tools\pnpm-home"
$env:PNPM_CONFIG_STATE_DIR = "$PWD\.tools\pnpm-state"
node --version
npx --yes pnpm@11.26.0 --version
```

For a macOS arm64 archive, the equivalent current-shell selection is:

```sh
export PATH="$PWD/.tools/node-v24.21.0-darwin-arm64/bin:$PATH"
export npm_config_cache="$PWD/.tools/npm-cache"
export PNPM_HOME="$PWD/.tools/pnpm-home"
export PNPM_CONFIG_STATE_DIR="$PWD/.tools/pnpm-state"
node --version
npx --yes pnpm@11.26.0 --version
```

Use `darwin-x64` for Intel Macs. These snippets change only the current shell,
not system settings, profiles, or default runtimes. Do not install global tooling,
disable TLS verification, or add credentials to repository files.

## Commands and dependency changes

Use `pnpm` below if the exact pinned version is already available; otherwise
prefix each command with `npx --yes pnpm@11.26.0` as in the README.

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Restore exactly the committed dependency graph. |
| `pnpm --filter @design-studio/storage prepare:native` | Explicit Windows x64 preparation of the pinned, verified SQLite prebuild; dependency install scripts stay disabled. |
| `pnpm lint` | Read-only Biome formatting/static analysis checks. |
| `pnpm format` | Apply Biome formatting/import fixes to owned code/config; excludes source specifications and feasibility documents. |
| `pnpm build` | Build registered workspace packages in dependency order, including contract drift checking, into ignored `dist` directories. |
| `pnpm typecheck` | Check TypeScript source, tests, and Vitest configuration without emitting; run after `build` so public cross-package declarations exist. |
| `pnpm contracts:generate` / `contracts:check` | Generate or read-only drift-check public contracts from the single JSON Schema source. |
| `pnpm fixtures:check` | Read-only check of the five authored synthetic foundation cases and byte manifests. |
| `pnpm test` / `pnpm test:unit` | Check complete membership, then run portable unit/SQLite tests and hardware-native integration tests in separate failure-gated phases. |
| `pnpm test:partition` | Verify actual Vitest discovery is a disjoint, complete partition of the original default-unit file set; no test modules execute. |
| `pnpm test:portable` | Run the `unit` project with two workers. New test files default here. |
| `pnpm test:native` | Run the exact reviewed `native` project inventory one file at a time, with existing operation deadlines and platform predicates. |
| `pnpm test:smoke` | Import built output in a separate Node process; run after `build`. |

The exact hardware list is `tests/unit-partition.ts`. It covers real temporary
Windows ACL/NTFS fixtures, native process/Job containment and platform storage
drivers; mixed files stay intact. At introduction, the original 171 unit files
plus partition-check and owned-probe regression files form
**146 portable + 27 native = 173 files**.
Do not run both Vitest projects concurrently when evaluating this isolation
profile: use the default `pnpm test:unit` orchestration. CI uses the same checker
and two named sequential phases. No tests are removed or duplicated, and smoke
and explicitly opted-in installed/live probes remain separate.
The CI job has a 35-minute overall watchdog to include both measured phases and
setup/build/smoke overhead. Run `35952509962` passed all 146 portable files in
1181.45 seconds and all 27 native files in 234.14 seconds, but the previous
25-minute job limit cancelled smoke after about 33 seconds: smoke was incomplete,
not passed. The bounded infrastructure allowance does not extend individual
test, hook or product limits, or guarantee runtime performance.

F01's exact package-local dependencies are Ajv `8.17.1` (strict draft-07 shape
validation), YAML `2.8.1` (bounded YAML authoring/duplicate-key detection), and
development-only json-schema-to-typescript `15.0.4` (declaration generation).
They do not select production rendering/storage/provider libraries or change
the integrated toolchain pins. No dependency build scripts are enabled.
See DESIGN_IR.md for refinement/semantic boundaries and schema ownership.

Workspace discovery uses `packages/*`; each new package owns its manifest and
build script and declares its workspace dependencies. Root build ordering follows
that dependency graph rather than an expanding hand-maintained package list.
The public TypeScript consumer fixture at
`tests/fixtures/consume-contract-types.ts` verifies declaration resolution from
the package's published entrypoint. It produced the expected TS2307 failure on
a restored but unbuilt checkout; building declarations before typechecking is
therefore required in local instructions and CI. The same typecheck passed
after the dependency-ordered build, alongside the 73 unit/smoke cases.

During parallel package work, root configuration and dependency policy remain
coordinator-owned. Package authors may generate lockfile deltas for their scoped
manifest changes; those are integration inputs, not permission to change other
packages' versions. The coordinator serializes combined lockfile resolution and
verification. Do not edit shared contract schemas or pinned fixtures independently.

Package scripts are simple executable invocations, not bash/PowerShell command
strings. Tests resolve Node through `process.execPath`, use argument arrays and
Node path APIs, impose process deadlines/output limits, and clean only their own
unique temporary directories.

Only intentional dependency changes should use a non-frozen install. Review
manifest and lockfile diffs together, including native optional packages and any
new dependency install scripts. No dependency build scripts are currently allowed.
Do not introduce an npm/yarn lockfile, broad future package tree, or renderer,
SQLite, image-processing, or provider dependencies as part of F00.

## Lockfile provenance and CI

Public npm and the public Yarn mirror were unreachable from the bootstrap host
due to TLS handshake failures. The host's existing trusted npm proxy returned
environment-specific tarball URLs and SHA-1 shasums. A fresh manifest-only
workspace was resolved with `pnpm install --lockfile-only --registry=<the same
mirror's canonical registry endpoint>`; pnpm itself omitted reconstructible
tarball URLs. The resulting lockfile was copied back and a frozen install
validated the package bytes. No registry configuration, endpoint, credentials,
hand-edited URLs, or invented stronger hashes are committed.

The lockfile preserves the registry-provided SHA-1 integrity values. It does not
claim upstream SHA-512 verification or a successful public-npm restore. A
public-registry frozen install remains a G0 evidence gap; review/re-resolve
upstream integrity before release when that registry is reachable.

CI uses SHA-pinned actions, read-only repository permissions, no persisted
checkout credentials, no secret inputs, and no artifact uploads. It performs a
frozen install followed by lint, dependency-ordered build, typecheck, unit, and offline smoke on
`windows-latest`. This foundation checkpoint intentionally excludes macOS:
the initial hosted macOS run exposed unguarded Windows fixture paths and native
bindings. Portable tests/native preparation must be established before restoring
that lane. Runner aliases can move; the initially selected Windows image was
Windows Server 2025 x64.

Before tests allocate temporary roots, `scripts/prepare-ci-temp.mjs` resolves the
runner's temporary directory to its real path and exports it as `TEMP` and `TMP`
for subsequent steps. This handles environment aliases without relaxing the
production filesystem and renderer-host checks that reject aliased roots.

## Native foundation integration

Use `pnpm install --frozen-lockfile --ignore-scripts` for native optional packages;
the explicit storage preparation command supplies only its verified Windows
prebuild through `nativeBinding`. No dependency source-build fallback is enabled.

`tests/storage-host.smoke.test.ts` composes the actual public DesignIR
canonicalizer, local session authenticator, branded context snapshots, NTFS
write-through publication and SQLite store. It exercises a real initial commit,
close/reopen with a new key reusing a trusted committed blob, and an authorized
backup restored through real destination publication. Fresh native proof
absence after restart remains unavailable; historical store assurance is not
misrepresented as a reconstructed host receipt.

The fixture provisioning/backup authorities accept only newly owned test roots
and backups registered from the authenticated test source. They are not a
production project-provisioning or backup-issuer implementation. These cases
do not exercise live credentials, user files, migration-backup durability,
hardware power-cut behavior or macOS execution.
