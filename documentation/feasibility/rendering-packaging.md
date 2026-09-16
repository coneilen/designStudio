# P02: rendering, fidelity and distribution feasibility

**Decision proposal, not an M1 acceptance result.** A single TypeScript/Node service with a pinned Playwright Chromium headless shell is a viable candidate for the bounded static subset. The synthetic Windows probe establishes browser behavior, not a DesignIR renderer, Figma conversion fidelity, editable export, macOS parity or release performance. Keep M1 conditional on permission-cleared source/font fixtures and both-host contracts. Do not introduce a Python runtime, image microservice, second workspace or desktop shell to solve an unmeasured need.

Recorded 2026-09-16 against planning commit `1a723018e27be043ec67085684ea28a1c9ef9d72`. The initial checkout matched it exactly, was clean, and tracked only `documentation\spec\ai_native_design_studio_spec_v4.md`; there were no material differences. This pass interprets sections 7-9, 12-13, 21, 29, 31-34, 47A, 48.1, 49 and 56. It uses the disposable-experiment exception in 47A.10, **not** a production RED/GREEN claim. F00 owns workspace choices. P02 adds no production package, schema or behavior and does not start F01/F06.

## Evidence and limits

| Area | Evidence class | Result and consequence |
| --- | --- | --- |
| Pinned Windows browser | Tested here | Playwright 1.63.0 downloaded and launched headlessly; Chromium headless shell 153.0.8010.12, revision 1243. No foreground app used. |
| TypeScript path | Tested here | Strict TypeScript 7.0.2 compilation and execution on installed Node 22.14.0 succeeded. No runtime replacement. |
| Row/column/fixed/hug/fill | Tested here | Explicit browser CSS and DOM measurements satisfy this fixture's arithmetic; this is not an IR layout algorithm or general CSS-to-Figma equivalence. |
| Styled text | Tested here | UTF-16 ranges, two lines, actual platform-font use and fallback measured. Browser readiness alone falsely appears sufficient for a nonexistent family. |
| Crop/transform | Tested here | Synthetic 200x100 stripe image cropped to 100x100; interior pixels and 90-degree rotation checked. No imported Figma transform was tested. |
| Component variants/slots | Tested here | Fixture-only typed expansion of two instances into eight namespaced DOM elements, with label slots and separate checked/disabled values. No code repository imported. No general dependency resolver. |
| Complex mask/effect | Tested here / unverified | Deliberately labeled placeholder and loss record, not a visual approximation or source-image fallback. Production rejection/export behavior unimplemented. |
| Repeatability | Tested here | Three screenshots of the same page were byte-identical. Not three independent OS/browser installations or a cross-host golden. |
| Image metrics | Tested here | Raw threshold boundary and tiny missing-control case demonstrate why global comparison/pixelmatch defaults are insufficient. No production policy engine or calibrated SSIM result. |
| SQLite | Tested here | Built-in Node 22 SQLite 3.47.2: file-backed WAL, commit, rollback, reopen, integrity check, path with space and U+00E9. No crash/concurrency/backup guarantee. |
| Browser Windows/macOS distribution | Public capability | Upstream support/download mechanisms exist. Exact packaged offline installs, signing, enterprise restrictions and macOS execution unverified. |
| Node 24 runtime | Public capability / unverified | F00 provisionally selected 24.21.0; Playwright package engine permits it. P02 did not execute the renderer or SQLite on that runtime. |
| Native SQLite add-on | Public capability / unverified | Upstream describes prebuilds generally; exact 13.0.3 metadata instead exposes a `node-gyp rebuild` install path. No compiler-free installation proven. |
| Source-to-preview fidelity | Blocked | No authorized Figma source, source screenshot or independently acquired source metrics. No numeric source-to-preview score can be reported. |
| Cross-host font parity | Blocked | No redistribution grant for inspected system fonts and no Mac host run. A same-family name is not a same-font identity. |
| 500-node/10-MiB performance | Unverified | Procedure below, not measured in this pass. Actual visual fixture has 30 identified DOM elements, not 500 expanded IR nodes. |

### Exact tested profile

