# P03: Device capture and controlled sample feasibility

Evidence date: 2026-09-16. Scope: the approved first-wave P03 feasibility pass, stopping at G0.

## Decision summary

**Windows tool and synthetic byte readiness are demonstrated; live Android capture is blocked by missing authorization and sample inputs. No macOS execution evidence exists.** This report does not satisfy the real Android binary-capture evidence in specification Section 49 or either complete M1 acceptance path in Section 51. Missing Mac access remains a cross-host release-evidence blocker, not permission to provision remote access.

The significant host finding is conflicting adb resolution: bare `adb` resolves to scrcpy's Platform Tools **35.0.0**, while the configured Android SDK contains **37.0.0**. Both print versions successfully. A future provider must pin an explicit executable and obtain the adb server owner's compatibility/usage approval before issuing even device-list commands. Choosing the newer client and allowing it to restart a shared server is not an acceptable preflight.

The smallest proposed sample is one offline Android settings screen in an owner-approved sample repository, with a debug-only explicit route and a nonce-bound app readiness receipt. The sample, its package, profile, reference, and readiness transport remain proposals, not approved or implemented capabilities. No production adapters, shared schemas, sample code, root configuration, C01/C02/C05 work, or additional agents were created.

## Baseline and evidence boundaries

The actual worktree began clean at `1a723018e27be043ec67085684ea28a1c9ef9d72`, exactly the coordinator's planning baseline. `git diff --stat 1a723018e27be043ec67085684ea28a1c9ef9d72 HEAD` was empty. There were no material repository differences to reconcile. The checkout contained documentation, not an executable application or sample build. P03/G0 are coordinator planning labels; this document does not add them to the specification.

The governing document is `documentation\spec\ai_native_design_studio_spec_v4.md`, especially Sections 6B.10, 27-29, 33A, 37.2, 47A.6-7, 48.1, 49-51, and 58. Its requirements remain unchanged: approval binds the reference/scenario, actual implementation builds are recorded per run, readiness requires expected state, image normalization requires measured metadata, and real integrations need real evidence beyond fakes.

Evidence labels used below:

| Label | Meaning |
| --- | --- |
| **Tested** | A named local command or synthetic assertion was actually executed on this Windows host. |
| **Public-doc** | Current public platform documentation supports the stated prerequisite/operation; it was not demonstrated locally. |
| **Unverified** | A possible capability or local prerequisite was not exercised or established. |
| **Blocked** | Missing permission, inputs, or host access prevents the required real acceptance evidence. |

No device was listed, selected, accessed, captured, launched, installed, reset, or reconfigured. No adb server status, start, restart, kill, connect, pair, or forwarding operation was issued. No AVD inventory, personal app inventory, device logs, home-directory search, unrelated repository search, credentials, or private screenshots were read. Only PATH command resolution, named environment variables, explicit executable paths, and bounded configured-SDK package metadata were inspected. Public documentation reads did not upload local content. No software was installed and no global configuration was changed.

## Actual Windows host and tooling

The OS strings below are runtime/kernel observations, not an inferred Windows marketing edition. `%LOCALAPPDATA%` abbreviates the current user's known local application-data directory; only the two specified SDK executable paths there were probed.

