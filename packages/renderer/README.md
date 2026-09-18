# @design-studio/renderer

F06 Windows-first static DesignIR renderer. It uses the real contracts,
DesignIR kernel, asset inspectors, host boundaries and renderer-host lease.
It does not execute code mappings, application code, models, prototype actions,
Figma/device operations, a web server, a store or a job scheduler.

## Public composition

`renderStaged(request, context, options)` is the primary preparation API.
Its package-local `StagedRender` contains:

| Field | Meaning |
| --- | --- |
| `outcome` | Shared `Outcome<RenderResult>`; complete means prepared, not published |
| `staged` | Exact completed physical `StagedArtifact` receipts |
| `evidence` | Revision/raw-input hashes and role/media associations for actual staged bytes |
| `cleanup` | Public renderer-host cleanup outcome, observed before output staging |
| `recoveryRequired` | Known remaining stages or uncertain effects require authorized recovery |
| `stageFailure` | Original noncomplete stage outcome, including a partial value if supplied |
| `executionFailure` | Primary execution code/message retained if cleanup uncertainty intervenes |

`StagedRendererOptions` requires project/provider/output-root IDs, trusted host
`authority`, F05 `rightsAuthority`, `resolveInputs`, a
`Pick<FileSystemBoundary, "stage">`, and a public
`Pick<RendererWorkerHost, "open">`. Optional `budgetLimits` is trusted finite
configuration, never a design-controlled allowance.

`resolveInputs(request, context)` must authenticate the requested revision's
relationship to its accepted design, then return `AcceptedInputs`:
`revision`, exact `designBytes`, exact `resourceBytes`, and
`{artifact, bytes}[]` for the pinned closure. F03 owns the revision identity
envelope: the renderer does not assume a revision reference hashes design.json.
It verifies returned reference equality, parsed design equality, the raw resource
lock, actual dependency hashes/sizes, F02 resolution and F05 byte/rights checks.
Request validation and a deeply frozen private snapshot precede the first await,
including installed compiler inspection. Later caller mutations cannot change
the admitted mode, revision, design or profile in either renderer entrypoint.
No host paths enter RenderRequest. The normalized/expanded design is derived
evidence, never a replacement accepted original revision.

Every stage is a sequential call to the injected adapter at `blobs/<sha256>`.
The six roles are preview, profile, expanded-input, bounds, diagnostics and
render-evidence. **Tracked F07 work must inject its execution-scoped fenced and
journaled stage adapter**, updating its expected record version before each
successful stage resolves. Do not stage directly on the host and journal later.
Noncomplete staging stops further writes; the original outcome and known
receipts remain available. No renderer path calls publish, discard, a legacy
store commit or commitJob. F07 alone performs its fenced final commit/recovery.

`StaticRenderer(options)` additionally requires `observePreparation` and
`publish`. It implements the standard shared Renderer interface: notify the
ownership observer before publication, require the trusted publisher's actual
atomic/verified CommitReceipt, and check exact output descriptors, project,
actor, request key and job when present. A verified committed receipt wins
cancellation. A failed publisher cannot yield complete. The standalone publisher
is not the tracked F07 path and must not bypass its fencing.

Physical receipt metadata is immutable, including `application/octet-stream`.
`RenderEvidence.artifacts` separately binds the verified PNG/JSON semantic media
type to the physical artifact's hash. Future preview routes must obtain this
association from trusted render/store provenance, not a user path, filename,
claimed MIME or uploaded self-asserted evidence. Hashes alone are not authority.
Stage failure does not grant cleanup under expired/cancelled authorization.

`getCapabilities` is deliberately conservative: configuration is not execution
proof, so it reports an unverified static operation rather than launching a
browser during capability discovery.

## Installed worker and pins

`createWorker(BrowserInstallation, budgetLimits?)` returns the trusted module
contract `render(bytes, {signal})` and `close()`. A fixed, reviewed installed
entry module constructs it with an explicit browser root, executable-relative
path and complete file inventory. Those values never come from a render request.
Configure that entry through `@design-studio/renderer-host`'s public
`RendererWorkerHost`. Do not import fd3, native bindings or private host files.

The tested candidate is Playwright **1.63.0**, Chromium **headless shell**
**153.0.8010.12 / r1243**, Windows x64, Node **24.21.0**. The shell executable
SHA256 is `addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c`.
`docs/browser-windows-x64.json` records the acquired payload hashes.
`installedBuildIdentity()` hashes the installed renderer/kernel runtime-JS
inventories; populate `profile.renderer` with its exact renderer identity.
The expanded-input artifact retains the kernel identity too. Updating compiler
bytes changes the profile hash even if a development version label is unchanged.