Windows 11 Enterprise, OS release `10.0.26200`, x64; Intel Core i9-10900K @ 3.70 GHz, 20 logical CPUs, 68,479,582,208 bytes physical RAM (approximately 63.78 GiB). Node `22.14.0`, native module ABI `127`, ICU `76.1`, npm `11.16.0`; pnpm was absent. Disposable harness used Playwright and playwright-core `1.63.0`, TypeScript `7.0.2`, `@types/node` `22.13.10`, pngjs `7.0.0`, pixelmatch `7.2.0`. An initial TS 5.9.3 run was superseded by the successful TS 7 run; adding `DOM.Iterable` fixed a harness-only compile error. An initial hand-entered text end offset of 42 was corrected to the measured length 41 before final assertions.

Capture: 393x852 CSS viewport, device scale factor 1, en-US, UTC, light theme, reduced motion, zero scroll, white background, fixed `Date` time `2026-09-16T00:00:00Z`, forced sRGB browser flag. Animations/transitions/caret disabled; await `document.fonts.ready` and all image `decode()` promises; deny routed external resources; browser launch timeout 30 seconds, page operations 15 seconds. The images are original inline static SVG stripes, not remotely retrieved resources. This is a controlled fixture, not an untrusted-input sandbox or SVG sanitizer test. The probe captures bounds/transforms, not a complete clip/source-bounds map.

All 11 exploratory render assertions passed. Three 15,375-byte PNG captures had SHA-256 `eccf299430f12cbf45aa976f8b331b3bb9ae969cad44dbe3c49440b65784b1cc`. PNG bytes remain scratch evidence, not approved golden files. An intermediate fresh-process browser launch took 163.06 ms; earlier first launch took 2,388.26 ms; the final replay records its own duration in `measurements.json`. These are isolated process-launch observations with uncontrolled OS cache state, **not** warm-render times, p95 or performance acceptance.

F00's relayed provisional pins were Node 24.21.0, pnpm 12.4.0, TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12 and `@types/node` 24.13.4. P02 aligned TypeScript once, but did not acquire another Node runtime or validate that whole combination. F00 execution evidence and later renderer contracts must close that gap.

## Geometry, text and candidate M1 subset

| Case | Measurement | What this actually establishes |
| --- | --- | --- |
| Settings row | Bounds `(16,16,361,56)`; parent screen padding 16; row padding 8 and gaps 12 | Bounded column/row construction; fixed icon 24x24 at `(24,32)`. |
| Hug/fill row | `On` width 21.34375; fill width 275.65625 | Remaining row content space allocated after fixed content, intrinsic label and gaps. Explicit `flex: none` for fixed/hug; `flex: 1 1 0; min-width: 0` for fill. |
| Two fills | Both 174.5 wide, gap 12 inside width 361 | Equal bounded fill, including subpixel layout. Integer `clientWidth` rounds to 175; use floating-point bounds, not integer DOM properties, for geometry. |
| Mixed text | 240x48 text box at `(16,120)`; two 24-unit lines; text Range rectangles 17 units high | Line boxes, glyph-run rectangles and ink bounds are different things. These are browser Range rectangles, not Figma source baselines or glyph ink metrics. |
| Crop | Source 200x100; centered cover visible source x=50..150; output 100x100 at `(16,180)` | Interior left/right samples are green/blue. No general affine-transform importer, EXIF, ICC, WebP/JPEG or arbitrary SVG support proved. |
| Rotation | Second crop at `(132,180)`, matrix `matrix(0, 1, -1, 0, 0, 0)`, origin `50px 50px` | After clockwise 90-degree rotation interior top/bottom samples are green/blue. Axis-aligned bounds alone would conceal this rotation. |
| Components | Each row 361x48; checked thumb offset 18, unchecked offset 2; disabled row opacity 0.5 | Version-1 fixture label slots and visual variants expand without code mappings. This does not establish interaction, accessibility or Figma-library property compatibility. |
| Overflow | 100-unit box has `scrollWidth` 259 | Browser will happily overflow; renderer must surface it, not silently call this a valid layout. |
| Absolute placement | Parent `(16,540)` with padding 8; child `(34,553)` | IR content offset `(10,5)` requires CSS offsets `(18,13)` here. CSS absolute-position containing-block semantics cannot be copied directly into IR defaults. |

