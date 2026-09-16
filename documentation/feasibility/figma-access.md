# P01: Figma access and snapshot transport feasibility

**Decision: documentation-backed candidates, not live feasibility approval. Pause at G0.**
Reviewed 2026-09-16 (America/Los_Angeles). No authorized Figma account, file,
plugin session, or host test matrix was supplied. No actual-account capability
has been verified. A file-transfer-first snapshot path is worth testing, but
neither it nor direct localhost pairing is currently proven.

## Scope and evidence boundary

The checkout began at `1a723018e27be043ec67085684ea28a1c9ef9d72`, exactly the
planning baseline, with a clean working tree. The specification diff against
that baseline was empty: **no checkout/specification divergence**. Reviewed
sections 4.4-4.5, 6B, 8.4, 14-16, 37, 44, 47A.10, 49, 51.1, and 58.
This greenfield checkout contained only `documentation` at its tracked root;
there was no production integration or test harness to exercise.

Evidence labels used below:

- **D (documented):** a current public official source was retrieved; this
  verifies what the platform documents, not the behavior of an account.
- **U (unverified):** a proposed product behavior or compatibility hypothesis.
- **B (blocked):** live confirmation needs explicit account/file/host permission.

This investigation made public documentation GETs and read-only repository
checks only. It did not inspect credentials, private designs, application state,
or home directories; run/install a plugin; pair; upload; or call `api.figma.com`.
No fixture/probe was created: a mock cannot answer the remaining permission,
quota, or editor-transport questions. All recommendations below are handoff
inputs, not implemented functionality.

## Capability matrix

All rows have **B** actual-account status.

