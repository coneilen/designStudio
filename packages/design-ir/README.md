# @design-studio/design-ir

F02 deterministic resource kernel, version 1.0.0. The only production dependency
is `@design-studio/contracts` (`workspace:*`). All nodes, snapshots, provenance,
diagnostics and stages are the shared generated types; there is no second node
model, schema copy, renderer, repository index, live importer or storage engine.

## Consumer entrypoints

```ts
import {
  acceptedContent,
  canonicalBytes,
  canonicalDigest,
  dependencyBytes,
  hashBytes,
  resolveDesign,
  resolveTokens,
} from "@design-studio/design-ir";

const result = resolveDesign(design, resources, {
  resourceBytes, // exact accepted snapshot file bytes, not a reserialization
  maxExpandedNodes: 20_000,
  maxDepth: 128,
});

// Inspect the report even when a normalized design is present.
// Unsupported leaves remain inspectable; they never become editable fallbacks.
if (result.design && result.report.readiness !== "blocked") {
  const content = acceptedContent({ content: result.design });
  // F03 persists these bytes/digest atomically; this function does not persist.
}
```

`resolveDesign` returns `DesignResolution`:

- `design?`: a copied, expanded and normalized **DesignIR**, absent on invalid
  layout/resources/identity or exhausted budgets. No truncated successful tree.
- `tokens?`: a copied token snapshot with independently checked resolved values;
  original revisions, selected modes and target adapters remain unchanged.
- `instances`: logical component/version, effective typed public properties,
  selected variant, definition/snapshot-only mode, local identity and slot maps.
  The accepted authoring design remains the input, not the expanded tree.
- `closure?`: conservatively includes the **complete pinned resource snapshot**,
  sorted artifact descriptors (assets, bundled fonts and notices), and external
  artifact references (source evidence, local requirements, derivatives and
  snapshot-only expansions). It is not a materialized or trusted handoff bundle.
- `report`: shared `DiagnosticReport` and `StageAssessment` values.

Shape validation runs at public model boundaries, separately from semantic
validation. A `KernelError` carries a shared `Diagnostic`; `resolveDesign`
converts those errors into a blocked report. Standalone resolvers/helpers throw
them. Non-JSON canonical input throws `TypeError`; authoring byte parse failures
remain explicit contract-boundary errors. Unexpected exceptions are not caught
and converted to empty/success-shaped results.

Supplying resource bytes verifies **both** their exact SHA256 against the lock
and their parsed content against the supplied resource object. Absent bytes,
`closure.integrity` is `not-verified` and `dependency-resolved` is inconclusive.
Verified snapshot bytes do not verify all referenced bytes, font use, rights,
source truth, authorization or approval. `dependencyBytes(artifact, bytes)`
checks a dependency's exact length/SHA256 and returns a defensive copy. Raw
filesystem confinement, signatures, decoding and font checks belong to F04/F05.
Closure identity checks share one artifact-ID/hash table across the snapshot,
descriptors and references. Conflicting hashes fail with `ARTIFACT_INTEGRITY`
regardless of insertion order, even when the snapshot bytes themselves are valid.

Successful semantic resolution yields `needs-review`, never `ready`.
Renderability, exportability and implementation readiness are not promoted.
Unsupported leaves/effects produce explicit blocking diagnostics/losses;
no invented visual, font, component or native-code fallback is used.

## Canonical accepted content and byte identity

`canonicalBytes(unknown)` implements **RFC 8785 JSON Canonicalization Scheme
(JCS)** over this bounded I-JSON input profile:

1. Object property names are sorted lexicographically by UTF-16 code units,
   recursively. Numeric-looking keys are not reordered numerically.
2. Arrays preserve order. Whitespace and BOM are absent.
3. Numbers are finite IEEE-754 binary64 values, serialized using ECMAScript
   shortest-round-trip JSON number formatting (including its exponent rules).
   Negative zero becomes `0`. Large integers requiring precision beyond binary64
   must be represented by a schema-approved string, not a bigint or lossy cast.
4. Strings use JSON escaping and UTF-8 output, with no Unicode normalization.
   Unpaired UTF-16 surrogates are rejected rather than replaced.
5. Only null, booleans, finite numbers, strings, dense ordinary arrays and plain
   objects (including null-prototype records) are accepted. Reject undefined,
   functions, bigint, symbols, accessors, hidden/decorated properties, custom
   prototypes, sparse arrays and cycles. No `toJSON` or getter is executed.
   Nesting is limited to 128. Untrusted serialized input still needs the
   contracts' 25 MiB bounded authoring parser; this is not a file reader.