The literal text in `cases.json` has **41 UTF-16 code units, 40 Unicode code points, 39 grapheme clusters**. Ranges are zero-based, half-open: regular `[0,5)`, emoji `[5,7)`, bold `[7,11)`, regular `[11,41)`. Offset 6 splits the surrogate pair and must be rejected; offset 13 splits the `e` + combining acute grapheme, which requires an explicit adapter/editor policy rather than pretending UTF-16 offsets are grapheme indices. Do not normalize Unicode content implicitly: that changes both ranges and hashes. The tail wraps into two Range rectangles, of widths 134.296875 and 71.109375.

**Provisional candidate profile:** fixed-viewport frames/rows/columns and ordered stacks; bounded fixed/hug/equal-fill sizing; explicit padding/gaps/alignment and absolute content coordinates; measured overflow; available identified fonts with explicit line height, wrapping/alignment and UTF-16 styled ranges; solid fills/simple borders/radii/opacity; local decoded raster assets with declared fit/crop/transform; versioned visual variants/slots and pinned token resolution. Browser feasibility supports testing this scope, not immediately declaring every combination supported. Basic shadows, nontrivial clipping/stack interactions, recorded scroll capture, sanitized vector paths and other unexercised combinations still need their own fixtures. Responsive rules, RTL/large text, percent sizing and general constraint solving are not implied.

Before support is promoted, tests must drive token type/mode/alias-cycle handling; component defaults/typed properties/slots, unique instance-namespaced IDs and acyclic closure; missing definitions versus snapshot-only instances; depth/expanded-node limits; `hug` around unbounded `fill`, impossible min/max and negative sizes. CSS's automatic minimums, shrink and overflow behavior must not define the IR accidentally.

The deliberate unsupported case records `mask` and `backdropBlur` as unsupported with affected preview/editable-export operations and recovery guidance. Its outline is an **inspection placeholder**, not an approximated mask and not an opaque source crop. There are no invented editable children or genuine raw-source bytes. Future imports must preserve their actual raw source/bounds; strict editable export must block unsupported subtrees unless a permitted decorative fallback is explicitly approved. Text/controls/screens cannot be flattened to pass acceptance.

## Fonts: identity is not permission

Only four known files in `%WINDIR%\Fonts` were read for identity; no broad font/home scan, copying, conversion or redistribution occurred. Full SHA-256 values, sizes and name-table versions are in `fixtures\rendering\host-evidence.json`.

| Installed file | Identity/version | Actual use and rights status |
| --- | --- | --- |
| `arial.ttf` | Arial Regular / ArialMT, 7.06 | Regular Latin and combining text; installation-local rendering only. |
| `arialbd.ttf` | Arial Bold / Arial-BoldMT, 7.06 | Bold run actually selected, not merely requested weight. |
| `seguiemj.ttf` | Segoe UI Emoji / SegoeUIEmoji, 1.70 | Actual emoji fallback selected by Chromium; platform-specific color glyph behavior. |
| `segoeui.ttf` | Segoe UI Regular / SegoeUI, 5.71 | Inspected as a known Windows UI family; not used by this rendered fixture. |

Chromium CDP `CSS.getPlatformFontsForNode` returned the above actual PostScript families and glyph counts. This, combined with inspected installed files, is stronger evidence than a CSS family string, though CDP does not itself return the underlying file hash. Both `document.fonts.check('16px Arial')` **and the deliberately nonexistent family check returned true**. The missing-family node actually used Arial. Font readiness is necessary, not an availability/identity validator; verify all requested faces/weights and actual fallback coverage, including per-glyph fallback.

All four inspected `OS/2.fsType` values were 8 (editable document embedding flag). **That is not a grant to bundle fonts with an application or web server.** Microsoft's FAQ distinguishes installation-local use and rasterized text graphics from app/web-font redistribution; do not package these bytes or move them to macOS. Segoe UI Variable has additional non-Windows restrictions. Apple's downloadable San Francisco license is purpose-limited and not a cross-platform/Android app-font grant; it was not downloaded or used here.