| Capability | Public evidence | Proposed supported behavior / remaining gap |
|---|---|---|
| Local REST authorization | **D:** PATs support individual local tooling; granular scopes do not override file/organization permissions. OAuth is recommended for per-user applications. Plan tokens require Organization/Enterprise. [R3][R4] | Local M1 can request `file_content:read`, plus `file_metadata:read` for inexpensive version discovery. Provision through the OS credential store, never chat, CLI arguments, repository, plugin, or bundles. No shared developer token or premium plan token prerequisite. **U:** intended account's effective permissions and expiration. |
| Explicit frame/subtree | **D:** `GET /v1/files/:key/nodes` accepts `ids`, `version`, optional `geometry=paths`; keys may identify files or branches. Nodes can be null. Depth limits are truncation, not completeness. [R2] | Require an explicit node. File-only URLs return `NODE_SELECTION_REQUIRED`; do not discover a selection by scanning the whole file. Preserve file/branch identity. Request only selected subtrees and approved dependencies. |
| Version-pinned structure and reference | **D:** file/node endpoints and `GET /v1/images/:key` accept `version`; metadata returns `file.version`. [R2] | Pin the same version on every applicable request. Never silently retry at latest. Record requested/returned identity and request parameters. No documented atomic transaction across endpoints or guarantee of re-rendered byte identity. |
| Rendered artifacts | **D:** render map includes each requested ID, possibly null; renders above 32 megapixels are downscaled; scale is 0.01-4; render URLs expire after 30 days. [R2] | Download and decode actual bytes; hash content and record dimensions, bounds, scale, format and color-profile evidence. Null, missing, corrupt, partial or unexpectedly downscaled evidence cannot count as complete. |
| Historical image fills | **D:** `GET /v1/files/:key/images` has no documented version selector; its image-reference URLs expire within 14 days. [R2] | Resolve only `imageRef`s from pinned structure; fetch only required bytes even though the response lists file-wide fills. Historical recovery is **U**, not guaranteed. Missing old references block readiness; no substitution with today's fills or a new screenshot. |
| Variables and modes | **D:** Enterprise restriction, `file_variables:read`, and view access for GET. Prose says Full seat/member, no guests; the overview table also says "Any organization member" for GET. Published variables omit modes; endpoints have no version parameter. [R5] | Treat eligibility wording as unresolved, not a promise for View/Dev seats. Optional enrichment only: preserve bindings, effective values, missing aliases/modes and evidence timing. Do not attach current variable definitions to historical nodes as version-exact. Manual reviewed logical tokens remain supported. |
| Components/styles/libraries | **D:** node responses contain instance/component/style metadata; published component endpoints are metadata, not a complete visual definition. File-library listing requires a main-file key, not branch key. [R2][R6] | Use captured instance expansion when sufficient; separately report unresolved masters, overrides, variants and mappings. No automatic cross-file library crawl or inference that visible pixels grant access to the master. Pin/hash independently authorized dependencies; do not equate another file's version with the selected file's version. |
| User-opened selection snapshot | **D:** current-page selection, `exportAsync` PNG/SVG/`JSON_REST_V1`, and image `getBytesAsync` are documented. [P4][P5] | Candidate read-only capture of one frame, dependencies, structure, reference and assets. `JSON_REST_V1` is useful prior art, not proof of identical envelopes, completeness, or REST version identity; verify its actual shape before choosing an adapter. |
| Plugin availability and lifetime | **D:** plugins run manually in the editor, one at a time, and can be cancelled. Seat/editor eligibility and organization policy apply. [P1][P8] | No closed-plugin server push, daemon, unattended sync, or universal low-seat fallback. Closure/cancellation is an explicit interruption, not a completed snapshot. See entitlement table below. |
| Plugin source identity/consistency | **D:** `figma.fileKey` is available only to private plugins and Figma-owned resources; private plugins enable it with `enablePrivatePluginApi`. Change events are asynchronous and have coverage limits. [P3][P6] | Public plugin cannot invent file/branch identity from a name or node ID. Record user-supplied URL as asserted, not verified. Capture/session ID plus content/dependency digests identify captured content, not an immutable REST version. |
| Fonts | **D:** text can have mixed styles and missing fonts yet still appear correctly in Figma; loading is needed for text edits, not simply reading properties. [P9] | Preserve styled ranges and missing-font state. Figma rendering does not deliver font files or redistribution rights. Require approved local/pinned fonts for strict conversion; never load/substitute fonts by editing the design during this read-only workflow. |
| Editable document writes | **D:** Plugin API exposes document creation/editing; limited REST writes such as variables are not a general scene-write API. [P3][R5] | Explicitly excluded from P01/M1. No REST document-write API, hosted relay, M3 publishing or round-trip implementation is assumed. |

### Scopes, tiers, and realistic request cost

The file-endpoint HTML annotations confirm: file, nodes and renders are Tier 1
with `file_content:read`; fills are Tier 2 with `file_content:read`; metadata is
Tier 3 with `file_metadata:read`. [R2]

Optional operations request additional scopes only when enabled: version-history
listing uses `file_versions:read`; Variables GET uses `file_variables:read`;
published library metadata uses the relevant `library_assets:read`,
`library_content:read`, or `team_library_content:read`. No writes, user profile,
comments, webhooks, broad deprecated `files:read`, or latest-selection scope is
needed for the proposed explicit-frame path. [R4]

**Quota-source discrepancy:** the retrieved HTML table in [R1] says the following,
but prose on that same page still says up to **6/month**, with an example of
**2/month** under demand. It also calls metadata Tier 2 in an example, contrary
to its table and [R2]'s Tier 3 annotation. Treat these as documentation
inconsistencies, not extra capacity or an account entitlement:

| Resource plan / user's seat in that plan | Tier 1 table ceiling | Tier 2 table ceiling | Tier 3 table ceiling |
|---|---:|---:|---:|
| Starter, all seats (row-spanning table cells) | Up to 20/month | Up to 5/min | Up to 10/min |
| Professional/Organization/Enterprise, View or Collab | Up to 20/month | Up to 5/min | Up to 10/min |
| Professional, Dev or Full | 10/min | 25/min | 50/min |
| Organization, Dev or Full | 15/min | 50/min | 100/min |
| Enterprise, Dev or Full | 20/min | 100/min | 150/min |

