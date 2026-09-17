# @design-studio/assets

F05 bounded, offline-first input pipeline; package 1.0.0 / schema 1.0.
Consumes public `@design-studio/contracts` types. Shape validity is not byte
validity, rights approval, render readiness or implementation readiness.

## Public API and composition

`AssetPipeline({filesystem, authorize, rightsAuthority})` requires all three
dependencies. There is no production fake, implicit host authority, database,
network client, cache store, publication or garbage collector.

- `stageSnapshot(artifactRootId, AssetInput[], OperationContext)` accepts image
  inputs (`kind`, `id`, `bytes`, `license`, `notice`, `source`, `usageNodeIds`)
  and font inputs (`kind`, `bytes`, `face`, `text`, `notice`). It returns
  `StagedSnapshot`: `staged`, `images`, `fonts`, `totalBytes`, `permissionScope`.
  Images contain `{resource: AssetResource, mediaType, original: Artifact}`;
  fonts contain `{resource: FontResource, face}`. These are staged, not committed.
- `readCached(CacheRequest, "offline" | "online", context, CacheLookup)`
  requires caller-owned metadata lookup. Requests contain `artifactRootId`,
  `sourceSha256`, `dependencyHashes`, `derivativeVersion`. Lookup returns
  `{key, projectId, permissionScope, artifact}` or `undefined`. Returned bytes
  are copied and hash/size verified. Offline freshness is `unknown/offline`;
  online cache reads are `not-checked`, not evidence of source freshness.
  Requests (including dependency arrays) are owned before the first await;
  lookup records are owned immediately after lookup. Later caller/store
  mutations cannot replace the authorized root, key or artifact identity.
  Trusted authorization objects, live signals and clocks are not cloned.
- `cacheIdentity(CacheIdentity)` hashes project, artifact root, permission
  revision, source hash, sorted dependency hashes, adapter/schema/derivative
  versions. Retrieval URLs never participate as durable resource identities.
- `classify`, `decodeRaster`, `sanitizeSvg`, `inspectFont`, `verifyFont`,
  `verifyRights`, `verifyBytes`, `sha256`, `validateLimits`, `inputLimit`,
  `bound`, `checkContext`, `publicAddress`, `fetchRemote`, `ASSET_PROFILE`,
  `AssetError`, and `AssetStagingError` are named exports. Inspection helpers
  do not independently authorize filesystem or network access.