`canonicalDigest(value)` is lowercase hex SHA256 of `canonicalBytes(value)`.
`hashBytes(bytes)` hashes bytes exactly, without parsing, normalizing line endings
or changing PNG/font data. **A raw-file lock and a canonical JSON content hash
are different identities.** The five F01 fixtures retain their original raw-file
locks, bytes and manifests.

`acceptedContent({content, delivery?})` returns `{bytes, sha256, byteLength}`.
Its **only exclusion envelope** is the sibling `delivery` object, whose optional
fields are `path`, `deliveredAt`, `temporaryUrl`, `credentialReference`. It is not
serialized. The entire `content` value is included without key-based filtering.
Fields named `path`, `url`, `acceptedAt`, `capturedAt` or similar inside accepted
content are retained. Credentials must not be inserted in accepted content.
No host path discovery, recursive URL stripping or secret-redaction heuristics
are part of canonicalization. A compiler must construct a deliberate content
envelope; this package does not silently reinterpret a manifest.

No timestamp is read from the clock or regenerated. Reusing an accepted
provenance entry ID to rewrite its timestamp is rejected. Byte results do not
alias supplied buffers, and model outputs do not alias authoritative inputs.
Returned arrays/objects are caller-owned; persist or treat them as immutable
accepted values. F03 owns durable immutability/CAS, not JavaScript object freezing.

## Normalization and layout prerequisites

One internal normalizer supplies the defaults in `DESIGN_IR.md`, after token
resolution and component expansion: zero padding/margin/spacing, start alignment
and distribution, flow position, zero offsets, radius zero, opacity one, no
clipping, identity affine transform at origin zero. Missing optional paint,
border, shadow and blur mean **absent**, not synthesized transparent resources.
Row/column/stack direction is intrinsic; frames require explicit flow and
conflicting intrinsic flows fail. Groups remain non-layout semantic containers.

Lengths resolve to design units. Checks include fixed/min/max contradictions,
negative/nonfinite dimensions, incompatible tokens, fixed aspect-ratio
contradictions, fill without a finite ancestor/explicit maximum, frame flow,
font declarations/weights, ordered nonoverlapping UTF-16 ranges and surrogate
boundaries, crop source-pixel bounds, and scroll viewport/content/offset
prerequisites. Source absolute bounds/text metrics stay in metadata; they are
never used as fabricated intrinsic or rendered measurements.

Text measurement, equal-fill allocation, transforms/clipping during arrangement
and measured text/layout overflow belong to F06. The report says they are not
measured; it does not choose zero, truncate text, stretch a viewport, infer a
native density or claim an overflow pass. Availability/rights/glyph/actual-face
verification remains F05/F06. Synthetic fixtures use only pinned ABeeZee Regular,
normal 400, and the original stripe PNG.

## Tokens and visual components

`resolveTokens(snapshot)` returns a value map, a normalized snapshot and a
typed `ValueResolver`. Collection IDs, explicit selected modes, all declared
mode values, aliases, composite typography/shadow references, source/target
adapter types and explicit unit conversions are checked. The mode graph checks
cycles under consistent per-collection selections, including inactive modes;
cross-collection aliases use the target collection's selected mode. Graph
exploration is bounded to 20,000 visits and depth 128. Cycles/limits fail rather
than returning partial values. Authored `resolved` entries must agree with actual
values, mode and alias chain; they are not trusted caches.

`literalTokenCandidates(value, values)` returns **proposed** candidates only.
Equal literals never establish semantic identity or approve an adapter.
No registry version, target adapter or selected mode is silently updated.
For a typography `styleToken`, the complete literal typography declaration must
agree with the resolved style; it is an accepted snapshot, not an unspecified
override precedence. Named fonts are still checked separately by `resolveDesign`.

`expandComponents(root, componentSnapshot, limits)` validates typed required
properties/defaults/allowed values, variant conditions, bindings, slot types,
cardinality and anchors, and the entire pinned component graph (including
unselected expansions). Duplicate IDs and contradictory declarations fail.
Instance properties override defaults. Explicit variants must match; implicit
selection requires exactly one matching variant if variants exist. A definition
with no variants uses its base expansion. There is no unlabeled fallback for
zero or multiple variant matches.