These are **D table observations, not guaranteed usable budgets**. Limits depend
on the requested resource's plan, not the user's best seat elsewhere. PAT usage
is shared per user/plan; OAuth is per user/plan/app; plan tokens are per
token/plan. Do not mint identities/tokens to evade limits. The 429 response's
`Retry-After` seconds, `X-Figma-Plan-Tier` and `X-Figma-Rate-Limit-Type` provide
live rate-limit evidence; do not deliberately exhaust an account to obtain it.

Proposed minimal current-frame run: one metadata GET to discover version, one
batched pinned-node GET, one batched pinned-render GET, and an optional fill-map
GET, then authorized asset downloads. This is **two Tier 1 calls**, one Tier 3,
and optionally one Tier 2 before dependencies or retries. A caller-supplied
version can omit metadata discovery. Branch resolution/history browsing may
cost extra and need separate approval. Even one run could exceed remaining
low-seat capacity; do not promise a refresh frequency. Cache immutable bytes,
avoid polling, honor persisted retry deadlines, and stop at an agreed call/job
budget with `RATE_LIMITED`, not stale-success substitution.

### Plugin entitlements and manifest boundary

The official run-plugin table [P8] gives:

| Account/seat | Figma Design plugin | Dev Mode plugin |
|---|---|---|
| Starter | Documented eligible | Not eligible |
| Full | Documented eligible | Documented eligible |
| Dev | Not eligible | Documented eligible |
| Collab or View | Not eligible | Not eligible |

Eligibility is necessary, not evidence of permission on the intended file or
organization. **The snapshot plugin does not rescue every REST-limited account.**
Dev Mode inspection plugins can read and export without document-write access,
but still require the appropriate seat and manifest. They can write some
metadata; "read-only" here must prohibit even plugin data/relaunch tags. [P7]
A Design-mode plugin's no-write property is an implementation constraint, not
a general manifest permission that removes all write APIs.

Proposed manifest profile, not a created plugin: `documentAccess: "dynamic-page"`;
Design editor first, separately test `dev` plus `inspect` if Dev seats are in
scope. Avoid proposed/private API requirements in the public path. File-only
transfer should use `networkAccess.allowedDomains: ["none"]` and packaged UI,
not a remotely hosted iframe. No user identity or `teamlibrary` permission by
default. The latter is only justified for specifically approved dependencies;
libraries must already be enabled by the user, and access can fail. [P2][P3]
Async variable lookup may return null; it is not proof of unrestricted access
to variables/libraries and must not trigger imports/mutations to fix denial.
The manifest permits private API testing in local development; that does not
establish `fileKey` availability in a distributed public plugin.

Local-development domains belong in `devAllowedDomains`; production local
allowlisting needs the explicit allowed domain/port and `reasoning`. Manifest
acceptance does not prove network reachability. Organization plugin controls
and distribution must be reviewed; private/internal distribution is not an
automatic workaround for a blocked public plugin. [P2][P8]

## Source consistency and artifact completeness

**REST proposal:** discover or accept version V, read selected structure at V,
extract required dependency/image references, then request reference renders
at V. Record endpoint, selected IDs, scope, requested version, response
metadata, capture time and hashes without logging secrets or signed URLs.
Use `geometry=paths` when vector structure is required. Do not use a shallow
response as the final import; a full-file `ids` query can also return ancestor
chains, extra dependencies and top-level canvases, so minimize retained data.

Required historical fills must be recovered by the exact pinned references
from the unversioned fill map or an already verified authorized cache. If not,
retain an inspectable partial capture and block complete readiness. Optional
current Variables/library enrichment is separately timed evidence, never
silently part of V. An ambiguous 403/404 is not node deletion; `NODE_REMOVED`
requires a successful read of the requested file/version proving absence.

