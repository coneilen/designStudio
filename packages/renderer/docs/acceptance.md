# F06 acceptance evidence

Implementation began only after a clean fast-forward from
4587daf754dfa325efad2d51e6645ca5f7bfc564 to coordinator prerequisite
f16c6cce5b7a94dd8f5b760ed6815f030be568ea.
No sibling source/types, root settings, shared schemas or foundation fixtures
were copied or changed.

## Observed RED/GREEN

| Behavior | Observed RED | GREEN evidence |
| --- | --- | --- |
| Owned sandbox browser | Missing gate implementation; then command-line CDP proof rejected absent enable-automation | Explicit automation flag, sandbox retained, pipe/no-port, real PNG and observed Job cleanup |
| Layout/geometry | Missing modules | Fixed/hug/equal-fill, padding/absolute offsets, constraints, groups, matrices and overflow cases |
| Cross-axis stretch | Hug child remained 8 rather than 100 | Explicit stretch preserves fixed children |
| Bounded hug | Valid intrinsic minimum rejected | Min/max intrinsic sizing without truncating children |
| Unknown intrinsic leaf height | Unmeasured shape silently became height zero | Explicit invalid-layout failure |
| Transformed overflow | Translated shape outside parent returned success | Transform-aware strict rejection; intentional clip remains valid |
| Capture offset | Requested offset 12 still measured y=0 | Same-page DOM/core/map translation measures y=-12 |
| Accepted resources | Missing preparation module | Five real resource closures, exact raw locks, rights/face/media/hash negatives |
| Actual capture | Missing worker entry | Five fresh-page captures and repeats through the public owned lease |
| Staging/provider | Missing renderer module | Six real host stages, immutable physical MIME, reference hashes and interrupted-prefix preservation |
| Face evidence boundary | Recorded worker without face evidence published complete | Coverage and exact pinned face association checked before any stage |
| Malformed output | Invalid UTF-8/PNG escaped as raw exceptions | Typed failed outcome after cleanup |
| Publication | Recorded successful/forged/cancel-race arrangements | Required observer/publisher, exact receipt association, commit wins cancellation |
| Wire format | Missing transport module; DSR1 instead of binary resource framing | Exact bounded DSR1/DSB1 round trips, malformed/trailing/oversized inputs |
| Installed build identity | Missing identity helper | Actual installed renderer/kernel JS inventory digests, not version-only claims |
| Calibration | Missing exact fixture; actual p95 target misses | Audited 500 expanded nodes and exactly 10,485,760 exercised image/font bytes; all measured runs retained |

Additional real acceptance checks cover native browser worker crash, request
cancellation/deadline, late-call rejection, spaces/non-ASCII temp paths,
scroll/rounded clip, escaped malicious markup, per-run actual custom faces and
same-render map/PNG correspondence. Existing F01/F02/F04/F05 tests remain the
authoritative lower-layer negative suites, not copied renderer implementations.

The five PNG goldens were inspected after geometry/pixel/face assertions:
settings labels and independent checked/disabled appearance; the three normal
styled-text runs; green/blue center crop and 90-degree rotation; off/on/disabled
variants plus the 8x8 badge; and the clearly marked unsupported inspection leaf.
They are original synthetic Windows browser results, not P02 probes, source
screenshots, contract-example placeholders or approved implementation references.

## Toolchain and acquisition

The session initially had only system Node22.14.0 and no pnpm. The missing-tool
failure was followed by local official Node24.21.0 extraction, verified against
the official SHA256 list: archive
158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541.
pnpm11.26.0 was cached locally; no global runtime/configuration changed.

Dependencies restored with scripts disabled. The single approved private shell
acquisition was Playwright1.63.0 / Chromium153.0.8010.12 r1243; actual executable
hash matched the candidate pin. Full local payload inventory is retained.
LICENSE.headless_shell is 2,300,816 bytes, SHA256
477eecded4058f14bee802ac3a97b439e89ca2a8b4e8aed2ce70485d84c9b5b5.
The inventory is local measured integrity evidence, not an upstream signature
or completed redistribution/signing audit.

## Calibration boundary and retained misses

The benchmark is explicit opt-in and serial: one owned browser, fresh context/page
per render, three warmups then 20 measured renders. It includes accepted-input
resolution, actual F05 checks, encoding, browser readiness/layout/face proof,
PNG/map return and output verification. Worker/browser cold startup is separate;
staging/publication and handoff compilation are outside this measured boundary.
The primary staged API closes its own lease per operation; these numbers are not
a claim about cold end-to-end standard Renderer.render latency.

The fixture contains two original fully displayed minimal PNGs and the pinned
46,016-byte ABeeZee face. Pixel scanlines account for the PNG sizes; there are no
padding chunks or unused files. Notices and JSON/provenance/IPC bytes are
separately excluded from the explicitly defined image/font 10-MiB profile.
All 500 nodes contribute actual image/text/shape layout/paint.

Initial p95 was **3287.1 ms**. The first optimization measured **2317.9 ms**;
the next measured **2078.6 ms**, then **2078.2 ms**. The final allocation-only
iteration passed at **1740.6 ms p95**, with **1745.4 ms maximum**. All samples, failures and identical-output checks
remain in the corresponding reports. Improvements target measured costs:
page-local complete text metric identity, bounded parallel per-run CDP queries,
one DOM run lookup, exact raw resource framing instead of large base64 deflation,
bounded identity-complete image-validation metadata reuse, and logical byte
counting without materializing a second large JSON body. No required face,
geometry, rights, byte or limit checks were removed.
The final allocation change uses F05 `verifyBytes` on already-owned dependency
buffers rather than making another discarded defensive copy; both exact SHA256
and byte-length checks remain.

The latest `performance-windows.json` records the final run's actual profile,
host, all samples, nearest-rank p95 (19th sorted of 20), cache/boundary and target
status. Earlier reports are preserved, not overwritten by a favorable sample.
This is coarse initial calibration on a shared development Windows host with
uncontrolled external load, not a release-wide guarantee.
Startup measurements are fresh-process startup with uncontrolled OS file caches,
not a filesystem-cache flush or physical cold-start guarantee. Median aggregates
use the average of the two middle samples; an initial upper-median calculation
was corrected from the retained samples without changing any timings or p95.

Live memory samples used only the service, worker and Chromium process IDs
reported by the controlled renderer/CDP. Process peaks are observed working-set
values, not an enforced RSS quota or exhaustive profiling. No user process was
selected by name or changed.

macOS execution, independent Figma pixel equivalence, native accessibility,
clean packaged-host behavior, and cached handoff compilation remain unverified
or outside F06. No models, user apps/devices, Figma state, secrets, push, PR or
main merge were involved.

## Final verification

Dependency-ordered workspace build and strict root typecheck passed. The complete
workspace unit/offline smoke run passed **482 tests**, with nine explicit skips
(unsupported-host or opt-in browser/calibration cases). The explicit renderer
Windows run passed **40 cases**, including sandbox/worker-crash/cancel/deadline,
F05-sanitized SVG/basic shadow/rounded-clip pixels, real staging and all five
goldens. The separate 20-sample calibration target passed on its final iteration.
Shared contract generation and all 26 foundation fixture outputs remained clean.

The first root regression run exposed a missing local SQLite prebuild, not a
renderer failure. Only the already-acquired coordinator-worktree binary was
copied into the ignored local tools directory after matching F03's committed
SHA256 provenance; no second acquisition or source-build fallback occurred.
One empty temporary directory from the initial missing-worker RED was identified
by its creation time and removed non-recursively. Subsequent tests clean their
owned roots, including paths with spaces and a non-ASCII character.
