# Design Studio

A planned local-first AI-native design studio. The [reviewed specification](documentation/spec/ai_native_design_studio_spec_v4.md) defines the product destination and release gates.

**Current scope: integrated deterministic foundation libraries, not the complete product.** The private TypeScript package
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
No application service, UI, renderer, live Figma/device integration, handoff
compiler or CLI/API routes are implemented yet.

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
and the single committed lockfile. No global installation is required. The smoke
test requires the build output and runs without Figma, models, devices, browsers,
credentials, or paid services.
Build first so cross-package type imports can resolve the published declarations.
The explicit native preparation command is currently Windows x64/Node 24 only.
It verifies the pinned official SQLite prebuild and never compiles a fallback.
Native Windows integration cases do not establish macOS or hardware power-cut behavior.

See [DEVELOPMENT.md](DEVELOPMENT.md) for runtime setup and version rationale,
[TESTING_AND_TDD.md](TESTING_AND_TDD.md) for acceptance and observed evidence, and
[ARCHITECTURE.md](ARCHITECTURE.md) for planned boundaries.

Windows x64 checks have been run locally. Windows/macOS hosted CI is configured,
but no hosted run or macOS execution has been observed. F01 used the approved
Windows-first synthetic-foundation G0 exception; this does not pass deferred
live Figma/macOS/device gates or authorize later product work.