**Plugin proposal:** lock the selected frame IDs logically for a capture
attempt, without modifying selection/document. Observe page/selection changes;
serialize selected structure and dependency state before and after PNG/asset
export; digest both and discard an unstable attempt. Bound retries and emit
`SOURCE_CHANGED_DURING_CAPTURE` on exhaustion. Recheck referenced components,
styles and variables, not only local node geometry.
Record editor/export settings and verify hidden-descendant coverage: Dev Mode
defaults `skipInvisibleInstanceChildren` to true. A partial traversal is not
proof of full source closure, even if the visible reference looks correct. [P7]

Under dynamic-page access, global `documentchange` requires loading all pages;
prefer scoped page observation plus explicit dependency comparison, rather
than silently loading the confidential file. Global change events are batched
and omit some derived instance/style updates. Pre/post equality is **not an
atomic freeze**, and can miss change-and-revert activity during export. [P6]
Label the result as a change-checked, user-session observation with its capture
interval and limitations. Do not call it REST-version-pinned or transactionally
consistent. Strict readiness requires a declared accepted consistency policy;
uncertain captures need review or a stronger REST capture, not implicit approval.

For both transports, keep requested versus returned artifact inventories.
Verify decode, dimensions and local hashes; do not persist expiring URLs as
assets. Explicitly record missing/null nodes or renders, HTTP/decode failures,
partial downloads, oversized payloads, downscaling, absent fonts, unresolved
dependencies and conversion losses. A successful HTTP status or valid JSON is
not a complete bundle. The spec's 64-megapixel local decode ceiling does not
override Figma REST's 32-megapixel export limit. No observed plugin raster limit
has been established; verify its actual dimensions rather than borrowing REST's.

## Transport and host compatibility

[P10] documents a Figma-specific Fetch API and says plugin iframes have a
`null` origin and require wildcard CORS. [P1]'s sandbox explanation says
browser Fetch is not directly exposed; these are not evidence that native
browser Fetch and the Figma bridge are interchangeable. Verify actual headers,
preflight and response access on the chosen bridge.

**Do not relax the main local API to wildcard/`null` origins to make a demo
work.** This conflicts with a naive reading of the spec's restrictive-origin
boundary. Direct transport needs a separately reviewed, narrowly scoped
paired-ingest design or must remain unavailable. Loopback binding, exact
Host/endpoint checks, short-lived operation/project-bound capability,
one-time pairing, authenticated messages, payload/chunk hashes, acknowledgments,
timeout/cancel and replay rejection remain requirements; none was implemented
or tested here. Figma credentials never cross into the plugin.

| Intended combination | What is documented | Actual result and G0 disposition |
|---|---|---|
| Windows, Figma desktop | Desktop plugin execution is documented; manifest can name localhost. [P2][P7][P8] | **B:** no authorized editor/account trial. Candidate for file download/import first; direct Fetch/WebSocket pairing **U**. |
| macOS, Figma desktop | Same platform APIs; no OS-independent transport guarantee. | **B:** no authorized Mac trial. Candidate only; test macOS network permissions, loopback and download/save behavior separately. |
| Windows, Figma web in Chrome/Edge | Web plugins are documented. CORS/CSP and browser local-network rules still apply. [P7][P10][N1] | **B:** versions/policies unspecified. Neither Chrome evidence nor a desktop success proves Edge/browser iframe pairing. |
| macOS, Figma web in Chrome/Safari | Web execution is documented, not compatibility of every transport/browser. | **B:** separate Safari/Chrome trials required, including user-gesture downloads and local-network/mixed-content behavior. |
| Firefox, other browsers, VS Code/other editors | Not selected for this first candidate profile. | **U:** no support claim; explicitly defer rather than inherit another host's result. |

Classic development-plugin validation should begin in desktop Figma, as in
the official course [P11]; do not assume a locally imported development plugin
is distributable to browser users. Published/internal distribution and each
target editor need their own authorized trial. CSP, CORS, mixed content,
loopback address/port, private/local-network permission and enterprise policy
are separate checks. [N1] is a 2025 Chrome rollout article, not proof of the
current 2026 browser configuration. No security flags, OS permissions or
certificate warnings were changed/bypassed. No hosted relay is proposed.

### User-mediated snapshot-file fallback