At G0 choose either a permission-cleared, byte-pinned cross-host font fixture with its actual license/notice and weight/glyph coverage, or explicit installation-local profiles. An OFL font could be evaluated later, but none was acquired or granted by this pass. Font substitution remains a visible approximation and invalidates strict text-fidelity comparisons. Store family, PostScript name, style/weight, version/hash, license provenance, allowed use/embedding/distribution, availability and actual fallback faces separately. Missing rights must block a font-bearing offline bundle, not be bypassed by converting or extracting fonts.

## Small dependency and packaging recommendation

| Need | Smallest candidate | Constraint |
| --- | --- | --- |
| Core/build/tests | F00's one Node LTS/pnpm/TypeScript workspace and Vitest | No competing production npm lockfile. JSON Schema remains the public source; choose at most one validator when contracts need it. React waits for UI work. |
| Rendering | `playwright` 1.63.0 and its matching Chromium shell 153.0.8010.12/r1243 | One engine, not Electron plus another Chromium. Use Playwright API with the chosen browser profile explicitly recorded. |
| SQLite | Built-in `node:sqlite`, conditional on accepting Node 24.21.0 API stability and validating its behavior | Zero npm database dependency, but no stability/packaging waiver by implication. See alternatives below. |
| Initial PNG comparison | `pngjs` 7.0.0 plus a small contract-tested typed-array channel predicate | PNG decode is not an ICC-aware color pipeline or broad image ingest. |
| Structural diagnostic | Evaluate `ssim.js` 3.5.0 (MIT) when comparator contracts begin | Public capability only, not installed/run here. Pin algorithm/window/downsampling options; SSIM is diagnostic, not the verdict. |
| Not needed by default | pixelmatch, Sharp/libvips, OpenCV, Python, separate worker service, ORM | pixelmatch 7.2.0 was only a counterexample probe; Sharp may be justified later by measured decoding/resizing/color needs. Do not retain duplicate metric engines without a concrete use. |

Upstream current Playwright support documentation lists **latest Node 22.x/24.x/26.x, Windows 11+/Server 2019+, macOS 14+**. Package `engines >=20` is weaker than that supported-host matrix: local old Node 22.14.0 executing successfully does not establish vendor-supported patch status. Proposed Node 24.21.0 must be rechecked at F00/G0. Do not infer Windows 10 or older macOS support, and validate intended Windows x64/macOS arm64 and x64 architectures separately.

The probe used `playwright install chromium --only-shell` with a session-local `PLAYWRIGHT_BROWSERS_PATH` and browser garbage collection disabled. It downloaded 114.6 MiB shell, plus FFmpeg revision 1011 (1.3 MiB) and Winldd revision 1007 (0.1 MiB). The isolated browser tree occupied **286,993,462 bytes** after extraction; this is not a compressed installer size or a Mac estimate. Exact Windows shell executable SHA-256: `addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c`.

Canonical candidate is **headless shell** (default launch, no channel), not interchangeable with branded Chrome/Edge or Playwright's `channel: 'chromium'` new-headless profile. The latter needs a different install selection and its own goldens. Never silently fall back to auto-updating installed browsers. Firefox, WebKit and system browser downloads are unnecessary for this profile.

For developer/online setup, install the locked browser into an application-managed versioned cache and report availability through the future doctor command. For offline ordinary-user distribution, assemble separate OS/architecture artifacts containing compiled JS, the approved Node runtime, exact browser payload and required package resources; preserve executable permissions and relative paths on macOS. Avoid runtime `npx latest` downloads. Browser binaries cannot simply be hidden inside a JS single executable without extraction/resource management. Verify manifests/hashes and fail actionably for missing/incompatible payloads; use argument-array process launching and cross-platform path APIs.

