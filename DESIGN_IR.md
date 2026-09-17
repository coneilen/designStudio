# DesignIR and foundation contracts v1

**Implemented by F01:** authoritative draft-07 JSON Schema, generated TypeScript,
strict shape/authoring validation, provider interfaces and labeled offline fakes,
and five original synthetic fixture cases. These contracts do **not** implement
semantic resolution, canonical serialization, persistence, approval verification,
asset decoding, rendering, jobs, a handoff compiler, capture, a comparator, or
CLI/API routes. Windows contract execution is not macOS or live Figma evidence.

## Public source and imports

`packages/contracts/schemas/foundation.schema.json` is the sole schema source.
Its `definitions` are the shared reference graph. Public per-artifact
`*.schema.json` files and `src/generated.ts`, `catalog.generated.ts`, and
`schema.generated.ts` are reproducibly generated, committed, and drift-checked.
Do not edit generated files. All artifact `schemaVersion` values are `"1.0"`;
the package version is `1.1.0`. The public dialect is JSON Schema **draft-07**.
The reserved `.invalid` schema IDs are stable identifiers, not network endpoints.
Load the catalog locally when resolving references.

```ts
import {
  parseContract,
  validateContract,
  type DesignIR,
  type ResourceSnapshot,
  type Renderer,
} from "@design-studio/contracts";

const design: DesignIR = parseContract("DesignIR", authoringText, "yaml");
const result = validateContract("ResourceSnapshot", untrustedResources);
if (!result.success) {
  // Surface result.issues; do not substitute empty resources.
}
```

The public export `@design-studio/contracts/schemas/design-ir.schema.json`
references the same catalog, as do handoff-manifest, diagnostic/report,
resource/component/token/provenance/source snapshots, revision/locks,
patch/diff/review/approval, render/bounds, capture/scenario, validation,
implementation/metadata, response/job/receipt, budget/auth/capability schemas.
Provider request definitions are available from the catalog for later OpenAPI
composition. F08 owns actual HTTP/CLI application surfaces.

`validateContract` returns either `{success:true, stage:"schema-valid", value}`
or `{success:false, issues}`. `parseContract` throws `ContractBoundaryError`
with structured issues. Neither resolves references nor reports readiness.
Validation never mutates inputs, inserts defaults, coerces values, removes
unknown fields, follows remote references, or runs application/source code.
TypeScript declarations express shapes and unions, not all JSON Schema
refinements (patterns, numeric limits, and conditional requirements); runtime
validation is mandatory at untrusted boundaries.

JSON is interchange; YAML 1.2 core is authoring only. Reject duplicate keys in
both formats, multiple documents, custom tags, non-string map keys, non-finite
numbers, aliases, cycles, sparse/decorated arrays, accessors and non-JSON objects.
Aliases are deliberately outside the bounded authoring profile. UTF-8 input
is limited to 25 MiB; callers may impose a smaller limit. Syntactic JSON nesting
is capped at 128 independently of later expanded-node/component-depth budgets.
Dates are UTC RFC3339 with seconds and optional 1-3 fractional digits; invalid
calendar dates are rejected. Unsupported schema versions require explicit
migration to a new revision, retaining the old artifact.

## Structure, identity and normalization

One document has project/design/screen identities, a fixed design-unit viewport,
one `root`, and a `ResourceLock`. Structural kinds are exactly frame, column,
row, stack, scroll, text, image, icon, divider, shape, component, spacer, group,
unsupported. Screen is metadata, not a primitive. Buttons/toggles/inputs/lists
are accessibility/semantic roles or registered visual components.

The discriminated node union disallows child arrays on leaves and component
instances. Components have typed public `properties`, named `slots`, and a
versioned visual reference. An unavailable library may retain a labeled
snapshot-only expansion with no editable properties. Unsupported nodes have
no invented editable children; raw evidence, source bounds and an optional
inspection-only crop are distinct. Missing evidence is not an opaque fallback.

Stable IDs survive renames/moves; copies receive new IDs. F02 owns uniqueness,
persisted source identity maps, ambiguity proposals, and deterministic instance/
nested-slot namespacing. Array indices, labels and content hashes are not node
identity. Definition-local IDs never become globally shared instance IDs.

F02 owns the single normalizer and its defaults, before any renderer:

| Field/operation | v1 rule |
| --- | --- |
| Width/height | Required; nonnegative fixed number, typed length token, `hug`, or bounded `fill`. |
| Missing padding/margin/spacing | All sides zero; spacing zero. |
| Missing alignment/distribution/position/offset | `start`, `start`, `flow`, `(0,0)`. |
| Missing appearance/transform | No fill/border/shadow/blur; radius zero, opacity one, no clipping, identity affine matrix at origin `(0,0)`. |
| Direction | Row horizontal, column vertical, stack ordered overlay. Frame declares `flow`; group is a non-layout semantic container. |
| Allocation | Resolve tokens, expand components, measure intrinsic content, allocate equal remaining main-axis space to fills, arrange. |
| Coordinates | Parent padding belongs to parent; absolute child offsets are parent-content coordinates and consume no flow space. |
| Invalid dependencies | Negative sizes, contradictory min/max and hug around unconstrained fill fail; never select zero, stretch viewport or truncate text to conceal errors. |
| Geometry | Local transforms, measured bounds, source absolute bounds, paint order, clip ancestry and overflow remain separate. Matrix is `[a,b,c,d,tx,ty]`, with explicit origin. |
| Text | UTF-16 code units, zero-based half-open ranges. F02 checks bounds/order/overlap and surrogate boundaries. No implicit Unicode normalization. Grapheme editing needs an explicit adapter policy. |
| Scroll/capture | Viewport differs from content bounds. Record capture offset, content rectangle, insets and system-bar ownership. |

Canonical ordering/numbers/UTF-8/hashes are **not** implemented here. F02 must
specify them, preserve array order and accepted provenance timestamps, and
exclude volatile delivery data from content identity. Resource checks and
layout errors are not replaceable by schema validity.

## Pinned resources and authority

Visual definitions contain typed declarations/defaults, variants with typed
conditions and expansions, named slots with insertion anchors/cardinality,
bindings, declared transitive dependencies, and semantics/evidence. Bindings
use a small enum of visual destinations, not expressions or executable code.
F02 verifies property/default/variant compatibility, slot anchors and types,
acyclic expansion and resource budgets. Code mappings do not render anything.

`TargetCodeMapping` separately records logical component/version, target,
repository commit or hashed working tree, path/module/symbol, typed adapters,
supported variants, usage evidence, reviewer and approval revision. States are
proposed/approved/stale/rejected/unresolved. Name matches and indexes only
propose; no mapping becomes approved automatically. Repository identity is the
inspected baseline, not the implementation's future build.

Tokens carry scalar/composite tagged values, dimensions with design-unit units,
collections, explicit modes, aliases, declared types, selected modes, resolved
values or unresolved diagnostics, and target adapters. F02 checks alias cycles,
mode/type compatibility and definitions against resolved values. Literal
equality is not semantic identity. Composite typography/shadow is structured,
not a CSS string.

Assets include artifact bytes/hash references, dimensions/color/alpha, source,
usage and licensing/verification state. Fonts are either bundled identified
faces with rights/bytes or explicit local requirements with expected hash/size
and host-scoped verification. Installation, Figma availability or an embedding
flag is not redistribution permission. F05 owns signatures, decode, SVG
sanitization, font tables/glyph coverage and rights checks; missing/fallback
fonts invalidate strict text fidelity.

Provenance is a separate `nodes[stableNodeId][relativeJsonPointer]` map, not
value wrappers. Evidence uses immutable artifact hashes and source coordinates/
pointers. Exact-source, inferred, manual and approved-manual authority stay
distinct; inference confidence is an uncalibrated score. F02 must resolve
evidence/pointers, retain superseded history and keep conflicting exact sources
as conflicts. Manual decisions outrank inference.

## Supported M1 contract profile and unverified capabilities

The schema **represents** a bounded fixed static design vocabulary. The five
synthetic cases exercise shape/resource declarations, not rendered fidelity.
F06 must promote support through layout/render/golden evidence; F01 alone
does not claim these operations are implemented:

| Feature | Contracted subset | Required implementation evidence |
| --- | --- | --- |
| Layout | Fixed/hug/equal-fill frames/rows/columns/stacks, absolute content offsets, bounds clipping | F02 validation and F06 measurement/overflow cases |
| Text | Byte-pinned available normal fonts, explicit metrics/wrapping, UTF-16 ranges | F05 face/glyph checks and F06 actual font-use/text metrics |
| Paint | sRGB solid fill, simple border/radius/opacity/basic shadow | F06 per-feature fixtures; effects beyond profile disclose loss |
| Image/icon | Local PNG/raster identities and fit/crop/affine transforms; permitted sanitized vector assets | F05 decode/sanitization and F06 transform-aware capture |
| Components | Typed variants/slots and pinned visual expansion independent of code mapping | F02 acyclic closure/default/binding tests and F06 expansion rendering |
| Scroll | Explicit viewport/content bounds and capture offset | F06 bounded scroll/clipping fixtures |
| Unsupported | Complex masks, advanced blend/effects/vectors, responsive constraints, RTL/large text | Explicit unavailable/loss diagnostics, not implicit approximation |

The Windows-first G0 exception permits deterministic synthetic foundation work
only. macOS execution, real Figma import, account/seat/plugin eligibility,
direct paired-ingest transport and real device capture remain deferred.
Figma REST `sourceVersion`, plugin session/capture `contentDigest`, and an
asserted/verified/unknown file binding are different identities. Historical
fill gaps, null renders, downscaling, inaccessible dependencies, 429 retry
deadlines and changed captures stay explicit in source/capability diagnostics.
A label such as ARCHIVE is not a source-validity rule.

## Artifact authority, handoff and jobs

`StageAssessment` explicitly separates schema-valid, dependency-resolved,
renderable, exportable and implementation-ready, with pass/fail/inconclusive/
not-evaluated status. `DiagnosticReport.readiness` is ready/needs-review/blocked;
no sequence of implied promotions is implemented in F01.

Section 28's only handoff is `manifest.json`, `design.json`, `design.md`,
`reference.png`, `preview.png`, `metadata.json`, `components.json`,
`tokens.json`, `implementation.json`, `diagnostics.json`, and `assets/`.
There is no alternate component-mappings artifact. Paths/media/byte lengths/
SHA256, compiler/version/project/design/revision/target, resource locks,
approval, scenario and policy are explicit. Paths are portable bundle-relative
slash paths; host filesystem paths belong only in authorized host boundaries.
F04 still must enforce containment, case collisions, symlinks and actual bytes.

The manifest does not hash itself. Compute bundle identity from its canonical
payload including sorted artifact hashes, excluding only its own bundle ID/
self-hash fields and volatile delivery metadata. Payload artifacts cannot
embed bundle ID, which would form a hash cycle. Hashes detect corruption, not
authorship. Local approvals require the trusted project store; external
consumers need a configured authenticated/signed issuer. Fixtures are **not**
approved bundles, and `contract-examples.json` is explicitly non-materialized
shape data, not a compiled handoff or real screenshot.

F03 owns immutable revisions, compare-and-swap expected base/strong If-Match,
append-only reviews/comments/waivers, trusted context-bound approvals and
atomic persistent artifacts. A new design/resource/baseline/target/scenario/
policy requires new approval. Draft exports stay unapproved/needs-review.
Critical missing resources/behavior cannot be waived into an invented
implementation; noncritical mapping exceptions retain instructions.

F07 owns queued/running/waiting-for-user/retry-wait/cancel-requested/completed/
failed/cancelled/interrupted transitions, expiring leases/fencing/heartbeat,
finite budgets, project/actor/operation/payload-scoped idempotency, retry
deadlines, receipts and recovery. Completed means verified atomically committed
outputs, not a passing comparison. Cancellation is not rollback; a committed
receipt wins the race. Unknown external effects remain interrupted.

F08 composes the response schema/OpenAPI and calls shared services. A
non-streaming CLI emits one JSON object to stdout, redacted progress to stderr.
Async acceptance is a job, not an artifact-shaped success. Source status, job
status, and comparison verdict are separate. Exits are 0 success/async accepted,
1 operational failure, 2 invalid input, 3 policy fail, 4 inconclusive, 5 conflict/
required action. The typed error/retryability and job/diagnostic IDs remain
independent of that exit code.