Proposed flow: authorized user opens the approved plugin in the intended file,
explicitly selects a frame and confirms local export; plugin packages supported
structure, reference/asset bytes, source assertions, capture identity/digests
and diagnostics; user saves a snapshot file and explicitly supplies that path
to the local tool. The tool validates it as untrusted input and materializes
content-addressed artifacts offline. No server connection or REST token is
needed in the plugin. The save/download mechanism is **U/B** until tested in
each claimed editor; no production file format is chosen in P01.

File import must bound size/decode/expansion, reject traversal/absolute paths
and active content, sanitize SVG, validate hashes and completeness, and apply
local confidentiality/retention rules. A digest checks integrity, not the
identity/authorization of the exporter. User-supplied URL binding remains
asserted unless independently verified. Files copied out cannot inherit
revocable Figma ACLs. Cached bundles are not evidence of current access.

If REST and plugin access are both unavailable, only an already authorized,
complete cached/supplied snapshot can be used. Otherwise return action-required/
no-live-import. File transfer is not a bypass for denied plugin/seat permission,
nor permission to have someone else export private designs. A screenshot alone
does not replace a structured, complete implementation handoff.

## Proposed supported subset and F01 handoff

**Candidate subset, not proven support:** one static, fixed-viewport mobile
frame; ordinary frames/auto-layout rows/columns/stacks, measured absolute
placement, styled text with available licensed fonts, solid paint/simple
borders/radii/basic shadows, local images and sanitized supported icons, and
instances with captured visual expansion. Preserve raw evidence and
node/property-level `exact`, `approximated`, `opaque`, `unsupported` losses.
This is the section 8.4 target, not a conversion certification from P01.
Manual approved token/component mappings are sufficient; Code Connect, MCP,
premium Variables, animation, arbitrary vectors and editable writes are not
prerequisites. Never flatten a control or whole screen and claim exact structure.

F01 should turn the following into failing acceptance/adapter contracts only
after G0 authorization; these are behaviors, **not a production schema**:

| Testable case | Required observable result |
|---|---|
| File-only URL, invalid URL, explicit branch/frame | No whole-file fetch; explicit selection diagnostic; identity never silently changes to main file. |
| Metadata V followed by concurrent edit | Every version-capable request still sends V; failed historical reads do not fall back to latest. |
| Null/missing selected node, render-map null, ambiguous denial | Per-artifact failure and non-ready partial capture; no inferred deletion from ambiguous access failures. |
| Old imageRef absent; expiring URL; truncated bytes; 32MP downscale | Exact reference closure or blocked readiness; local verified bytes/hashes; dimensions checked against requested bounds/scale. |
| Variables denied/absent modes; inaccessible library/master; missing font | Useful supported source retained with explicit unavailable dependencies; no invented tokens, font substitutions, detachment, or hidden lookup scope expansion. |
| 429 with long Retry-After; retry/restart | Persist next eligible attempt, enforce call/deadline budget, no early retry/poll or stale-success bundle. Test offline, not by exhausting a real account. |
| Plugin JSON export versus REST nodes | Validate actual captured envelopes/properties independently; transport identity remains separate even if normalized content matches. |
| Plugin selection/page/derived component change or closure mid-capture | Bounded invalidation/retry or terminal diagnostic; partial assets never finalize as complete. Read-only audit includes metadata and undo history. |
| No private fileKey; supplied URL disagrees or cannot be verified | Explicit asserted/unknown source binding; no fabricated REST version, cross-file refresh match or automatic rebind. |
| Tampered/traversal snapshot; cancelled save; missing asset/chunk | Reject unsafe input or retain non-ready diagnostics; no arbitrary path writes/remote fetch, no approval transfer. |
| Pairing wrong/expired/replayed; unrelated website/local request | Reject before ingest/authority use; never expose generic filesystem/execution/core API access. Real browser proof remains required. |
| Repeat offline consumption | Captured required bytes suffice without Figma/network; deterministic downstream hashes exclude volatile provenance appropriately while retaining its traceability. |

