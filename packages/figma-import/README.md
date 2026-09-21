# @design-studio/figma-import

Pure converter with current `fixed-v2` policy (implementation revision 0.3.0)
and explicitly selectable `fixed-v1` replay (revision 0.2.0).
This is **not a live Figma importer, authorized intake host, renderer, or installed
CLI feature**. It has no network, filesystem, credential, plugin, project-creation,
job, or process capability. Package fidelity tests use independently synthetic
sources, not private design captures.

## Public API

- `parseFigmaSelection(url): FigmaSelection` validates an explicit HTTPS
  `/design/{key}/{title}` or `/file/{key}/{title}` selection. It does not resolve
  a file-versus-branch key or establish access. Branch routes, missing/conflicting
  nodes, foreign hosts, credentials, and unsupported parameters fail.
- `convertFigmaSnapshot(input, limits?): FigmaConversion` accepts original
  `Uint8Array` structure bytes, an untrusted `FigmaIntakeManifest`, logical
  project/design/intake/actor IDs, and a caller-declared local `observedAt`.
  Optional resources are canonical byte-pinned **declarations**, not grants.
  `policy` is the caller's intended `"fixed-v1"` or `"fixed-v2"` policy;
  omission selects current v2. Unknown policies fail.
- `convertFigmaStructure(input, limits?): FigmaStructureConversion` shares the
  same semantic implementation, but returns **no SourceSnapshot/SourceIdentity**.
  Its explicit selected view can retain bounded extra API siblings in the
  original nodes envelope without converting them. Original hash and JSON
  pointers refer to the unmodified envelope, not rewritten selected-node JSON.
  The `figma-structure-fixed-v2` projection is source-neutral, not a REST proof.
- `verifyFigmaConversion(input, candidate, limits?): void` independently
  recomputes the output using separately retained original inputs and the pinned
  converter. Rejects changed projections, designs, reports, maps or original
  bytes. It is not a signature/authorship or rights verification.
  Replay selects policy from the separately retained input, never from the
  candidate's adapter. Legacy candidates require explicitly intended v1;
  they cannot downgrade a current-policy verification.
- `FigmaImportError.diagnostic` exposes typed conversion failures. The shared
  contracts parser can also throw `ContractBoundaryError` for malformed JSON.

`FigmaConversion` returns copied original bytes, `SourceSnapshot`, optional
`DesignIR`, `ResourceSnapshot`, `FigmaSourceMap`, `FigmaConversionEvidence`,
`ProvenanceSnapshot` and `DiagnosticReport`. Invalid selected geometry or a null
selected node can retain diagnostic-only evidence with no DesignIR. Malformed
envelopes, corruption, ambiguous selections and budget violations throw.

The nodes envelope must contain exactly the selected `nodes[id].document`
subtree. Duplicate source IDs/JSON keys, absent container children, a mismatched
document ID, unrelated sibling selections and invalid UTF-8 are rejected.
Unknown properties remain in the immutable source and get explicit losses;
the small ignored-metadata list is inventoried separately. Nodes-envelope shape
support does not establish that the bytes came from Figma or are untruncated.
Plugin `JSON_REST_V1` compatibility is **not** claimed.

Copied node names have property-level projections; the screen label derives
from the projected root label. `absoluteRenderBounds` is not reconstructed by
this fixed profile and produces an explicit loss rather than a silently dropped
visual footprint. Loss evidence points to the exact existing source property,
including escaped JSON Pointer keys. A missing property instead references its
containing source node, without inventing evidence at a nonexistent pointer.

## Implemented subset

| Source | Conversion |
| --- | --- |
| Fixed frames/groups | Captured dimensions, parent-relative absolute coordinates, source bounds and paint order. Groups remain groups. |
| Rectangles/ellipses | Existing DesignIR shape nodes. |
| Solid paint | One visible solid sRGB fill; supported uniform inside border, uniform radius, opacity and bounds/rounded clipping. |
| Auto-layout | Fixed captured geometry only, with an **approximated** loss and blocked strict readiness; not editable auto-layout equivalence. |
| Text | Explicit characters/pixel metrics, exact matching declared PostScript face/family/weight/style, UTF-16 mixed ranges. Missing/ambiguous fonts or unsupported text styles become raw-preserved unsupported nodes. Visible glyph strokes produce a blocking property loss, never a box border; empty/hidden strokes produce neither. |
| Images, vectors, components/instances | Raw-preserved opaque nodes or blocked paint losses; no decoded asset, invented expansion, generated SVG or screenshot fallback. |
| Translation-only transforms (v2) | Exactly identity-linear, finite 2x3 matrices are admitted. Captured absolute bounds determine parent-relative fixed layout; translation is not applied twice. Nested supported containers are traversed. Transform handling has source-linked fixed-layout evidence. |
| Other transforms, hidden nodes, masks, effects, advanced/unknown paint or layout | Explicit node/property losses. Rotated/scaled/reflected/skewed/malformed transforms and hidden nodes remain opaque; no geometry reconstruction from axis-aligned bounds. V1 retains its original presence-only transform rejection for replay. |