| Item | Observed evidence | Classification and limit |
| --- | --- | --- |
| Host | `Microsoft Windows 10.0.26200`, `X64`; Node reports `win32`, `x64` | **Tested** on this host only; no cross-host claim. |
| PowerShell | `7.6.6`, Core, `Win32NT` | **Tested** via `$PSVersionTable`. |
| Node | `C:\Program Files\nodejs\node.exe`, `v22.14.0` | **Tested** version, child-process binary handling, and argument passing. |
| npm | `C:\Program Files\nodejs\npm.cmd`, `11.16.0`; PATH also resolves `npm.ps1` | **Tested** version only; no install or repository build. |
| PATH adb | `C:\ProgramData\chocolatey\bin\adb.exe`; reports installed executable `C:\ProgramData\chocolatey\lib\scrcpy\tools\adb.exe` | **Tested** `version` and `help`: adb protocol `1.0.41`, build `35.0.0-11411520`. |
| Configured SDK adb | `C:\android-sdk\platform-tools\adb.exe` | **Tested** `version`: protocol `1.0.41`, build `37.0.0-14910828`. |
| Alternate explicit adb path | `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` | **Tested** `version`: `37.0.0-14910828`. No inference about whether the two SDK locations share underlying storage. |
| Configured SDK emulator | `C:\android-sdk\emulator\emulator.exe` | **Tested** `-version`: `36.5.11.0`, build `15261927`, graphics backend announcement `gfxstream`. No emulator boot. |
| Alternate explicit emulator path | `%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe` | **Tested** `-version`: same `36.5.11.0` build. |
| Acceleration | Configured emulator `-accel-check`: `accel: 0`, `WHPX(10.0.26200) is installed and usable.` | **Tested** read-only acceleration check; not proof that an AVD boots, renders correctly, or is available for this project. |
| SDK environment | `ANDROID_HOME=c:\android-sdk`; `ANDROID_SDK_ROOT` and `ANDROID_AVD_HOME` unset | **Tested** named variables only; no PATH/environment changes. |
| Emulator / SDK manager PATH | Neither `emulator` nor `sdkmanager` resolved on PATH | **Tested** absence from PATH, not absence from disk. |
| SDK manager files | `C:\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat` and `C:\android-sdk\tools\bin\sdkmanager.bat` exist; `latest\source.properties` reports command-line tools `20.0` | **Tested** file/metadata presence. SDK manager execution, downloads, and license acceptance were not attempted. |
| Java | `JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.2.8-hotspot\`; `java -version` / `javac -version`: `17.0.2`, Microsoft build `17.0.2+8-LTS` | **Tested** versions only; compatibility with a future pinned Gradle/AGP/Kotlin toolchain is **unverified**. |
| SDK package directories | Platforms include API 23, 25, 27-36 plus API 35 extension directories; build-tools include `34.0.0`, `35.0.0`, `36.0.0` and older versions | **Tested** directory presence only, not complete/usable build dependencies. |
| Configured system images | API directory names: 23-31 and 33; no API 32 or 34+ image directory observed in this configured root | **Tested** bounded package directory listing, not a list of AVDs. |
| API 33 image detail | `google_apis\x86_64` and `google_apis_playstore\x86_64` directories exist. Only the Play Store branch supplied a `source.properties` in the bounded API 33 search: revision `9`, API `33`, ABI `x86_64` | **Tested** metadata. The non-Play image's completeness and either image's bootability are **unverified**; do not select the Play Store image merely because its metadata is available. |
| Apple tools | `xcrun` and `simctl` did not resolve on Windows PATH | **Tested** PATH observation; local iOS Simulator operations are **unsupported on this host** by the product contract. |
| Git / Python | Git `2.53.0.windows.4`; Python resolves to `C:\Python312\python.exe` | Git version **tested**; Python execution/version not tested or needed. |

### Command ledger and scope

Executed read-only inventory commands were `git status --short`, `git log -1`, the baseline diff above, `$PSVersionTable`, .NET runtime OS/architecture queries, `Get-Command` for the table's tools, and reads of only `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, and `JAVA_HOME`. File probes used `Test-Path`, bounded `Get-ChildItem`, and the configured SDK's `source.properties`.

The external version/help commands were:

```text
node --version
git --version
C:\Program Files\nodejs\npm.cmd --version
C:\Program Files\Microsoft\jdk-17.0.2.8-hotspot\bin\java.exe -version
C:\Program Files\Microsoft\jdk-17.0.2.8-hotspot\bin\javac.exe -version
C:\ProgramData\chocolatey\bin\adb.exe version
C:\ProgramData\chocolatey\bin\adb.exe help
C:\android-sdk\platform-tools\adb.exe version
C:\android-sdk\emulator\emulator.exe -version
C:\android-sdk\emulator\emulator.exe -accel-check
%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe version
%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -version
```

These are command/argument records, not copy-paste shell strings: executable paths containing spaces were quoted and invoked with PowerShell's call operator. adb's help output was limited to the first 42 lines. SDK metadata inspection did not read licenses, credentials, AVD contents, or application data. No conclusion about the number, authorization state, or ownership of attached devices is possible from these observations.

## Synthetic Windows binary and PNG evidence

