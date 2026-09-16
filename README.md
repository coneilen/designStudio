# Design Studio

A planned local-first AI-native design studio. The [reviewed specification](documentation/spec/ai_native_design_studio_spec_v4.md) defines the product destination and release gates.

**Current scope: F00 workspace bootstrap only.** One private TypeScript package,
`@design-studio/workspace-smoke`, fingerprints synthetic fixture bytes to prove
build, public-package import, and test plumbing. It is not a product API, DesignIR,
handoff compiler, validation verdict, or `designctl` command. No application
service, UI, providers, or product schemas are implemented.

## Development quick start

Activate **Node 24.21.0** in your current shell, then run from the repository root:

```text
npx --yes pnpm@11.26.0 install --frozen-lockfile
npx --yes pnpm@11.26.0 lint
npx --yes pnpm@11.26.0 typecheck
npx --yes pnpm@11.26.0 build
npx --yes pnpm@11.26.0 test:unit
npx --yes pnpm@11.26.0 test:smoke
```

`npx` only bootstraps the exact pnpm version; pnpm owns all workspace dependencies
and the single committed lockfile. No global installation is required. The smoke
test requires the build output and runs without Figma, models, devices, browsers,
credentials, or paid services.

See [DEVELOPMENT.md](DEVELOPMENT.md) for runtime setup and version rationale,
[TESTING_AND_TDD.md](TESTING_AND_TDD.md) for acceptance and observed evidence, and
[ARCHITECTURE.md](ARCHITECTURE.md) for planned boundaries.

Windows x64 checks have been run locally. Windows/macOS hosted CI is configured,
but no hosted run or macOS execution has been observed. F00 stops for G0 review;
F01 and subsequent product work require approval.