The entire installed dependency closure must be trusted and immutable, as
required by renderer-host. These inventory hashes do not authenticate an
untrusted installation or defend against hostile concurrent local writers.
Browser payload files are checked before launch; missing/mismatching bytes fail.
There is no render-time download, PATH discovery, user Chrome/Edge profile,
debugging listener, shell launch, sandbox-disable or breakaway fallback.

Chromium runs with `chromiumSandbox:true`, explicit `--enable-automation` for
command-line attestation, forced sRGB and pipe-only debugging. The host joins its
kill-on-close Job before importing this module. Success, error, cancellation and
deadline all close the owned lease before staging. Real tests cover sandboxed
capture, worker crash with a live browser, cancellation/deadline and observed
worker exit/empty Job. Host cleanup owns its finite post-cancellation allowance.
Uncertain cleanup is interrupted, not a fabricated clean cancellation.

A reusable worker caches a browser only after version, sandbox, transport and
CDP checks finish. Rejected launches are closed; failed cleanup remains owned
and prevents reuse until cleanup succeeds. Context ownership starts immediately
after creation, before routing or page setup, so early setup failures also close
their contexts. Cleanup errors preserve the primary failure and remain retryable
through worker close rather than being treated as successful teardown.

The primary API owns one lease per operation and closes it before staging.
The caller/job scheduler must bound concurrent operations. Calibration separately
exercises serial requests in one public owned lease, with fresh page/context per
request; it does not claim end-to-end cold API or publication latency.

## Supported static semantics

Tokens and visual components resolve through F02 before layout. The core owns
dimensions/allocation/arrangement; Chromium owns real text shaping/wrapping and
rasterization. No flexbox automatic minimum, shrink or viewport stretch defines
IR semantics.

- Fixed/hug/equal-fill rows, columns, declared frames and ordered stacks; explicit
  padding, margins, gaps, alignment/distribution and parent-content absolute
  offsets. Fill shares must satisfy every min/max, not become unequal clamping.
  Intrinsic hug respects min/max; text is never truncated to make it fit.
- Groups are non-layout union footprints, including actual child offsets.
  Only a genuinely empty group has zero natural extent. Unmeasured leaf
  dimensions and unresolved hug/fill dependencies fail rather than choosing zero.
  General coupled constraint solving and responsive layout are not implemented.
- Normal 400 static TrueType faces, explicit typography and half-open UTF-16
  runs. No Unicode normalization, implicit bold/italic or system font fallback.
  F05 checks rights, exact face bytes/tables and text-bound glyph coverage;
  FontFace readiness plus CDP custom-face/glyph use is required for each rendered
  run. Whitespace-only runs have no positive glyph-use claim.
- Solid sRGB paint, simple border/radius/opacity and one basic shadow;
  rectangles/ellipses; F05-supported PNG and restricted sanitized SVG;
  contain/cover/fill/source-pixel crop and separate asset/node affine transforms.
  No ICC conversion, general vectors, complex masks, blur or blend/effect engine.
- Explicit scroll viewport/content/offsets and bounds/rounded clipping. Intentional
  clipping/scroll is not unexpected overflow. Unexpected text/layout/transformed
  overflow fails strict output; inspection retains blocking diagnostics.
  Text measurement includes both leftmost and rightmost Range extents relative
  to the allocated box. Explicit bounds/rounded text clipping retains measured
  excess without making strict rendering fail: node `overflow` remains true,
  render-evidence records extents/allocation/clip intent, and diagnostics disclose
  intentional clipping at informational severity. Unclipped excess remains an
  error and makes inspection partial.

`BoundsMap.localBounds` is the untransformed box in parent-local coordinates,
including parent padding in its placement. `measuredBounds` is the unclipped
screen-space transformed AABB, in design units after capture scroll translation.
Source absolute bounds remain separate. `transform` is local, with explicit
origin; `clipChain` lists ordered clipping ancestor IDs, including self when it
clips content. Paint order follows the expanded tree. Reconstruct clip shapes,
parents and scroll content from the exact staged expanded-input/profile artifacts,
not from AABBs alone. These are browser measurements, not native view geometry.