The required async `authorize(context, artifactRootId, "read" | "write")`
must call F04's trusted `authorizeOperation(context,
{projectId, resourceKind: "artifact", resourceId: artifactRootId, operation},
authority)`. Return `{permissionScope, offlineAllowed}` from **trusted policy
composition**, not asset input or self-asserted grants. `permissionScope`
identifies the policy/permission revision. Gate before every stage and before
any cache existence/result disclosure. Recheck current authorization on reads;
expired authorization is not a cache miss and cannot trigger a stale fallback.

F03/F04 agreed physical namespace: `blobs/<lowercase SHA-256>`, relative to
the configured artifact root. **Different project/permission domains that
must not discover shared content require distinct physical roots/stores.**
The root must be provisioned and bound to its project and access policy by
F04; a shared writable root is not an isolation mechanism. F05 deduplicates
only within one authorized snapshot invocation; it never probes other stores.
The same content hash/relative path in isolated roots does not grant access.
Host paths, containment, reserved names, symlinks and hostile local writers are
F04 concerns, not reimplemented here. No archive extraction is supported.

Every returned F04 `StagedArtifact` is preserved verbatim, including its generic
`application/octet-stream` physical media type. Actual decoded/sanitized media
is separate evidence; do not mutate stage receipts before F03 commits them.
Original bytes, sanitized derivatives and unmodified license notices are
separate content-addressed blobs. Provenance and usage remain in resource
metadata. Neither inspection nor sanitization changes source evidence.
Prepared image/font resource metadata is checked against shared contracts
before any write, then checked again using actual stage receipts before
success. A post-stage metadata failure retains receipts for recovery.

`AssetError.diagnostic` contains a stable code/message and measured/allowed
values for budget failures. `AssetStagingError` includes all known completed
`staged` receipts plus `boundaryStatus`, including cancellation or expiry
between writes. No success-shaped partial snapshot, publication or cleanup
under expired/cancelled authority occurs. F03/job recovery owns orphan inventory,
commit, retention and deletion (including an interrupted write with no receipt).

## Verified profile and limits

| Input | Implemented profile | Explicit limitations |
| --- | --- | --- |
| PNG | Signature, CRC/order/length checks; dimension/pixel/RGBA output preflight; capped zlib inflate with exact decoded stream length; actual pngjs decode; measured alpha | Only 8-bit noninterlaced RGB/RGBA. JPEG and WebP are signature-classified but have **no decoder support**. Palette/grayscale/16-bit/interlacing/APNG/tRNS/ICC and unknown chunks are rejected. |
| Color | Explicit sRGB chunk is recorded as sRGB; absent sRGB remains `unknown`; standard gAMA and pHYs accepted without treating them as proof of primaries | No ICC conversion, EXIF orientation, wide gamut or color-fidelity promise. |
| SVG | Strict UTF-8/XML reconstructed from allowed `svg`, `g`, `title`, `rect`, `circle`, `ellipse`, `line`; positive integer intrinsic width/height, bounded numeric geometry, hex colors and opacity; separate derivative hash | Fractional intrinsic dimensions are unsupported (never rounded); fractional child geometry remains supported. No paths/polygons/transforms, CSS, visible text, images, use/refs, gradients, masks, filters, animation, handlers, script, foreign content, entities/DTD/CDATA/comments/processing instructions. Unsupported features are rejected, not silently stripped. |
| Fonts | Static standalone TrueType sfnt table checksums/ranges, head/maxp/loca bounds, actual Unicode names, OS/2 weight/style/fsType, cmap4/12 requested-code-point coverage | No WOFF/WOFF2/TTC/CFF/variable/color fonts, shaping, hint execution, glyph rasterization or font installation. This is a face/coverage inspector, **not a complete glyph-program sanitizer or browser font-use proof**. F06 retains engine font sanitization and actual-use checks. |
| Remote | Allowlisted HTTPS origin and each redirect; all DNS answers public; address-pinned transport contract and actual-peer check; byte/time/call limits, cancellation, no auth-failure fallback | Only policy orchestration over injected DNS/transport was tested. No native transport is shipped and no real remote asset fetch was performed. |

Budgets are required, schema-validated finite safe integers. Defaults from
contracts are 25 MiB per input, 64,000,000 decoded pixels, 250 MiB unique snapshot
bytes, 20,000 items/chunks/elements, depth 128, 25 MiB output and 30 seconds.
Callers may approve validated alternatives; designs cannot authorize limits.
Equal thresholds pass; over-limit diagnostics include measured and allowed.
The output budget independently limits RGBA bytes and total staged bytes, so
the default output cap can be stricter than the pixel/snapshot caps.

All unique originals/notices are snapshotted after initial authorization and
before subsequent awaits; derivatives join the same byte ledger. Final
snapshot and aggregate operation-output checks happen before the first write.
No silent truncation or partial-image substitute exists. Parsing one supported
file is synchronous and bounded by bytes/pixels/elements; cancellation and elapsed
duration are checked at pipeline phase boundaries, not preemptively inside zlib.
Host adapters must honor their own operation deadlines/cancellation.

Decoded output limits are not a process RSS cap: the working set includes
the immutable snapshot, compressed bytes, capped scanlines and decoder buffers.
The synchronous PNG preinflate is intentionally duplicated with pngjs decode:
pngjs's own inflater is not relied on as the compressed-bomb allocation guard.
There is no claim of a 64-MP performance target or a hardened hostile-code sandbox.

## Font rights and identity

`verifyFont(bytes, expected: FontResource, text, notice, use, rightsAuthority,
limits)` checks actual hash/size, family, PostScript name, style, weight and
full name-table version. Missing/substituted/synthesized faces and missing glyphs
fail. `inspectFont` additionally exposes missing code points; results bind
coverage to exact font `sha256`, `byteLength` and `textSha256`, without Unicode
normalization. New text requires another coverage check. LF/CR/tab are layout
controls, not required glyphs. A successful cmap lookup is not shaping or proof
the renderer actually used that face; `document.fonts.check` is not used.

`RightsAuthority(license, contentSha256, use)` is mandatory trusted policy,
binding source/license provenance and exact content to the requested
`redistribute`, `embed` or `local-render` use. Declared permitted flags and an
intact notice alone cannot confer rights. Installation and `OS/2.fsType` are
never redistribution grants. Local-requirement bytes may be verified in place,
but `stageSnapshot` refuses to turn a local requirement into a bundled font.

The only licensed font fixture is unmodified ABeeZee Regular, normal 400,
version `1.003`, 46,016 bytes, SHA-256
`2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9`.
The original OFL notice is 4,516 bytes, SHA-256
`f0376d04eb58fb19e9f1690a99a1eb37380ad0246f7d503f2abd8e8a74ed12be`.
Foundation manifests, resources and license bytes are read-only; no inferred
bold/italic face or copied installed font is included.

## Remote adapter obligations

`fetchRemote(url, context, RemoteDependencies)` requires `allowedOrigins`,
trusted `authorize(context, origin)`, `resolve(hostname, signal)` and
`transport({url, address, serverName}, signal)`. Transport must connect only to
the supplied address, verify TLS for the original server name, disable proxy
and implicit redirects/decompression, and return actual `peerAddress`,
`status`, optional `location/contentLength/contentEncoding`, byte-stream `body`
and synchronous `close()`. DNS is revalidated for every redirect; mixed
public/private answers, local/metadata/link-local/transition addresses fail.
Cancellation, current authorization and elapsed duration are rechecked after
awaited authorization and DNS preparation, before initiating DNS or transport;
an expired preparation step cannot initiate the next external action.
HTTP compression is unsupported. Signed URLs and underlying exception messages
are not included in returned metadata/diagnostics.

Default `maxExternalCalls: 0` and `egress: "deny"` prohibit external calls.
Inject only an audited adapter that honors address pinning and abort/close:
an injected transport can lie, so fake tests are not evidence of real TLS,
resolver or socket behavior. No localhost SSRF exception or product URL test
was used. There is no remote-result cache or stale-on-error path.

## Dependencies and local evidence

Production additions are pure-JavaScript, zero-transitive-runtime-dependency
`pngjs@7.0.0` (MIT), `sax@1.4.1` (ISC), `ipaddr.js@2.2.0` (MIT).
Development declarations: `@types/pngjs@6.0.5`, `@types/sax@1.2.7`.
No dependency install scripts/native build approvals, Sharp, Python, image
service or comparator were added. Candidate `saxes@6.0.0` was rejected after
actual strict TS7 declaration failures; no skipLibCheck or dependency patch.
Generated lock additions preserve existing versions/integrities and omit
environment-specific tarball URLs. The existing trusted mirror supplied SHA-1
integrities; this does not claim independent public-npm/SHA-512 verification.

Run the dependency-ordered root build **before** typechecking; then root unit
and smoke commands discover this package automatically. Focused execution:

```text
pnpm build
pnpm typecheck
pnpm exec vitest run --project unit packages/assets/tests
pnpm exec vitest run --project smoke packages/assets/tests/package.smoke.test.ts
pnpm exec biome check packages/assets tests/fixtures/assets
```

RED evidence was observed before implementation for media imports, all 37
font/fetch cases, and all 9 initial snapshot/cache cases. Additional observed
RED regressions drove PNG chunk limits, SVG root/geometry restrictions,
cache-root identities, partial-stage receipt recovery, safe title preservation,
elapsed duration, aggregate output and text-bound font coverage. Tests use
real Windows buffer/zlib/pngjs parsing and unique temporary file I/O through
an explicitly test-owned boundary, deterministic adversarial XML/font data,
and fake DNS/transport only. Separate-process smoke tests import built exports.
No macOS, live Figma, device, native network adapter, actual browser font use,
renderer golden, or integrated F03/F04 production execution is claimed here.

The focused F05 review follow-up added 15 unique cases: six preparation
expiry/cancellation/duration cases, four concurrent request/cache-identity
mutations, two fractional SVG viewport rejections, two pre/post-stage metadata
validation cases, and one positive fractional-geometry/integer-viewport case.
Fourteen failures were observed before their corresponding fixes; the positive
geometry case preserves supported behavior. No profile expansion or native
transport was added.