An isolated Node probe in the session artifacts generated a **3 by 2, 8-bit RGBA PNG with six synthetic pixels**, then spawned the exact Node executable with argument arrays, `shell: false`, `encoding: null`, separate stdout/stderr, a 2-second timeout, and a 1-MiB output limit. The child's PNG output was emitted in two writes, compared byte-for-byte to the generated input, written as a Buffer to disk, and read back. No device or third-party image was involved.

| Assertion actually executed | Result |
| --- | --- |
| Binary stdout and disk round trip | Exact equality; **88 PNG bytes**. |
| SHA-256 of generated, received, and persisted bytes | `836f566cf01f4902a729c0049e68302297111f75e808ac30b5e26ff272c950bc` |
| Independent image decode | Windows `System.Drawing.Common, Version=10.0.0.0` decoded `3 x 2`, `Format32bppArgb`, PNG format; all **six RGBA pixel assertions passed**. |
| Expected pixels, row-major | `[255,0,0,255]`, `[0,255,0,255]`, `[0,0,255,255]`, `[0,13,10,255]`, `[128,255,1,255]`, `[26,0,254,255]`. |
| Arbitrary binary values | All 256 byte values repeated across **4,096 bytes** survived a separate child-process round trip. |
| Stderr separation | The synthetic diagnostic remained on stderr, never in PNG stdout. |
| Deliberate text corruption | UTF-8 decode/re-encode changed the bytes and invalidated the PNG signature; the negative assertion detected it. This was not a test of every PowerShell version's redirection behavior. |
| Windows argument preservation | Drive-letter path with spaces, quote, ampersand, semicolon, pipe, CRLF, and empty argument arrived unchanged at the Node child. |
| Nonzero producer exit | A child emitted valid PNG bytes but exited **7**; the exit status remained observable. Valid image bytes alone cannot make such a capture successful. |
| Missing executable | A deliberately absent scratch executable yielded `ENOENT`. |
| Bounded synthetic timeout | A probe-owned Node child with a 250-ms timeout yielded `ETIMEDOUT` in **272 ms** on this run, below the asserted 5-second ceiling. This is not an adb/device timeout result. |
| Output limit | A probe-owned Node child exceeding a 128-byte test limit yielded `ENOBUFS`. |

The synthetic fixture is preserved here as base64, so this document alone retains the exact tested bytes without committing a screenshot or dependency:

```text
iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAH0lEQVR4nGP4z8DwHwwZ/v9nYODl+t/wn/G/FMO//wCO7wunmutKQQAAAABJRU5ErkJggg==
```

The probe source, generated PNG, Node report, and independent decode report remain under the session-artifact directory `P03 capture probe`; they are not repository dependencies. For a narrow independent reproduction, run this code with Node in a scratch directory, not against adb:

```js
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAH0lEQVR4nGP4z8DwHwwZ/v9nYODl+t/wn/G/FMO//wCO7wunmutKQQAAAABJRU5ErkJggg==',
  'base64',
);
const child = spawnSync(process.execPath, [
  '-e', "process.stdout.write(Buffer.from(process.argv[1], 'base64'))",
  png.toString('base64'),
], { shell: false, encoding: null, timeout: 2000, maxBuffer: 1024 * 1024 });
assert.ifError(child.error);
assert.equal(child.status, 0);
assert.deepEqual(child.stdout, png);
assert.equal(createHash('sha256').update(child.stdout).digest('hex'),
  '836f566cf01f4902a729c0049e68302297111f75e808ac30b5e26ff272c950bc');
writeFileSync('synthetic-process.png', child.stdout);
```

The separate decoder used `System.Drawing.Bitmap` to load that file and `GetPixel(x, y)` to assert the six listed RGBA values, disposing the bitmap afterward. This decoder is evidence from this Windows experiment, **not a proposed cross-platform production image library**.

These checks establish this host's Buffer/process/image-decoding path. They do **not** establish adb transport behavior, display selection, screenshot permissions, device image correctness, app readiness, density/insets, real cancellation, multi-device isolation, repeatability, or validation thresholds. None of those capabilities is upgraded from blocked/unverified by this synthetic result.

### Future binary-capture boundary

