# @design-studio/contracts

Named runtime validation registers the authoritative definitions with their
original schema ID and dialect, without compiling the document-root union as
an unrelated entry point. `validateContract` still accepts only catalog names
and resolves the same definition fragments with unchanged AJV options and
boundary checks. The exported foundation schema and public schema files retain
their root union unchanged. Tests guard against whole-root, external or
scope-changing references that would invalidate this registration strategy.

Version 1.4.0; artifact schema version 1.0; JSON Schema draft-07.

Validation reuses compiled immutable schema functions, not payloads, acceptance
results or authority. Every input is checked again, including mutations after a
successful validation, accessors, cycles, depth and non-finite/non-JSON values.

## Native capture integration (package 1.4.0)

`ReferenceConversionInspection` is the closed result of the release-v8
native-only `reference-conversion-inspect` command. `committed` includes a
conversion receipt/evidence/readiness only after the original recovery graph,
deterministic fixed-v2 outputs and every physical output are verified.
`incomplete` reports a fully validated no-intent or intent-only control state;
`blocked` means verification did not finish and carries no proof or conversion.
Neither result grants permission to retry or mutate. Current inspection-policy
and historical recovery-policy hashes are distinct proof fields. Readiness
remains `blocked` or `needs-review`, never render-ready.

`NativeReferenceRecoveryPlanEnvelope` and `ReferenceRecoveryPlan` describe the
separate read-only retained-byte validator. Successful verification means
`eligible-for-recovery-review`, while the historical job remains interrupted
and consumed. The closed projection contains bounded hashes, lengths,
dispositions, PNG dimensions and a stable proof, never image/private-text
payloads. A plan is neither a commit receipt nor authority to apply recovery.
Existing reference/metadata contracts and HTTP routes are unchanged.

`NativeCaptureEnvelope` is the closed, native-only result for capture, inspect,
draft conversion and explicit private artifact output. It separates job state
from capture completeness and render readiness. A completed partial-inspection
job is not a successful full capture. `figma-structure-fixed-v1` identifies the
source-neutral shared conversion rules; it does not assert authentication.
No HTTP credential or capture route, public Operation, provider version or
artifact schema version changed. All 47 generated outputs and application
OpenAPI are synchronized.

## Additive selected-frame capture contracts (package 1.3.0)

`FigmaCaptureRequest`, `FigmaCaptureManifest`, and `FigmaCaptureResult` are closed
artifacts for the bounded REST capture core. Requests bind exact policy identity
and SHA-256 plus an opaque credential reference, never a token or caller endpoint.
Manifests pin private original artifacts, requested/returned versions, request
outcomes, missing evidence, independent-origin remediation and separately measured
network/persistence usage. Results return artifact references with explicit
completeness/reference status and `readiness: not-evaluated`.

SourceSnapshot/figma-rest identity, provider contract version 1.0, artifact schema
version 1.0 and public Operation vocabulary are unchanged. Missing source versions
do not become invented REST identities; offline intake remains asserted/unknown.
Generic vendor JSON may still contain numeric schemaVersion as vendor data.
Old readers are not claimed to understand these new capture artifact names.
The package/CLI version report is 1.4.0; generated catalogs, public schemas and
the application's bundled OpenAPI must be regenerated together.
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

## Additive offline source contracts (package 1.2.0)

`SourceIdentity` adds `transport: "figma-offline"` with required `intakeId`,
`contentDigest`, and asserted/unknown `FigmaBinding`. Optional
`declaredTransport` and `declaredSourceVersion` are assertions, not observations.
Verified binding is forbidden for this variant. An offline `SourceSnapshot`
requires unknown consistency and an empty request inventory. Hashes do not
authenticate origin or invent a REST version. Existing REST/plugin/synthetic
variants and artifact/provider version 1.0 remain unchanged.

New generated closed contracts/public schema entrypoints:
`FigmaIntakeManifest`, `FigmaSourceMap`, `FigmaConversionEvidence`. These cover
source-package declarations, source-coordinate identity maps and reproducible
conversion projections only. They contain no grants, project provisioning,
approval, runtime routes or import-job result API. Resource/reference manifest
descriptors are unverified declarations until actual byte/rights checks.
See [the pure converter](../figma-import/README.md) for exact semantics.

Old readers can reject the added identity vocabulary; do not relabel it to make
an old reader accept it. Previously valid artifacts and fixtures remain valid
and byte-unchanged. Generic `JsonObject`/`JsonValue` validation treats a
third-party `schemaVersion` property as data; named versioned artifact
contracts still enforce their own schema version.

This contracts package does not itself implement a resolver, renderer,
importer, host, storage, jobs or CLI/API routes.
