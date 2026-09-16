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
| `pnpm lint` | Read-only Biome formatting/static analysis checks. |
| `pnpm format` | Apply Biome formatting/import fixes to owned code/config; excludes source specifications and feasibility documents. |
| `pnpm typecheck` | Check TypeScript source, tests, and Vitest configuration without emitting. |
| `pnpm build` | Check contract generation, then emit contracts and smoke ESM/declarations in ignored `dist` directories. |
| `pnpm contracts:generate` / `contracts:check` | Generate or read-only drift-check public contracts from the single JSON Schema source. |
| `pnpm fixtures:check` | Read-only check of the five authored synthetic foundation cases and byte manifests. |
| `pnpm test` / `pnpm test:unit` | Run deterministic source-level unit tests once, without a watcher. |
| `pnpm test:smoke` | Import built output in a separate Node process; run after `build`. |

F01's exact package-local dependencies are Ajv `8.17.1` (strict draft-07 shape
validation), YAML `2.8.1` (bounded YAML authoring/duplicate-key detection), and
development-only json-schema-to-typescript `15.0.4` (declaration generation).
They do not select production rendering/storage/provider libraries or change
the integrated toolchain pins. No dependency build scripts are enabled.
See DESIGN_IR.md for refinement/semantic boundaries and schema ownership.

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
frozen install followed by lint, typecheck, build, unit, and offline smoke on
`windows-latest` and `macos-latest`. The official runner inventory mapped these
to Windows Server 2025 x64 and macOS 26 arm64 when configured; aliases can move.
Neither hosted CI nor macOS was executed during this local bootstrap.