After authorization, the Android documentation's raw capture operation can be represented as an executable plus the fixed argument array `["-s", approvedSerial, "exec-out", "screencap", "-p"]`. This was **not executed**. Prefer direct stdout bytes over an on-device temporary screenshot, avoiding unnecessary device file writes. Do not copy the documentation's shell `>` example into a cross-version Windows provider.

The future process wrapper must retain Buffer/stream bytes without text encoding, isolate bounded/redacted stderr, require successful exit, and reject empty/truncated/corrupt output. Enforce byte, pixel, memory, and time limits before decoding or publishing; the specification's initial limits are 25 MiB per imported file and 64 megapixels per raster, subject to a reviewed stricter capture profile. Stage output under the authorized artifact root and expose it only after decode, dimensions, required metadata, and integrity checks. Preserve the raw PNG; a failed child, cancellation, or incomplete sidecar must not publish a success-shaped capture.

Host argument-array success does not prove remote-shell safety: adb shell-style operations can still involve device-side argument interpretation. The sample proposal below uses fixed operations and restricted tokens, never arbitrary shell commands, model-authored scripts, user-controlled file paths, or unrestricted deep links.

## Public Android and Apple prerequisite findings

Sources were read on 2026-09-16; recheck them against pinned tool versions before implementation/release. Summaries are platform prerequisites, not local demonstrations.

