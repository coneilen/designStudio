# @design-studio/contracts

Version 1.1.0; artifact schema version 1.0; JSON Schema draft-07.
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
pnpm build
pnpm typecheck
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

## Additive CLI/API v1 contracts (package 1.1.0)

`ResponseEnvelope` retains all previously valid success and error values and
adds these closed `data` variants. Every success still requires
`warnings: Diagnostic[]`; unknown properties are rejected.

| `data.kind` | Required fields beyond `kind`/`warnings` |
| --- | --- |
| `revision` | `revision: Revision`, `design: DesignIR`; optional `receipt: CommitReceipt` |
| `help` | `command` (1..160 characters), `usage` (1..16384 characters) |
| `version` | `cliVersion`, `contractVersion` using existing `Version` (1..160 characters); `apiVersion: "v1"` |
| `api-description` | `openapiVersion: "3.1.0"`, `apiVersion: "v1"`, `documentSha256: Sha256`, `path: "/v1/openapi.json"` |
| `service` | `state: "stopped"`, `projectId: StableId` |

Generated payload types are `FoundationRevisionResponseData`,
`FoundationHelpResponseData`, `FoundationVersionResponseData`,
`FoundationApiDescriptionResponseData`, and `FoundationServiceResponseData`.
`LegacyResponseData` preserves the original accepted-job/job/artifact/design/
validation/capabilities shape and its shared optional fields; it is not narrowed
retroactively. Its new `jobVersion?: JobVersion` is permitted only for `kind: "job"`.
`JobVersion` is an integer from 0 through 9007199254740991, supplied by the
authoritative stored job row, never inferred or defaulted.

F08 job routes use `validateContract("FoundationVersionedJobResponse", value)`
or `parseContract` with that same name. This separately exported generated type
and schema refine `ResponseEnvelope` using `allOf`: successful `kind: "job"`,
required `job` and `jobVersion`, plus all original envelope/job constraints.
Missing/fractional/unsafe versions fail; ordinary legacy job envelopes without a
version remain valid under `ResponseEnvelope`. Failure responses use the normal
envelope, not this successful-job-only refinement.

Strict request types and runtime validator names:

| Name | Closed request fields |
| --- | --- |
| `FoundationAcceptFixtureRequest` | `fixtureId: StableId`, `branch: StableId`, required `base: ExpectedBase \| null` |
| `FoundationRenderSubmissionRequest` | `revision: ArtifactReference`, `base: ExpectedBase`, `mode: "strict" \| "inspection"` |
| `FoundationCancelJobRequest` | Empty object `{}` |

These requests follow `RenderRequest`'s endpoint-versioned convention: no
top-level `schemaVersion`. Project/design/job path IDs and authentication,
idempotency and precondition headers are F08 boundaries, never authorization
contexts or callbacks in request JSON. F08 enforces registry membership for help
and generates usage from that registry, not arbitrary argv. API description data
contains only fixed route/version/hash metadata, not embedded OpenAPI JSON or
host filenames. Service readiness remains private protocol; stopped is the only
public success state. `NOT_FOUND` joins shared `ErrorCode` for genuinely absent
authorized resources/routes; authorization must precede existence disclosure.

The four new request/refinement public files are
`foundation-accept-fixture-request.schema.json`,
`foundation-render-submission-request.schema.json`,
`foundation-cancel-job-request.schema.json`, and
`foundation-versioned-job-response.schema.json` under `./schemas/`.
They reference the same draft-07 catalog. OpenAPI 3.1 composition must retain its
explicit draft-07 dialect and resolve references locally.

Package 1.1.0 is an additive public package/API revision, not an artifact
migration. Artifact `schemaVersion: "1.0"`, schema IDs under `/schemas/1.0/`,
provider `contractVersion: "1.0"`, and existing fixture/artifact bytes and hashes
remain unchanged. The CLI version response's `contractVersion` reports the
contracts **package** version (1.1.0), not the provider protocol version.
TypeScript does not encode every JSON Schema restriction (including the closed
empty cancel object, numeric limits and conditional job-state requirements); validate untrusted
input at runtime. No handwritten response union or untyped data bag is used.

No semantic resolver, renderer, source importer, host adapter, storage engine,
handoff compiler, comparator, job engine or CLI/API routes are implemented.