Node/Playwright source licenses do not cover every browser dependency. Playwright/TypeScript are Apache-2.0, pngjs MIT, pixelmatch ISC; the downloaded shell includes a 2,300,816-byte `LICENSE.headless_shell` third-party notice file. Preserve relevant full notices and audit the selected Node/browser/FFmpeg payload and font/asset rights before redistribution. Windows installer signing/reputation, macOS signing/notarization/quarantine, enterprise endpoint policies, air-gapped install, clean-machine execution and browser shutdown/cancellation are **unverified packaging gates**, not reasons to add another stack now. Do not disable OS trust barriers to make a probe pass.

### SQLite choice and native risks

The final disposable file-backed test used Node 22.14.0's SQLite 3.47.2, WAL, explicit transactions and a reopen/integrity check; Node emitted its experimental warning. Node **24.21.0 documentation labels the module Stability 1.2 (Release candidate)**. Its API/version is tied to the runtime; options documented in 24 must not be assumed present in 22. Prefer this smallest route only if G0 explicitly accepts that stability level and storage contracts run on the exact chosen runtime on both hosts.

`better-sqlite3` 13.0.3 is the evaluated native alternative, not installed. npm reports Node `>=22`, dependency `node-addon-api ^8.0.0` and install script `node-gyp rebuild`; the latest v13.0.3 GitHub release query returned no assets. The README's generic prebuilt availability is not exact-version installation evidence. Its declared Node-API helper suggests a different compatibility strategy than older Node/V8-ABI-specific addons, but metadata alone does not prove the binding's N-API level or portability. Check the actual release before choosing: OS, architecture, Node/N-API or module ABI, C/C++ runtime, signed binaries, complete optional dependencies, and offline loading. A source-build fallback brings Python plus platform C++ tools (Windows build tools/macOS Xcode CLI) into setup, conflicting with ordinary-user no-extra-toolchain goals unless maintainers ship validated artifacts.

`sql.js` avoids a native Node add-on but uses an in-memory filesystem and explicit import/export of database bytes; its default model is not durable on-disk WAL storage. Adding custom persistence to imitate section 32 is a larger risk, not a free portability fix. Do not ship two database implementations as speculative fallbacks.

Regardless of driver: one local service owns writes; bound synchronous query work and queue expensive jobs without blocking CLI/API indefinitely; disable extension loading; transactions/migrations/busy deadlines and local-filesystem assumptions need contracts. Database commit plus blob staging/hash/atomic same-filesystem move, crash recovery, backup/restore and deletion retention are separate from this SQLite smoke test. No ORM or extra service is needed to state those obligations.

## Image-metric evidence and contracts

The section 29.5 predicate is **maximum absolute sRGB channel difference strictly greater than 16/255**, not pixelmatch's YIQ/perceptual threshold. With opaque single red-channel deltas 15, 16 and 17, the scratch raw predicate counted `0,0,1`; pixelmatch 7.2.0 at `threshold: 16/255, includeAA: true` counted `0,0,0`. Anti-alias heuristics are not the only difference.

Hiding the synthetic 36x20 checked toggle changed 642 of 334,836 screen pixels (**0.1917357% globally**) but 642 of its fixed 720-pixel critical region (**89.1667% regionally**). Global-only 1% gating misses this defect. Pixelmatch counted 635 for the same pair; that is a different metric, not a reference truth. Region geometry here is trusted DOM fixture geometry, not native-app geometry extracted from screenshots.

Before a production comparator, RED/GREEN contracts must cover channel boundaries 15/16/17, exactly/just-above 1% global and 0.5% critical thresholds, geometry exactly/above 2 logical units when independently measured, transparent RGB, alpha compositing onto the approved background, recorded sRGB/color-profile handling, resampling/density, dimensions and unknown/mismatched profiles. Region denominators must be **their own unmasked pixel counts**; missing required regions and zero eligible pixels are inconclusive, not zero-difference passes. Masks require reviewed reference-space bounds and coverage limits and cannot hide controls.

The probe accepted only opaque screenshot pixels and forced the browser's sRGB profile. It did not implement alpha normalization, ICC conversion, resize policy, masks or SSIM. pngjs decoding alone must not be advertised as satisfying those contracts. Start with PNG/sRGB-only comparisons; reject/mark unsupported color evidence rather than silently broadening support. Retain raw reference/actual bytes and produce derived overlay/difference artifacts. Later evaluate broader input support or native color tooling only if a measured fixture requires it.