| Source | Public-doc finding and consequence |
| --- | --- |
| [Android Debug Bridge](https://developer.android.com/tools/adb), sections on server operation, device queries, targeting, activity manager, and screenshots | adb is client/server tooling; device-list operations can auto-start a server. USB device debugging requires device-side authorization. The `device` state does not itself prove Android finished booting. Explicit `-s` targets a serial. `am start -W` waits for launch, not application readiness. The screenshot section specifies `exec-out screencap -p` for raw PNG stdout. Its generic recovery examples do not authorize restarting this host's shared server. |
| [Android SDK environment variables](https://developer.android.com/tools/variables) | `ANDROID_HOME` identifies the SDK; `ANDROID_SDK_ROOT` is deprecated. Resolve tools deterministically without rewriting the user's PATH or environment. |
| [Android Emulator command line](https://developer.android.com/studio/run/emulator-commandline) | An emulator needs a selected AVD, image, and persisted state; starting or wiping it changes state. The current page also marks the legacy `emulator` tool deprecated in favor of Android CLI commands. Existing version/acceleration checks still worked here. Flag this external-doc evolution for version/support decisions; do not install new tooling or silently change the planned adb capture interface. |
| [Android Emulator acceleration](https://developer.android.com/studio/run/emulator-acceleration) | Documents read-only `-accel-check` and recommends WHPX on Windows. CPU/image architecture and graphics/hypervisor support matter. Actual boot/render evidence remains necessary despite the successful local acceleration check. No hypervisor or OS setting was changed. |
| [Apple: running on simulated or physical devices](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) | Simulator runs on a Mac; Xcode needs appropriate platform support, build scheme, and destination. Simulator behavior is not equivalent to a physical device's hardware/performance. Physical device pairing/signing instructions are not a Simulator requirement or authority to use a personal iPhone. |
| [Apple: additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components) | Simulator runtimes/platform support are installed components. Apple describes Xcode selection and first-launch component setup, including `simctl`. A command-line-tools shim alone does not establish a configured iOS Simulator environment. Downloads, first-launch setup, license acceptance, and switching global developer directories require an owner-provisioned host, not actions by this lane. |
| [Apple command-line tools FAQ, archived TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html) | Explains `xcrun` tool resolution and `xcode-select --print-path`. Useful for discovery semantics, not a current supported-version matrix. |
| [Apple Xcode system requirements](https://developer.apple.com/xcode/system-requirements) | The fetched page exposed its heading but no usable compatibility table. Exact macOS/Xcode compatibility must be verified on the nominated runner; no minimum version is asserted here. |

Apple's first two documentation URLs returned only a page title through the HTML reader; their content was verified through Apple's public documentation JSON at the corresponding `https://developer.apple.com/tutorials/data/documentation/xcode/<article-name>.json` endpoints. An older archived Simulator interaction URL returned 404 and was not used as screenshot evidence.

### macOS status, kept separate from Windows

**Blocked:** no Mac, macOS runner identity, access authorization, Xcode installation/version, selected developer directory, Simulator runtime, simulator UDID, or controlled iOS app was supplied. Neither Android-on-macOS nor iOS Simulator capture was executed. A Windows synthetic success cannot stand in for either.

For a later owner-authorized Mac prerequisite check, first record the OS/architecture, Xcode version and selected developer directory, `xcrun --find simctl`, and that installation's `simctl` help. Confirm that first-launch setup/licenses and the compatible iOS runtime were already provisioned. Simulator inventory and any CoreSimulator-service interaction need the agreed runner scope before use; no opportunistic remote connection is proposed.

Only after a dedicated simulator/app scope is approved should a future lane confirm version-specific `simctl list`, launch, route, boot-state, and `io <explicit-UDID> screenshot` operations against that runner. These command shapes and their output/metadata behavior are **unverified here** and must be checked in local help and real contract runs. Never use the ambiguous `booted` selector in an isolated capture contract. Boot, erase, install, shutdown, and status-bar/settings overrides are separate owner-controlled provisioning actions, not implicit capture recovery.

`simctl` supports **iOS Simulator, not physical iOS devices**. Physical iOS automation and remote Mac workers remain later optional adapters. M1 still needs Windows and macOS evidence for platform-neutral/Android behavior; the full iOS Simulator flow is M2, not an extra M1 requirement.

## Proposed smallest controlled Android sample

This is a proposed contract for G0 review, not a new schema or implementation task.

| Surface | Smallest proposed scope |
| --- | --- |
| Repository and ownership | One explicitly authorized sample repository/path and owner, with a pinned baseline commit and dependency locks. No arbitrary repository build or execution permission is inherited from a Figma bundle. The implementation agent's edit/build/install authority is separate from the capture tool's authority. |
| App | One offline Android activity, optionally Kotlin/Compose subject to the future toolchain decision. Suggested debug package `com.example.designstudio.sample.debug`; it is an illustrative identifier, not an installed app observation. Release variants omit all capture hooks. |
| Screen | Offline Downloads: title, enabled master toggle, enabled Wi-Fi-only toggle, deterministic storage label, and a clear-downloads control. Any confirmation behavior uses only an in-memory synthetic fixture; the capture route never clicks the destructive action. No sign-in, account, network, personal data, telemetry, storage permissions, or system-setting changes. |
| Data | Versioned fixture with fixed labels, toggle states, storage values, and app-local clock if needed. App-local fixture selection replaces only the sample's in-memory state; no `pm clear`, real downloads, or reset of another app. |
| Route | Debug-only explicit `CaptureActivity` accepts an allowlisted scenario ID and a fresh run nonce, internally navigates to the one screen, and rejects all other routes/actions. Prefer this to an unrestricted URL resolver. |
| Readiness | App-owned, nonce-bound receipt with expected screen/state identity and measured viewport; detailed below. `am start -W`, a timer, screen stability, and OCR alone are insufficient. |
| Candidate device profile | Owner-provisioned, dedicated emulator; propose API 33, Google APIs **without Play Store**, portrait, 1080 x 2400 display pixels, density 3 (480 logical-density dpi), font scale 1, `en-US`, light theme, fixed app font resources, no IME and zero scroll. This is not an approved or measured profile. The observed non-Play image directory is not proof it is installed completely. |
| Cross-host profile | Windows x64 and Mac architecture-appropriate system images require separately recorded image revisions, ABI, emulator/graphics versions, and repeatability evidence. Do not assume an x86_64 image accelerates on an Apple-silicon Mac or that pixel output is identical across render stacks. |
| Reference | A permission-cleared existing Figma mobile frame and immutable handoff/reference, approved mappings, required-control regions, scenario, and normalization policy. None was supplied. The exact app-content logical size must be reconciled with measured insets before approval. |

The proposed device dimensions minimize layout scope, not missing evidence. Choosing a different approved API/image/display profile is a G0 decision, not an opportunity for the capture tool to change device settings until a screenshot fits.

### Safe route/readiness interface

The app owner should implement a debug-only route plus a **small app-private receipt**, atomically replaced at a fixed app-owned path such as `files/studio-capture/current.json`. A proposed transport is the debuggable app's `run-as` access to that one file through adb. This transport, lifecycle signaling, and permissions have **not been implemented or verified**. If the nominated app/image cannot safely support it, the owner must nominate a scoped instrumentation/test adapter instead; no broad logcat scrape, arbitrary file pull, exported production endpoint, or silent fixed-sleep fallback.

Illustrative future command arguments, **not executed and requiring explicit approval**:

```text
["-s", approvedSerial, "shell", "am", "start", "-W",
 "-n", approvedPackage + "/.CaptureActivity",
 "--es", "studioScenario", approvedScenarioId,
 "--es", "studioRun", runNonce]

["-s", approvedSerial, "exec-out", "run-as", approvedPackage,
 "cat", "files/studio-capture/current.json"]
```

The provider owns the executable/operations; only validated identifiers from the approved scenario may populate the fixed positions. Restrict nonce and route IDs to bounded alphanumeric/hyphen tokens, validate package/component/serial against their approved identities, and reject shell metacharacters, newlines, arbitrary extras, or paths. Running without host shell expansion does not by itself protect adb's device-side interpretation.

The receipt contract should report:

| Receipt group | Required evidence |
| --- | --- |
| Binding | Receipt version, run nonce, scenario ID/hash, fixture ID/hash, application ID, actual app build ID/source digest, and route accepted or a typed app error. A stale receipt from the previous run must never qualify. |
| Identity | Expected stable screen ID `offline-downloads`, required label/control states, fixture identity, and current foreground/resumed/window-focus status from the app/test adapter. A wrong but stable screen is not ready. |
| Readiness | Explicit `loading`, `ready`, or `error`; assets/fonts loaded, fixture applied, required layout completed, no app-local pending work/animations, and a rendered-state generation. Publish ready after the intended frame is drawn, not simply after activity creation. |
| Freshness | Monotonic sequence/generation and state-change tracking; invalidate ready on navigation, layout/state changes, pause, focus loss, or error. Verify the nonce, state generation, and foreground identity before and after capture; reject a change during the capture window. |
| Viewport | Actual screenshot/display association, viewport pixels and logical units, density, font scale, rotation, content rectangle, status/navigation bars, cutout/safe-area and IME insets with explicit coordinate units. |

Readiness is bounded: propose a 15-second readiness deadline, optional three stable frames at 250-ms intervals **after** valid app identity/signal, a 5-second screenshot process limit, and a 30-second total job deadline including preflight/lock waiting. These are proposed budgets to turn into contracts, not measured device timings. Each stage consumes the remaining total deadline; polling has an attempt bound and responds to cancellation. No comparison follows a launch/navigation failure or unverified state. Image-stability-only exploratory capture, if separately authorized, must be labeled heuristic and inconclusive for strict gating.

The receipt is a trusted-test-interface proposal, not cryptographic attestation or proof of accessibility. App lifecycle claims need actual smoke coverage against overlays, stale receipts, focus loss, and navigation races. Cooperative Studio locks cannot exclude unrelated tools or a human; a dedicated device/time window and loss-of-ownership detection remain necessary.

### Approved scenario versus actual capture run

Do not bind approval to a future app build that does not yet exist. Separate these objects:

| Approved/versioned scenario and baseline | Observations for each capture run |
| --- | --- |
| Scenario version/content hash; sample repository/app identity; approved route/screen; fixture hash; required labels/states; locale/theme/fonts/font scale/orientation; target device/reference profile; content/inset policy; scroll; readiness method/budgets; normalization/masks; immutable bundle/reference hashes and validation policy | Run/job ID and nonce; actual selected device and ownership scope; actual APK/build ID/version and artifact digest; actual repository commit **plus dirty-state/source digest when not a clean build**; installed-build/installation-receipt cross-check; observed viewport/density/insets/state; tool versions; timestamps/durations; process exit/diagnostics; raw PNG/hash and receipt sequence |

The actual build changes across implementation iterations without mutating the approved scenario/reference. Cross-check the app-reported build identity with the authorized build/install record; do not just echo the requested commit. A changed route, fixture, design, mask, profile, or validation policy changes approval scope instead. Preserve the old handoff when the design head changes.

Keep `raw-device.png`, `normalized.png`, `device-metadata.json`, and `capture-log.json` in the approved local artifact root with an integrity manifest. The log records only allowlisted/redacted operation and readiness evidence, not other apps' logs or secrets. Include raw/normalized dimensions and hashes, model/OS/API, actual app and source provenance, scenario/reference identity, device scale, locale/theme/font scale, orientation, content bounds/insets, capture time, readiness evidence, and the exact normalization transform.

Density must come from provider/app metadata and agree with the app viewport; PNG dimensions alone cannot establish logical density. Record Android density separately from font scaling, and distinguish display pixels from app-content logical coordinates. Before approval, verify reference bounds against the measured content rectangle. Insets are not guessed from device marketing dimensions. Normalize only by declared uniform scale, explicit rotation, and verified content crop; retain raw evidence. Never stretch to match, auto-align away an offset, or crop discrepancies. Unknown density/insets, incompatible aspect ratio, or mismatched state yields inconclusive, not pass.

Masks default to none. Any system-bar/dynamic region mask requires prior reviewed scope, reason/owner, area coverage, and a maximum; it cannot obscure required controls or grow after failure. Image-only comparison reports native geometry/accessibility as not measured. Calibration still must demonstrate the Section 29.6 correct-repeat and seeded-defect cases, including sub-1%-of-screen defects. Synthetic byte checks do not calibrate `mobile-static-v1`.

## Future contract cases, not completed device tests

Use fake process/device boundaries for routine tests and a smaller explicitly authorized Windows/macOS integration suite. Proposed error names below are explanatory; the later shared-schema owner must reconcile naming and CLI exit semantics with Section 27.

| Case | Required future behavior and evidence |
| --- | --- |
| Tool missing, not executable, or unsupported version | Typed tool error; show the attempted approved locator and actionable prerequisite. No download, PATH change, or alternate unapproved executable. The synthetic `ENOENT` check covers only a missing Node child path. |
| Conflicting adb clients/shared server version | Stop for owner resolution before a client can auto-start/restart the server. Never `kill-server`, reconnect, or repair a global installation as capture recovery. Test that discovery does not implicitly grant device/server authority. |
| No device / unknown explicit serial | Typed device-selection failure; no default device fallback. Unscoped discovery needs its own consented inventory boundary. |
| Unauthorized device | Typed authorization/action-required result; do not accept RSA prompts, pair, enable debugging, inspect app content, or wait indefinitely. No screenshot is attempted. |
| Offline / disconnected during readiness or capture | Bounded failure with the observed stage; do not switch serials or restart adb. Retain diagnostics without a committed successful capture. |
| Multiple eligible devices | Require explicit approved serial; even a single attached personal device is not implicit authority. Assert every device-bound command retains the same serial. |
| Shared-device jobs and external interruption | Serialize by server/device identity across Studio processes, require an ownership lease/time window, and abort on lease/state loss. Cancellation of job A cannot kill the server, reset the device, or interrupt job B on another device. No global logcat clearing or app data erasure. |
| Missing app / wrong installed build | Typed app/build mismatch after a scoped check; do not install a replacement. A requested build ID or valid PNG is not proof the installed implementation matches. |
| Route rejected / component unavailable / launch failure | Propagate navigation/app error; never proceed to capture or comparison. `am start -W` success still requires app readiness. |
| Stable wrong screen / stale receipt / mismatched nonce | Reject as unverified/wrong state; no strict pass. Detect screen, fixture, build, and frame-generation mismatches despite identical/stable images. |
| Readiness timeout / process timeout | Enforce phase and whole-job deadlines, bounded polling, and redacted diagnostics. No unbounded `wait-for-device`, fixed-sleep success, or automatic app restart. |
| Cancel during queue, readiness, stdout, or normalization | Stop only job-owned subprocesses/reads, await termination, release its lease, and discard unpublished job-owned staging. Do not kill shared services or treat cancellation as app-side rollback; reconcile an already committed receipt. Real adb cancellation remains untested. |
| Protected/locked display, wrong display, empty/corrupt PNG | Typed capture/integrity failure when established; never bypass device protection. A decodable blank screenshot alone cannot diagnose `FLAG_SECURE` or prove success. Check permitted display/profile and app evidence. |
| Nonzero exit with valid PNG / output overflow | Nonzero exit is failure; enforce byte/pixel/decode limits. Windows synthetic probes exercised those Node process boundaries, not adb behavior. |
| Spaces, drive letters, quotes, line endings, remote shell inputs | Use explicit executable/argument arrays and cross-host path APIs. Verify both Windows and macOS boundaries; reject unsafe remote-shell payloads. The Node argument probe is not an adb quoting test. |
| Metadata missing / unknown density or insets / wrong aspect, theme, font, or screen | No normalization invented to force compatibility; report inconclusive where required evidence/profile is invalid. Distinguish an actual visual defect under a verified profile from a mismatched capture scenario. |
| Correct repeats and seeded defects | Same controlled build/state repeats pass; 8-logical-unit movement, missing critical toggle, wrong required label, and wrong rendered theme fail under verified scenario/profile. Required-control regions cannot move or disappear to hide the defect. Record false positives/negatives on each supported host profile. |
| macOS Simulator / physical iOS / Windows local iOS | Simulator contracts run only on an authorized Mac with explicit UDID. Physical iOS is a separate unsupported adapter here; Windows local Simulator requests return `UNSUPPORTED_HOST`, without remote fallback. |

An operational capture failure is a failed/cancelled job, not a zero-difference report. If a validation response is emitted for insufficient evidence, its verdict is explicitly inconclusive, with the underlying typed reason. Do not confuse successful submission/completed processing with a successful capture or visual policy pass.

## Exact missing prerequisites and G0 decisions

| Decision needed from coordinator/owner | Concrete missing input or evidence | Recommended disposition |
| --- | --- | --- |
| Accept P03's bounded result versus real Phase 0 exit | Live adb PNG, real app-state metadata, and Mac prerequisite execution are absent | Accept this report as a completed evidence-limited P03 pass; keep those real evidence items open. **Pause at G0** rather than call capture feasibility or M1 complete. |
| Authorize Android host/server/device scope | Named host and owner, dedicated AVD/device ID/serial (or explicitly scoped inventory permission to obtain it), server endpoint/ownership and compatible adb path/version, permitted operations, lease/time window, output/retention scope | Owner provisions/starts the dedicated environment separately. Approve discover/select/scoped metadata, sample launch/route/readiness read, and screenshot independently of install/reset/settings rights. Never choose the first personal device. |
| Select and authorize the sample | Exact sample repository/path/owner, baseline commit, package/activity, Gradle/AGP/Kotlin/JDK/SDK locks, fixture, route/receipt or instrumentation contract | Review the single offline-screen proposal. Explicitly assign edit/build/install work to a later authorized lane; this report does not start that work. |
| Supply reference and approval inputs | Permission-cleared Figma URL/frame, immutable reference/bundle and rights, approved manual component/token mappings, scenario hash, required regions/mask policy | No design or private screenshot was invented. Set profile/content bounds before scenario/reference approval; keep actual builds per run. |
| Choose reproducible Android profiles | API/image revision/ABI, dedicated AVD provisioning, display/density/insets, locale/theme/font assets/font scale, graphics backend, supported host combinations | Verify package completeness; do not infer readiness from the existing SDK directories or WHPX result. Approve any install/boot/settings work separately. |
| Nominate Mac evidence owner/runner | Exact Mac/runner and authorized access scope; OS/architecture/Xcode/developer-directory/runtime versions; dedicated Android profile for M1 and later iOS Simulator UDID/sample for M2 | Obtain owner-run prerequisites and later real smoke evidence. No remote credentials, worker, or personal iPhone access is assumed. |
| Approve the next bounded step | Explicit post-G0 authorization plus the inputs above, budgets, redaction/retention, and test ownership | The next safe work is an owner-scoped real capture smoke plus conversion of the supported contract cases into failing tests. Do not start C01/C02/C05, production providers, or sample implementation under the current first-wave authorization. |

The coordinator was notified that live capture needs exact device/app/server authorization. Safe work did not wait for it. Only this report is committed; no permission-cleared real capture fixture could be produced because no such scope was supplied. The session stops after its scoped commit, without push, pull request, merge, or downstream implementation.
