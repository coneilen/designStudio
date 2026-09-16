# @design-studio/contracts

Version 1.0.0; artifact schema version 1.0; JSON Schema draft-07.
See [DESIGN_IR.md](../../DESIGN_IR.md) for normative interpretation, defaults,
readiness/authority separation, supported profile, fixture provenance and
downstream ownership.

- `.`: generated public types, `contractNames`, `validateContract`,
  `parseContract`, `ContractBoundaryError`, provider/host interfaces,
  `DEFAULT_BUDGETS`, `MOBILE_STATIC_POLICY`, `EXIT_CODES`, `SEMANTIC_CASES`.
- `./schemas/*.schema.json`: public schema entrypoints and shared
  `foundation.schema.json`. IDs use a reserved `.invalid` host; load locally.
- `./testing`: explicitly labeled, opt-in test fakes and
  `assertProviderContract`; never a production fallback.

From the workspace root:

```text
pnpm contracts:generate
pnpm contracts:check
pnpm fixtures:check
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:smoke
```

Edit only the authoritative schema, then regenerate. The generator uses a
derived catalog root referencing every definition to prevent unreachable-type
omission. Recursive JSON arrays/objects stay named recursive definitions;
unions and runtime schemas are not flattened or replaced with empty bags.
Generated TypeScript and JSON are drift checked at build; strict typing remains
enabled without skipLibCheck. Generated files use deterministic generator
formatting and are excluded from independent Biome rewriting.

No semantic resolver, renderer, source importer, host adapter, storage engine,
handoff compiler, comparator, job engine or CLI/API routes are implemented.