Add all section 29.6 negatives before strict gating: moved region, missing small control, wrong label, wrong theme, wrong screen/state, invalid density/viewport and missing fonts. Pin SSIM's exact implementation/options and report it globally/per region as diagnostic only. App interaction/accessibility/component reuse remain unmeasured by pixel comparison.

## Runnable follow-up and performance procedure

Curated persistent input/evidence is under `fixtures\rendering`: `synthetic.html`, `cases.json`, `measurements.json`, `metrics.json`, `host-evidence.json`, and `provenance.json`. Fixture-local `.gitattributes` fixes JSON/HTML to LF so exact byte hashes survive Windows/macOS checkouts without modifying root configuration. They are synthetic capability material, **not DesignIR contracts, imported resources or approved goldens**. Dependency lock, TypeScript harness, temporary database and PNGs remain in this session's artifacts:

```text
C:\Users\coneilen\.copilot\session-state\b0399124-6e01-4a7d-b7eb-93845312342c\files\p02-rendering
```

The scoped manifest was created before installation; npm was used only in that disposable directory. Probe/replay commands, from that directory (set `P02_FIXTURES` to the curated fixture directory):

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'browsers'
$env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
npm ci --ignore-scripts --no-audit --no-fund
node node_modules\playwright\cli.js install chromium --only-shell
npm run build
npm run probe
npm run metrics
node host-probe.mjs
```

The initial acquisition used `npm install` to create the artifact-only lock; `npm ci` is the proposed locked replay command, not an additional installation run claimed here. The lock resolves through the environment's configured public-package mirror; replay needs access to that mirror or an explicitly reviewed lock regeneration against an approved registry. Build/probe/metrics and host probe actually ran; no production tests were claimed. `probe.ts` builds two fixture expansions with escaped `textContent`, waits for resources, queries bounds and CDP fonts, captures three images, and then seeds the missing toggle. `metrics.mjs` checks four crop pixels, threshold boundaries and region coverage. `host-probe.mjs` is deliberately Windows-specific for its four known installed-font paths.

**Real Mac/selected-runtime replay:** transfer only the disposable source scripts, `tsconfig.json`, manifest/lock and curated fixtures to approved scratch storage, not `node_modules`, browsers, system fonts or Windows baselines. With approved F00 Node/pnpm provisioned, use equivalent argument-array invocations of the same locked build/probe/metrics commands and an OS-local `PLAYWRIGHT_BROWSERS_PATH`; install that host's locked shell. Shell wrappers are not required by the probe code. Run `probe.ts`/`metrics.mjs` first; do not run the Windows font-path script unchanged. Record actual local fonts via CDP, and inspect only approved known Mac font identifiers separately. Obtain a permission-cleared common font before strict text parity; otherwise classify different fallback results as degraded/inconclusive. Re-run the SQLite transaction sequence on the chosen runtime with a local path containing spaces and non-ASCII characters.

Compare semantic text, ranges, expanded IDs, variants, dimensions, crop samples, resource failures and diagnostics. For same-font fixtures propose <=0.1 logical-unit layout comparison for explicit nontext geometry, record text wrapping/run metrics separately, and calibrate final tolerances rather than deriving them from Windows pixels. Require independent per-host approved goldens, not byte-identical Windows/Mac screenshots. Run on actual supported Windows/macOS architectures and packaged clean hosts with network disabled, cancellation, missing-browser/font and path tests. No such macOS/packaged-host result is asserted here.

For section 48.1 calibration, not a P02 release gate:

1. Publish one audited fixture manifest with **500 expanded IR nodes** (count after component expansion), a representative text/image/layout mix and exactly **10,485,760 immutable asset bytes**. Specify whether the 10-MiB profile refers to assets; do not confuse JSON/base64/decoded bytes or pad an unused file to reach the target. Record image dimensions, decoded pixel count, fonts/licenses, hashes, depth, viewport, scroll/theme/state and the generator/version. It must actually exercise the assets. Stay below 25-MiB imported-file, 64-megapixel decoded-raster, 20,000-expanded-node, depth-128 and 250-MiB snapshot limits; reject over-budget input before decode/expansion/browser launch.
2. On one documented reference host per OS/architecture, record CPU/RAM/OS, power/load conditions, exact runtime/browser/fonts/compiler/profile and artifact storage. No parallel benchmarks. Start a new browser and record startup separately; distinguish fresh process from genuinely cold filesystem cache.
3. Prime the pinned caches with three unmeasured executions. Run **20 serial warm renders**, using a fresh page/context per render in the same browser. Time the agreed render boundary from accepted in-memory job through resolution, asset/font readiness, layout, PNG encoding and node bounds/clip/transform-map serialization. Include resource reads/decodes actually performed; record artifact publication I/O separately unless the final contract includes it. Save all 20 timings, output sizes/hashes and errors, not only the fastest run.
4. Separately run **20 cached handoff compilations** from the same accepted snapshot/dependency bytes, excluding browser startup and external API/model/device time. Declare the cache state and whether hashing/publication are in the boundary; no production compiler exists in P02, so this cannot yet be executed meaningfully.
5. Report median, max and nearest-rank p95 (19th sorted value of 20), cold startup and phase times. Sample memory/CPU for the service **and its identified browser children**; capture peak working set/RSS and concurrency. Failed/time-out runs are failures, never discarded samples. Compare the <=2-second warm render and <=1-second cached compilation targets only after calibrated fixtures/boundaries and both-host baselines exist. Twenty samples give coarse tails; this is initial calibration, not a broad scalability claim.

## G0 decisions and F01 constraints

G0 should approve only a **provisional, evidence-labeled profile** and the next acceptance-contract scope. Open blockers are authorized Figma/reference acquisition, font use/redistribution policy, actual macOS/selected-Node rendering, exact driver stability/distribution choice and clean packaged-host checks. No source-fidelity number, macOS golden or full performance result exists to waive them.

F01 should contract separate schema validity, resource resolution, renderability, export capability and implementation readiness; property-addressed provenance/loss levels; complete pinned visual/font/asset/token closure; stable identity and component namespacing; transform-aware local/source/measured bounds plus clipping; typed layout/font failures; bounded resource/deadline/cancellation handling; and render metadata from the **same capture** as PNG/map. Imported strings remain data, not HTML/CSS/JS or live repository code. Unsupported/approximated evidence must never silently acquire `exact` authority.

Convert these exploratory expectations into failing tests before renderer/storage/comparator production work. Unchanged imported designs compare against their pinned independent source image; generated/edited designs require explicit approval of a new reference. The synthetic browser input and its own screenshot cannot validate an importer. Stop at G0; this report does not authorize F01, F06 or later cards.

## Public capability sources

Consulted 2026-09-16; live pages can change and are not host execution evidence.

| Source | Relevance |
| --- | --- |
| [Playwright browser management](https://playwright.dev/docs/browsers), [system requirements](https://playwright.dev/docs/intro#system-requirements) | Version-specific browser payloads, headless-shell/new-headless distinction, isolated/offline installation and current host support. |
| [Node releases](https://nodejs.org/en/about/previous-releases), [Node 24.21.0 SQLite API](https://nodejs.org/download/release/v24.21.0/docs/api/sqlite.html) | LTS/runtime choice; release-candidate SQLite and synchronous API. |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [v13.0.3 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3), npm exact-version metadata | Native packaging alternative; distinguish general prebuilt claims from inspected release metadata. |
| [sql.js](https://github.com/sql-js/sql.js), [SQLite copyright](https://www.sqlite.org/copyright.html) | In-memory WASM/default persistence limits and SQLite public-domain status. |
| [Microsoft font redistribution FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq), [Apple fonts/license](https://developer.apple.com/fonts/) | Installed-font use, embedding versus redistribution and platform/purpose restrictions; not a project-specific permission grant. |
| [pixelmatch](https://github.com/mapbox/pixelmatch), [SSIM.js](https://github.com/obartra/ssim) | Perceptual versus raw-channel differences; optional pinned structural diagnostic. |
