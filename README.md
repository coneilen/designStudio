# Design Studio

A planned local-first AI-native design studio. The [reviewed specification](documentation/spec/ai_native_design_studio_spec_v4.md) defines the product destination and release gates.

**Current scope: locally integrated Windows fixture foundation (F01-F08), not the complete product or an approved release.** The private TypeScript package
`@design-studio/workspace-smoke`, fingerprints synthetic fixture bytes to prove
build, public-package import, and test plumbing. It is not a product API, DesignIR,
handoff compiler, validation verdict, or `designctl` command.
`@design-studio/contracts` adds versioned shared schemas/generated types, a
strict JSON/YAML authoring boundary, provider interfaces/labeled test fakes,
and five synthetic fixture cases. See [DESIGN_IR.md](DESIGN_IR.md).
`@design-studio/design-ir` adds semantic resource resolution and canonical byte
identity. `@design-studio/host` adds trusted local runtime boundaries and an
opt-in Windows NTFS publication profile; `@design-studio/storage` adds the stable
SQLite store, revisions, review records and recovery. Their required trusted
policy callbacks are not replaced with permissive production defaults.
`@design-studio/assets` adds bounded media/font processing, and
`@design-studio/renderer` produces static previews through a pinned, sandboxed
Windows browser contained by `@design-studio/renderer-host`.
`@design-studio/jobs` adds fenced persistent execution and durable cancellation.
`@design-studio/project-host` supplies private fixture roots and the offline
installation mechanism. The shared application facade and `designctl` CLI expose
authenticated fixture acceptance, inspection, rendering, job controls and verified
artifact retrieval through local commands and a private-pipe-launched HTTP service.

See the [application](packages/application/README.md),
[CLI](packages/cli/README.md), and
[installation](packages/project-host/README.md) documentation for supported
commands and trust boundaries. There is no browser enrollment/UI, live
Figma/device/model integration, handoff compiler, or app implementation workflow.
Existing user projects are not adopted. Fresh stores use private SQLite schema 4;
older-schema migration remains blocked without verified migration-backup durability.

**Release gates remain open.** The approved minimal Node runtime profile passed
three sequential, fresh-owned installed workflows with complete retained numeric
reports and identical file/byte counts. Service checkpoints peaked at
3.98-4.12 seconds with two active checks. This is bounded repeatability evidence,
not a latency guarantee. Earlier full-runtime diagnostics included an observation
deadline failure, a 26.6-second startup outlier and historical 56-60-second
freshness checkpoints; their rare-outlier cause remains unresolved.
See the [retained evidence](packages/application/README.md#retained-installed-diagnostics).
No production installation was performed. The exact final bootstrap
and payload inventories require separate user approval before installation.
The user-approved packaging design now selects only the pinned Node executable
and its original LICENSE, omitting unused npm/Corepack/setup tooling; this is
not approval of a release or proof that the rare stalls have been eliminated.
The historical renderer calibration does not certify timing of later corrected
code, the installed workflow, or other hosts.

## Windows development quick start

Activate **Node 24.21.0** in your current shell, then run from the repository root:

```text
npx --yes pnpm@11.26.0 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@11.26.0 --filter @design-studio/storage prepare:native
npx --yes pnpm@11.26.0 lint
npx --yes pnpm@11.26.0 build
npx --yes pnpm@11.26.0 typecheck
npx --yes pnpm@11.26.0 fixtures:check
npx --yes pnpm@11.26.0 test:unit
npx --yes pnpm@11.26.0 test:smoke
```

`npx` only bootstraps the exact pnpm version; pnpm owns all workspace dependencies
and the single committed lockfile. No global installation is required. Smoke
tests require build output; ordinary runs need no Figma, models, devices, user
credentials, or paid services. Browser and installation suites are explicitly
gated and require already provisioned pinned artifacts; see their package READMEs.
Build first so cross-package type imports can resolve the published declarations.
The explicit native preparation command is currently Windows x64/Node 24 only.
It verifies the pinned official SQLite prebuild and never compiles a fallback.
Native Windows integration cases do not establish macOS or hardware power-cut behavior.

See [DEVELOPMENT.md](DEVELOPMENT.md) for runtime setup and version rationale,
[TESTING_AND_TDD.md](TESTING_AND_TDD.md) for acceptance and observed evidence, and
[ARCHITECTURE.md](ARCHITECTURE.md) for planned boundaries.

Windows x64 checks have been run locally. CI targets `windows-latest` for this
Windows-first checkpoint. The initial hosted macOS run exposed Windows-specific
fixture paths and native dependencies; macOS is not currently a supported test
target. F01 used the approved Windows-first synthetic-foundation G0 exception;
this does not pass deferred live Figma/macOS/device gates or authorize later work.