The additive contracts package 1.1.0 extension provides closed revision/help/
version/api-description/stopped-service response data and shared `NOT_FOUND`.
All success data retains typed warnings. Existing accepted-job/job/artifact/
design/validation/capabilities and error envelopes remain valid, including
legacy shared optional data fields. Job data permits an optional safe nonnegative
`jobVersion`; F08 uses the separately exported `FoundationVersionedJobResponse`
refinement to require the actual stored row version on successful job responses.
That refinement reuses the envelope and does not accept failures or default a
missing version. `FoundationAcceptFixtureRequest`,
`FoundationRenderSubmissionRequest`, and closed empty `FoundationCancelJobRequest`
follow `RenderRequest`: endpoint `/v1` supplies request versioning; no top-level
request `schemaVersion`, authority context, callbacks or path IDs in JSON.
Artifact versions/identities and provider `contractVersion: "1.0"` are unchanged.
See [the contracts README](packages/contracts/README.md#additive-cliapi-v1-contracts-package-110)
for field limits, generated exports and the package/provider version distinction.

## Capture, comparison and limits

Scenarios pin application/repository identity, fixture, route, expected screen/
controls, locale/theme/font scale/orientation, fonts, readiness and capture
profile. Actual build/source commit or dirty digest and installation receipt
belong to each run, not a future-build approval. Explicit devices/server
ownership and per-device serialization are mandatory. Foreground, a stable
image, elapsed time or launch success is not scenario identity. Receipts carry
nonce, generation, build/screen/fixture, readiness and viewport evidence.

Capture output is binary `Uint8Array` PNG plus metadata. Raw evidence remains
separate from normalization. Only justified uniform scale, explicit rotation
and known content crop are allowed; unknown density/insets/state is inconclusive.
Never restart a shared adb server or reset/install apps implicitly.

`mobile-static-v1` uses **maximum absolute sRGB channel delta >16/255**; fail
above **1%** changed unmasked pixels globally or **0.5%** of each critical
region's own unmasked pixels. Exact independently measured geometry fails above
**2 design units** when required; SSIM is diagnostic only. Pin reference-space
critical regions, alpha background, metric/color/resampling implementation,
reviewed masks and coverage. Missing evidence/critical coverage or zero eligible
pixels is inconclusive, never zero-difference success. The policy's calibration
is explicitly unverified; comparator/calibration belongs to later work.

Default budgets: 25 MiB input, 64,000,000 raster pixels, 20,000 expanded nodes,
tree/component depth 128, 250 MiB snapshot assets. The conservative offline
request defaults additionally allow 30 seconds, 3 attempts, 25 MiB output,
**zero external calls/model tokens/model spend**. Owners can approve validated
finite configurations; designs/models cannot grant themselves budgets.
The normative 500-node/10-MiB performance profile and cross-host p95 targets
are not measured by F01.

## Dependency and test ownership

| Lane | Import from contracts; implement outside it |
| --- | --- |
| F02 | DesignIR/nodes, visual/token/provenance snapshots, locks and semantic patches; normalizer, resolver, canonical identities/diffs |
| F03 | Revision/expected base/review/approval/artifact/receipt types; transactional persistence, immutable history and trusted approval |
| F04 | Authorization/budget/request context, filesystem/process/credential/clock/provider primitives; real host/security boundaries |
| F05 | Asset/font/license identities and artifact/source contracts; bytes/decode/sanitization/rights |
| F06 | Renderer interface, render request/result/profile/bounds and resource closure; static renderer/goldens |
| F07 | Job/error/idempotency/lease/deadline/receipt contracts; job engine |
| F08 | Response envelopes, schemas, expected-base/auth context and exits; actual CLI/API application surface |

F01 owns this package and generated outputs. Consumers depend on
`"@design-studio/contracts": "workspace:*"` and must not copy interfaces or
change schema semantics independently. Root manifest/lock/config integration
is coordinated, not edited concurrently by all lanes. Contracts depend only
on schema/YAML tooling, never on downstream production packages.

`@design-studio/contracts/testing` exports reusable boundary assertions,
Figma/renderer/device/process/filesystem/credential fakes, a fake clock and
synthetic contexts. They are explicit opt-in test utilities, not production
fallbacks. Default providers report unavailable; scripted successes/partials
are test-controlled evidence, not real integrations. `assertProviderContract`
accepts an adapter's offline arrangement driver for availability, project/grant
rejection, cancellation and deadlines; real adapters additionally need their
specific binary/integrity/readiness and live permission-scoped suites.
`SEMANTIC_CASES` is an executable-readable ownership ledger explicitly labeled
`contract-only-not-executed`, not a passing semantic validator.
