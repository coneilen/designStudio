# Foundation fixture set v1

Five original authored synthetic cases share the complete resource snapshot
in `resources.json`. Each has independent DesignIR, source-authorship,
property-addressed provenance, diagnostics and contract-only semantic
expectations. `manifest.json` pins every data/resource/license byte by SHA256.
No Figma account, real app, existing P02 DOM probe, company image or company
font was used. Nothing here is a browser golden or approved implementation
reference.

| ID | Declared content |
| --- | --- |
| settings-screen | Travel settings; typed toggle-row component instances, checked/disabled semantics, manual tokens and alias |
| mixed-styled-text | Three UTF-16 ranges in `Read clear text.`, explicit metrics/color/size changes, normal face only |
| image-crop-transform | Original 200x100 four-stripe PNG; 100x100 center crop, independent 90-degree local transform |
| component-variants-slots | Off/on/disabled-on variants, stable definition-local IDs, named trailing badge slot |
| unsupported-feature | Authored complex-mask/backdrop-blur raw evidence, unsupported leaf and honest blocking loss diagnostics |

The shared snapshot includes settings-toggle-row v1 with all visual expansions,
five typed light-mode tokens (including spacing alias), the stripe image and
one font face. Code mapping is explicitly unresolved; no native component is
invented. Selected/resolved token entries are authored expected fixture values,
not evidence that F01 ran a resolver. Non-unsupported cases remain needs-review;
all downstream semantic/render/export checks are not-evaluated. Unsupported
stays blocked with no fabricated crop/children or successful renderer.

## Font and asset rights

The unmodified **ABeeZee Regular**, normal style, weight **400**, is included
under **SIL Open Font License 1.1**, preserving its copyright and Reserved Font
Name in `assets/OFL.txt`. It is not a platform/company font.

- Source repository: `google/fonts`.
- Source commit: `fffdadf0f0c9cc1ec8b407063424a8bfbee05611`.
- Source path: `ofl/abeezee/ABeeZee-Regular.ttf`.
- Actual name-table version: `Version 1.003; ttfautohint (v1.8.3)`.
- Bytes: **46,016**.
- SHA256: `2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9`.
- PostScript name: `ABeeZee-Regular`.

The public pinned source URL and license artifact hashes are recorded in
`resource-authorship.json` and `resources.json`. No bold/italic/synthetic face
is requested. Presence/name/hash checks do not establish actual browser face
selection or glyph/rasterization parity; F05/F06 must verify those. Availability
and glyph coverage are deliberately declared/unverified, not a claim of an
executed font pipeline.

All synthetic structures, text, original stripe PNG and generator code use the
included MIT `LICENSE.txt`; the font remains separately OFL. Stripe bytes are
an image input, not a rendered screen. The source specification and feasibility
artifacts were not modified. Both license resources preserve their exact bytes
through Git; line-ending normalization must not invalidate the resource locks.

## Reproduction and limits

`node tests/fixtures/foundation/generate.mjs` regenerates only the named fixture
outputs from authored definitions and existing licensed font bytes. It does
not download, inspect host fonts, render, capture a device, or call a provider.
`pnpm fixtures:check` detects drift without changing files. Do not regenerate
fixtures just to hide a failed expectation; review changes to authored
definitions and byte manifests together.

`contract-examples.json` contains non-materialized shape examples for public
artifacts. Its fake plugin binding is asserted, source snapshot partial,
review draft, job queued and comparison inconclusive. Reference/preview
descriptors are explicitly illustrative stripe data, not source or browser
evidence. The example bundle ID is a labeled synthetic identifier, not output
from a handoff compiler; do not promote it to a real complete bundle.

No live platform or cross-host evidence follows from fixture/schema validity.