The PNG and map come from one frozen page, with geometry checked against core
transforms and rechecked after capture. Only en-US/UTC/light, device scales 1/2,
empty demo state and synthetic zero-inset/excluded-system-bar capture are admitted.
Other profile configurations are explicitly unsupported. Source-Figma pixel
equivalence, native accessibility/behavior and actual macOS execution are not
claimed. Exportable/implementation-ready are not promoted; readiness remains
needs-review or blocked, never approval.

Inspection draws a visible, pinned-font "Unsupported" marker for an unsupported
leaf while retaining raw/source evidence and blocking losses. It is not a source
crop or editable subtree. Other unsupported configurations may fail without PNG.

## Offline and transport boundaries

Imported strings are escaped data, never code/HTML/CSS. Compiler-generated styles
use a nonce CSP; scripts, connects, objects, frames, workers, base/form actions
are denied. Only verified in-memory data images/fonts are admitted. Context routes
block external requests/WebSockets; service workers, popups and downloads are
disabled. No file:// path is emitted. This is not an OS firewall or arbitrary-code
sandbox guarantee.

Private DSB1 frames contain bounded canonical metadata and raw resource bytes,
with separately checked logical JSON length. DSR1 compressed envelopes retain
exact bounded inflate and trailing-stream checks. Both wire and logical ceilings
apply; the host additionally counts its 41-byte frame overhead and cumulative
lease I/O. Compression cannot extend deadlines or request budgets.

Image validation metadata is cached only within an owned worker, at most 256
entries, keyed by complete bytes/hash/media/dimensions/profile/budget/F05 identity.
Every request still rehashes bytes and the parent repeats F05/rights validation.
Text measurement caching is page-local under text/typography/ranges/width and
immutable page profile/faces; actual-face proof is never skipped.

## Development and distribution evidence

Build dependencies before typecheck. Normal unit/public-import smoke tests are
offline; real browser suites require explicit setup and flags. An omitted browser
suite is **unverified**, not a passing rendering acceptance.

```text
pnpm build
pnpm typecheck
pnpm exec vitest run --project unit packages/renderer/tests
pnpm exec vitest run --project smoke packages/renderer/tests/package.smoke.test.ts
```

On the approved Windows setup, set `F06_BROWSER_GATE=1` and
`F06_RENDER_SMOKE=1` for the real gate/render/staging/cleanup suites.
`F06_PERFORMANCE=1` selects the separate serial calibration, with `--maxWorkers=1`.
`F06_UPDATE_GOLDENS=1` is only for deliberate reviewed regeneration; all geometric,
resource, pixel and repeat checks still run first. JSON goldens compare canonical
values; PNG bytes compare exactly.
Golden metadata retains its historical compiler digest. Regression comparison
asserts that historical identity and the current installed compiler identity
separately, then compares the remaining profile, geometry and face expectations
unchanged. Historical calibration results are not measurements of revised code.

Developer acquisition used locked `playwright install chromium --only-shell`
with private `.tools/renderer-browser-1.63.0`, after the manifest change and
explicit approval. It also acquired FFmpeg r1011 and Winldd r1007; their identities
remain in the inventory. Preserve full browser/Node/Playwright/dependency notices
and OFL/MIT fixture notices in distribution. No second language, image service,
new native dependency, browser engine or install hook was added. The scoped lock
adds only the renderer importer and exact Playwright package records; existing
integrities retain the trusted mirror's provenance, not invented upstream hashes.
Installer signing, clean-machine/air-gapped packaging and macOS execution are
separate unverified gates.

After explicit acquisition approval and the pinned workspace toolchain restore,
the Windows developer setup is:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PWD '.tools\renderer-browser-1.63.0'
$env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
node packages\renderer\node_modules\playwright\cli.js install chromium --only-shell
$env:F06_BROWSER_GATE = '1'
$env:F06_RENDER_SMOKE = '1'
pnpm exec vitest run --project smoke packages\renderer\tests
```

The real test entry checks the payload against the reviewed, committed
`docs/browser-windows-x64.json`, not a freshly generated trust-on-first-use
inventory. `scripts/browser-inventory.mjs` is a read-only inventory diagnostic;
do not replace approved pins merely to make mismatching bytes pass.

See `docs/acceptance.md` and the full calibration reports for measured evidence
and limitations. The 500-node/10-MiB workload uses real displayed image/font bytes,
not padding, unused files or the tiny five-case examples.