## Exact G0 decisions and blocked prerequisites

**Recommendation: accept P01 as a completed documentation investigation with
live feasibility blocked; do not mark Phase 0 or M1 access complete. Stop this
wave at G0.** Production schemas/importer, pairing and plugins must not start
from this report alone.

| G0 decision for coordinator/user | Recommended disposition / evidence needed |
|---|---|
| Which account/resource cohorts must work? | Select explicit Starter, Full and/or Dev seat cases with the resource's plan and member/guest status. Exclude View/Collab plugin support unless Figma changes eligibility. Decide whether their REST-only/cached-only limitation is acceptable. |
| What live data and budget are authorized? | Supply named account, exact file/branch/frame and historical version(s), authorized dependencies, a per-endpoint call/retry budget and owner-approved sanitized-fixture retention. Include a known historical fill and a denied library/variable case if permission-cleared. No team/file discovery. |
| How are credentials provided? | Owner provisions least-privilege, expiring PAT via Windows Credential Manager or macOS Keychain on the approved test host; no tokens in messages/artifacts. Record granted scopes and expiration, not secret values. Optional scopes/seat upgrades require separate decisions. |
| Which plugin/distribution is authorized? | Approve reviewed read-only plugin code/distribution, editor mode, exact manifest permissions, local download and (separately) pairing. File policy must allow export. Name authorized Windows/macOS hosts, desktop builds and browser versions. Nothing is installed or run yet. |
| What source guarantee is acceptable? | Accept explicit user-asserted URL and change-checked session capture for plugin-only imports, with review, or require independently verified binding/REST history. Do not silently weaken section 14.5's consistency requirement or claim a transactional guarantee the API does not provide. |
| Which transport ships first? | Validate user-mediated file transfer first. Keep direct localhost unsupported until narrow auth/CORS design and real negative/positive host trials pass. No relay; no weakening the main local API. |
| When may F01 proceed? | Only after the coordinator/user reviews the four first-wave results and explicitly authorizes the next work. Turn accepted subset/gaps into contracts; carry unresolved live gates forward visibly if an explicit risk acceptance is made. |

Live success evidence should include authorization scope, plan/seat/editor/OS
versions, sanitized request/status headers and parameters, captured dimensions/
hashes and inventories, source consistency classification, loss diagnostics,
and no-write/no-secret checks. Capture actual success and denial/closure paths
on each claimed host, not just mock tests. Font redistribution and library
retention rights require owner confirmation. No current prerequisite is
silently satisfied by public documentation.

## Reproduction and source ledger

Executed repository observations:

```powershell
git --no-pager status --short
git rev-parse HEAD
git --no-pager diff --stat 1a723018e27be043ec67085684ea28a1c9ef9d72 HEAD -- documentation\spec\ai_native_design_studio_spec_v4.md
git --no-pager log -3 --oneline
git --no-pager ls-tree --name-only HEAD
```

Results: empty status/spec diff; HEAD exactly baseline; only the specification
commit in history and `documentation` at the tracked root. Public pages below
were retrieved with `web_fetch`; the file-endpoint page was read in two chunks.
Its Markdown conversion omitted endpoint scope/tier notices, and the rate page
omitted the quota table, so these were checked in HTML with `Invoke-WebRequest`,
regex table extraction and `System.Net.WebUtility::HtmlDecode`. Rowspans were
inspected explicitly to attribute Starter values to both seat rows.
Reproduction of the quota-table check (public GET only):

```powershell
$html = (Invoke-WebRequest -Uri 'https://developers.figma.com/docs/rest-api/rate-limits/').Content
$table = [regex]::Match($html, '<table\b[\s\S]*?</table>').Value
[regex]::Matches($table, '<t[dh]\b[^>]*>[\s\S]*?</t[dh]>') | ForEach-Object {
    $attributes = [regex]::Match($_.Value, '^<t[dh][^>]*>').Value
    $text = [System.Net.WebUtility]::HtmlDecode(($_.Value -replace '<[^>]+>', ''))
    "$attributes $text"
}
```