Slots insert children or replace a non-root structural child; overlapping anchor
declarations are rejected. Bindings are only the shared allowlisted visual
destinations, with typed sources and valid destination nodes. Definition-level
semantics supply defaults, expansion semantics refine them, and explicit
instance semantics override them. Root instance layout/paint overrides preserve
unspecified definition fields. Unsupported semantic destinations fail, rather
than being discarded.
Finite authored slot trees may nest the same component/version. Crossing an
authored slot root starts a new definition-recursion path without resetting global
expanded-node, tree-depth or component-depth budgets. Declared recursive resource
graphs still fail; slot namespacing is unchanged.

Code mappings are preserved and validated as declarations, never rendered or
executed. An unresolved mapping does not block a complete visual expansion.
Repository symbol existence, target type compatibility, event execution and
approval authenticity cannot be verified by this pure kernel.

An unavailable definition can use a **labeled snapshot-only** expansion with
empty properties/slots and no variant. Any such public edit is refused. This is
not a reusable invented component. The sidecar mode and source reference remain
available to later editors; editing expansion internals requires a separate
explicit detach/revision workflow.

## Stable identity and provenance

`namespaceId(instanceId, path)` hashes the domain-separated identity tuple
`["design-ir-instance-v1", instanceId, ...path]` using JCS/SHA256 and returns
`instance_<hex>`. It hashes **identity coordinates**, not visual content, names,
revision numbers, array positions or library versions. Root expansion identity
is the instance ID. Definition descendants use `["definition", localId]`;
override descendants use `["slot", slotName, authoredId]`. Nested instances use
the enclosing namespace as their own instance ID. Global collision checks run
after expansion. Move/rename/revision operations retaining IDs retain identity;
moving an override to another named slot deliberately changes its slot namespace.

`copyNode(node, allocateId)` clones the shared node tree, requires fresh valid
IDs for every copied node, and returns an old-to-new identity map. The injected
allocator must reserve against the destination design as well; the final
`resolveDesign` catches cross-tree collisions. It does not allocate based on
labels or content hashes.

`reconcileIdentity(persisted, sourceKey, candidates)` keys exact mappings by
adapter/document/optional branch/source-node ID, excluding the changing snapshot.
Known mappings are retained. Missing/ambiguous matches return proposals, even
for one candidate; the helper never guesses by name, position or hash.
Persisted mapping conflicts fail. Persistence/explicit acceptance belongs to F03.

`validateProvenance(design, snapshot, resolveEvidence?)` checks node IDs, relative
JSON pointers (including escapes and array indices), evidence references,
supersession references/order/cycles and conflicting exact sources. The optional
callback supplies trusted parsed source documents by immutable evidence
reference; all source pointers, including historical ones, are checked.
Without it, external source pointers/bytes remain explicitly unverified.
With it, contradictory exact values and stale exact labels are diagnosed.
The callback must verify raw source integrity at its own boundary; this helper
does not equate parsed-object hashes with source file hashes.

`updateProvenance` appends superseded entries to history and accepts only a
fresh entry ID, valid evidence links and non-backdated accepted timestamp.
Manual decisions beat inference. Two different exact sources conflict rather
than being arbitrarily selected. An approved-manual entry may be superseded by
a new manual edit, preserving the historical approval without transferring it.

`reconcileProvenance(before, after, snapshot, replacement)` compares the values
at stable property addresses: moves retain evidence; removed properties/nodes
move to history; changed values require new provenance and cannot keep an
exact-source label. The caller supplies accepted evidence/time/actor information.
Run full semantic/provenance validation on the resulting candidate before
committing. These helpers do not apply arbitrary semantic patches, check a CAS
base, import Figma or implement live synchronization.

## Evidence and boundaries

The package tests run all five foundation cases through semantic resolution,
plus canonical vectors, nested components/slots, mode/alias/composite cycles,
missing resources/fonts, typed property/adapter/binding errors, budgets,
provenance conflicts/supersession and immutable-input regressions. A separate
Node smoke consumer imports the built public entrypoint.

Run from the workspace root, with the pinned Node/pnpm:

```text
pnpm --filter @design-studio/design-ir build
pnpm exec vitest run --project unit packages/design-ir/tests
pnpm build
pnpm typecheck
pnpm lint
pnpm exec vitest run --project unit --project smoke
pnpm contracts:check
pnpm fixtures:check
```

This is Windows synthetic semantic evidence, not a render golden, calibrated
performance result, macOS test, live model/Figma integration, asset decoder,
accessibility certification, handoff compiler or approved implementation.