This profile does not implement the larger milestone's semantic auto-layout,
component expansion, image/crop conversion, resource decoder, or source-preview
comparison. ABeeZee appears only in an original synthetic test that explicitly
declares it; no source font is replaced by ABeeZee or a host font.

## Authority and evidence

All `convertFigmaSnapshot` outputs use `SourceIdentity.transport: "figma-offline"` with asserted URL
binding, `consistency.guarantee: "unknown"`, no fabricated provider requests, and
`completeness: "partial"`. A declared source version is recorded only as a
declaration. Timestamps are caller-declared local byte observations, not a
verified Figma capture interval. This remains true when all supplied hashes
match. Source reference/resource manifest entries are declarations and are not
added to verified source artifacts without their actual bytes.

Only the original structure artifact is byte-checked. Reference PNG
dimensions, font/asset bytes, glyphs, license/embedding rights and current
authorization require a separately approved host/F05 integration. The converter
never declares dependency resolution, rendering, export, or implementation
readiness. Missing source/reference evidence remains visible even for a simple
valid draft. No approval or render artifact is created.

IDs derive from logical project/design/intake and source-node coordinates, not
names, order, or pixel/content hashes. Replays within that intake preserve IDs;
independent asserted intakes do not silently merge. A persisted authoritative
identity registry and verified cross-capture reconciliation remain later work.
V2 additionally binds derived artifact scope to its policy descriptor and node
identity to its adapter. Explicit v1 retains the original identity formulas and
byte-reproducible outputs; changing policy does not overwrite a prior conversion.

Original bytes are never canonicalized or replaced. Derived resources are
canonical-byte locked. Conversion projections identify a raw node pointer,
versioned conversion rule and converted property; F02 provenance checks these
values against the draft. `exact-source` here means exact reproducible
conversion relative to supplied source, **not authenticated Figma provenance**.
Consumers must run source replay verification before trusting these projections,
then independently enforce source/resource authority. Accepting a candidate's
self-consistent projection alone is insufficient.
The separate native application wrapper loads its own committed, current-project
capture receipt and exact original artifacts before invoking the neutral API.
It binds the returned source map to the physical committed REST SourceSnapshot;
callers cannot supply JSON, hashes or callbacks to issue that binding. Native
capture completeness still grants no fonts, image-fill rights or render readiness.
The wrapper binds the current converter policy to both new design identity and
the immutable conversion operation key. Reopening an already converted capture
can create a distinct v2 result without replacing its old v1 receipt or artifacts.
Source artifact IDs cannot alias the generated projection artifact; evidence
dispatch requires both the artifact ID and digest, rejecting unknown identities.

## Limits and execution

Defaults: 25 MiB input, 20,000 source nodes, depth 128 (JSON syntax has its own
128 limit), 25 MiB derived output, 200,000 report entries, and a 30-second
deadline. Caller limits may only reduce the profile bounds. Shared mutable
buffers are rejected. Checkpoints
run before/after parse and during traversal; cancellation and expiry are typed.
Every source property is checkpointed. Losses and diagnostics use constant-time
ID indexes rather than rescanning their accumulated arrays. `maxReportEntries`
limits the combined diagnostic/loss/projection/ignored-property inventory and
rejects overflow explicitly rather than truncating the report.
The completed projection is validated once per contract, then reused during
provenance resolution with a deadline/cancellation checkpoint per evidence.
The pure API is synchronous: it cannot interrupt JavaScript parsing mid-call.
A future runtime must execute it in a bounded worker for hard wall-clock
termination; no hard process-lifecycle guarantee is claimed here.

From the workspace root, build contracts/design-ir/importer and run:

```text
pnpm exec vitest run --project unit packages/contracts/tests packages/design-ir/tests packages/figma-import/tests
pnpm exec vitest run --project smoke packages/contracts/tests/package.smoke.test.ts packages/figma-import/tests/package.smoke.test.ts
pnpm contracts:check
pnpm fixtures:check
pnpm typecheck
```

Original synthetic tests cover authority separation, loss regressions,
provenance replay tampering, fonts/ranges, byte integrity, identity, budgets,
and clean-process package consumption. Numerical nested translation and pure
layout/CSS tests cover parent offsets, paint order, clipping, borders and declared
text appearance without launching a browser. These are not pixel, font-rights
or real-source fidelity proof, and fewer losses do not establish readiness.

Public REST nodes/property documentation was reread on 2026-09-18:
[file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/),
[node types](https://developers.figma.com/docs/rest-api/file-node-types/),
[property types](https://developers.figma.com/docs/rest-api/file-property-types/).
No authenticated API calls were made.