Candidate documentation URLs ending in `/docs/plugins/setup/` and Chrome
`/blog/local-network-access-update` returned 404. They supplied no capability
evidence; the official course and existing Chrome article below were used
instead. No downloaded source files or scratch experiments remain.

All links below were retrieved on **2026-09-16**. Sources R1-R3, R5, P1-P2
and P9 recheck the Figma entries in specification section 58; Android is owned
by the separate capture lane and was not re-investigated here.

| ID | Official source and facts used |
|---|---|
| R1 | [REST rate limits](https://developers.figma.com/docs/rest-api/rate-limits/) - tiers, table/prose discrepancies, resource/seat accounting and 429 headers. |
| R2 | [File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) - scope/tier HTML notices, metadata, selected nodes, branches, versions, nulls, render sizes and URL expiry. |
| R3 | [Authentication](https://developers.figma.com/docs/rest-api/authentication/) and [PATs](https://developers.figma.com/docs/rest-api/personal-access-tokens/) - local/per-user authorization and token lifecycle. |
| R4 | [Scopes](https://developers.figma.com/docs/rest-api/scopes/) - granular read scopes, deprecations, and permissions still apply. |
| R5 | [Variables overview](https://developers.figma.com/docs/rest-api/variables/) and [endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/) - eligibility wording, modes, IDs, read failures and no version selector. |
| R6 | [Components/styles endpoints](https://developers.figma.com/docs/rest-api/component-endpoints/) - metadata, main-file library identity and denied access. |
| P1 | [How plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/) - sandbox/UI contexts, cancellation and dynamic loading. |
| P2 | [Manifest](https://developers.figma.com/docs/plugins/manifest/) - dynamic-page, network domains, permissions and private/proposed APIs. |
| P3 | [Figma global API](https://developers.figma.com/docs/plugins/api/figma/), [Variables API](https://developers.figma.com/docs/plugins/api/figma-variables/) and [TeamLibrary API](https://developers.figma.com/docs/plugins/api/figma-teamlibrary/) - fileKey restrictions, async reads and enabled/authorized libraries. |
| P4 | [PageNode](https://developers.figma.com/docs/plugins/api/PageNode/) and [exportAsync](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/) - selection and structure/image export. |
| P5 | [ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/) and [Image](https://developers.figma.com/docs/plugins/api/Image/) - JSON export claims, bounds/color settings and image bytes. |
| P6 | [Global events](https://developers.figma.com/docs/plugins/api/properties/figma-on/) and [page events](https://developers.figma.com/docs/plugins/api/properties/PageNode-on/) - asynchronous/batched observation, dynamic loading and event gaps. |
| P7 | [Dev Mode plugins](https://developers.figma.com/docs/plugins/working-in-dev-mode/) - read/export capabilities, metadata exceptions and editor differences. |
| P8 | [Run plugins](https://help.figma.com/hc/en-us/articles/360042532714-Use-plugins-in-files), [organization controls](https://help.figma.com/hc/en-us/articles/4404228724759-Manage-plugins-and-widgets-in-an-organization) and [internal plugins](https://help.figma.com/hc/en-us/articles/4404228629655-Create-internal-plugins-for-an-organization) - seats, manual lifecycle and distribution/policy. |
| P9 | [Working with text](https://developers.figma.com/docs/plugins/working-with-text/) - mixed ranges, missing versus unloaded fonts. |
| P10 | [Network requests](https://developers.figma.com/docs/plugins/making-network-requests/) and [Figma Fetch](https://developers.figma.com/docs/plugins/api/properties/global-fetch/) - bridge behavior, null-origin/CORS and network restrictions. |
| P11 | [Build your first plugin overview](https://help.figma.com/hc/en-us/articles/4407260620823-BYFP-Overview-Build-for-your-first-plugin) - desktop development workflow. |
| N1 | [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access) - evolving local/loopback permission restrictions; article dated 2025-06-09, not a tested 2026 compatibility claim. |
