# @design-studio/cli

## Explicit offline recovery (native v7)

```text
figma reference-recovery-apply-plan --project <ID> --request-id <original request> --expected-job <Job SHA256>
figma reference-recovery-apply --project <ID> --request-id <original request> --expected-job <Job SHA256> --expected-proof <current apply-plan SHA256> --confirm RECOVER-VERIFIED-REFERENCE-OFFLINE
figma reference-recovery-inspect --project <ID> --request-id <original request> --expected-job <Job SHA256>
figma convert-reference --project <ID> --request-id <original request> --expected-job <Job SHA256> --expected-recovery <recovery receipt SHA256> --confirm CONVERT-WITH-RECOVERED-REFERENCE
```

These commands derive identities and paths from the original request. They
accept no URLs, caller artifact/job IDs, filesystem paths or serialized proofs.
The new apply plan must come from the current v7 installation; an older v6
validation proof cannot authorize writes. Confirming recovery authorizes an
offline copy/publication, never another download or an original-job retry.
**Applying seals the project:** schema 5 permits one offline recovery and its
explicit reference-bound conversion, not unrelated capture/edit/export/metadata
mutations. The apply plan reports this restriction. Use a separate project for
unrelated work until version-aware continuation is separately reviewed.
Maintenance may inspect the sealed project but cannot delete or discard data.

Recovery preserves the consumed interrupted diagnostic and creates a distinct
receipt. Inspect is nonmutating. A pending effect, unknown publication or retained
SQLite sidecar is blocked, not automatically reconciled. Conversion uses a new
receipt-bound identity and still reports `blocked` or `needs-review`, never
render-ready merely because a reference image is available.

## Offline retained-reference validation

```text
figma reference-recovery-plan --project <existing ID> --request-id <original capture request> --expected-job <metadata Job SHA256>
```

This separate v6 native read-only command validates retained physical outputs,
source/approval lineage and PNG evidence without another provider request.
Exit 0 means a closed `eligible-for-recovery-review` plan, not acquisition
completion, publication, usable-image export or conversion readiness. The old
interrupted job and consumed history remain unchanged. No apply/download
confirmation, arbitrary job/path/URL or metadata-mode override is accepted.
Old releases cannot mint validation authority.

Use a cold dedicated command process. A previously initialized SQLite addon,
retained WAL/SHM/journal (even empty), incompatible schema, live writer, unsafe
publication or changed authority fails closed. The command never checkpoints,
migrates or deletes sidecars. It returns safe hashes/counts/dimensions and proof,
not image bytes or private text. Recovery/apply is a separate future capability.

## Explicit selected-reference attachment

A separately inventory-bound version-5 diagnostic supplement also exposes:

```text
figma reference-diagnostic-plan --project <ID> --request-id <original capture request>
figma reference-diagnostic-approve --project <ID> --request-id <original capture request> --origin https://figma-alpha-api.s3.us-west-2.amazonaws.com --expected-proof <proposal SHA256> --confirm APPROVE-ONE-DIAGNOSTIC-REFERENCE
figma reference-diagnostic-download --project <ID> --request-id <original capture request> --expected-approval <approval artifact SHA256> --confirm DOWNLOAD-ONE-DIAGNOSTIC-REFERENCE
figma reference-diagnostic-inspect --project <ID> --request-id <original capture request>
```

These commands do **not** retry or reset the original job. They derive one
successor slot from the exact original reference job and verified immutable
receipt, only for a completed unavailable HTTP-200 / `INVALID_INPUT` / no-PNG
result with exactly one settled GET and no publication uncertainty. A legacy
record's absent rejection phase stays unknown. There is no caller-selected
predecessor/acquisition ID, URL, path, policy override or general retry switch.
Fresh diagnostic approval and explicit download consent are required; an expired
original approval is historical evidence only. Admission permanently consumes
the sole successor slot, including failures and across decoder/policy updates.
Inspection/repeated download of an admitted slot is read-only; successors cannot
be chained. Code availability is not permission for a live invocation.

An independently approved version-4 native capture installation exposes:

```text
figma reference-plan --project <ID> --request-id <original capture request>
figma reference-approve --project <ID> --request-id <original capture request> --origin https://figma-alpha-api.s3.us-west-2.amazonaws.com --expected-proof <proposal SHA256> --confirm APPROVE-ONE-SELECTED-REFERENCE
figma reference-download --project <ID> --request-id <original capture request> --expected-approval <approval artifact SHA256> --confirm DOWNLOAD-ONE-APPROVED-REFERENCE
figma reference-inspect --project <ID> --request-id <original capture request>
```

Planning and inspection are read-only. Approval records the displayed original
capture/selection/version, PNG intent, exact origin and limits offline; it does
not download. Only the separately acknowledged download command can admit the
single bounded acquisition. There is no URL/path/token argument or origin
allow-list editor. Existing inspect/convert commands do not fetch references.
Approval expires after at most five minutes and is not silently renewed.
If it expires before any acquisition is admitted, request a fresh plan and
explicitly approve its new proof. The immutable renewal links the prior expired
approval; replaying the old approval command does not extend it. At most 32
approval generations are retained. Any admitted job permanently forbids renewal,
even when its HTTP effect was absent or unknown.

The signed URL is loaded privately from the original authenticated committed
render map. It is not printed. Expired URLs, 403, redirects, malformed images,
unknown effects and publication uncertainty do not trigger refresh or recapture.
Once admitted, the same acquisition can only be inspected/replayed read-only,
not retried; completed replay still needs current local authority. A predecessor's
retained stage can remain only under exact immutable recovery-grant and physical
identity/hash proof. Unknown stages or orphan publications require explicit
review, not automatic adoption. Existing validated conversion receipts and safe
private exports need not be deleted.
PNG and decoded geometry/color evidence have their own receipt. The original
partial capture and unresolved rights remain unchanged; no rendering or
implementation readiness is claimed.

F08 `designctl` implements one command dispatcher over the shared native
application facade or authenticated loopback API. The shipped launcher and
local fixture initialization are wired to the reviewed offline installation
verifier. The retained full-runtime installed diagnostics produced one
complete initialization/accept/render/preview/shutdown pass and one render
observation `DEADLINE_EXCEEDED`, despite the renderer opening. This does not
establish the failed observation's final job state. Prior installed checks
intermittently took 56--60 seconds; the passing diagnostic also had a 26.6-second
startup-verification outlier. Reliable latency and the outliers' root cause
remain unresolved. The approved minimal runtime profile subsequently passed
three sequential fresh-owned flows with complete retained evidence, identical
file/byte counts and service current-check maxima of 3.98-4.12 seconds with two
active checks. This is bounded repeatability for the exercised workflow, not a
statistical guarantee or proof that the earlier outlier cause was eliminated.
See the application README for retained numerical evidence
and the still-required final user release approval.

`--json` writes one contract-valid JSON object and newline to stdout; it never
prompts. Error values do not echo argv or raw exceptions. Binary artifacts will
be delivered through approved output roots, not mixed into JSON stdout.

The fixed-entrypoint `launchLocalSession` / `runCli` / `close` controller and
`with-session` flow require the user-approved installed bootstrap. Private
framing is bounded; credentials travel only in inherited
pipes and HTTP Authorization headers, never argv/environment/stdout/project
files/browser storage. A descriptor number is not authentication proof. There is
no unauthenticated bootstrap or auto-started daemon.

Exit meanings are 0 query/acceptance/success, 1 operational failure, 2 invalid
input, 3 comparison policy failure, 4 inconclusive comparison, and 5
conflict/required action. A queried Job is not necessarily completed work.
No comparison engine, live provider or browser enrollment is implemented.

## Internal framed-input protocol: synthetic evidence only

**The terminal protocol is not a production PAT entry.** `readMaskedSecret` explicitly returns
`ACTION_REQUIRED`: no concrete native dedicated-terminal/profile/confirmation
adapter is admitted. The old ordinary-TTY newline reader was unsafe because
stream chunks are not input boundaries; split multiline pastes could return a
credential prefix and leave trailing secret bytes for another reader. It is
removed, not protected with a debounce or a guessed quiet period.

The replacement is internal, not a public CLI export or command. Existing
parsing still rejects Figma credential commands, token arguments and file/stdin
alternatives. `createDedicatedSecretInputOwner` registers one opaque owner in a
private WeakMap and rejects reused/shared/encoded/buffered/non-TTY streams. Its
return value has owner-only inspection, confirmation and post-exit cleanup
controls. Input/output references are explicitly snapshotted; the required cleanup
callable is captured once and bound to the original adapter instance, including
prototype methods and private receiver state. Missing/noncallable cleanup is
rejected before input ownership. Replacing caller fields later cannot replace
the captured resources or cleanup function. Cleanup is explicitly invoked and
awaited, never supplied as an optional Promise handler that could silently skip
an absent method. Native adapters must retain their resource handles privately;
their original receiver state remains live for cleanup retries.
This establishes **protocol ownership, not native trust or terminal
support**. Current tests supply synthetic streams; no caller Boolean, structural
owner clone, environment variable or TTY check attests a supported profile.

`readMaskedSecretFromTerminal(owner, options)` incrementally consumes exactly
one `ESC[200~` / `ESC[201~` bracketed paste frame, independent of chunk boundaries.
Plain typing and CR/LF never submit. Candidate bytes are limited to 1..4096
printable ASCII bytes; multiline/control/nested-marker/overflow input clears the
entire candidate. An open rejected frame is drained through its known end marker,
with constant-size marker state and at most 8192 parsed/drained bytes total.
The original interaction deadline is at most five minutes, not reset by data.
After a byte/time bound, parsing stops and only the zeroing discard sink remains.

A complete frame produces an opaque, one-use confirmation receipt. It does not
return bytes. Confirmation is a **separate owner control-plane action**, never
dispatched from terminal characters; a literal end marker plus any pasted key
cannot authenticate physical user confirmation. Receipts cannot be forged by
copying their fields. Even after explicit confirmation, candidate bytes remain
withheld until the owner observes dedicated terminal exit and cleanup succeeds.
Any further input before exit invalidates the candidate, including a late second
paste. There is no success-shaped return of a silently truncated first line.

Cancel/EOF/deadline/input failure clears the candidate and rejects with
`SecretInputFailure`: fixed primary code, `cleanupRequired`, opaque `owner`, and
fixed `recoveryGuidance`. The same guidance is displayed without echoing input.
It directs closure/discard of the **dedicated secret-input console**, never
silent return to a normal calling shell in raw mode. An EOF or stream close alone
is not asserted to prove native terminal exit. The native owner must separately
observe its owned console/process lifecycle before calling `afterTerminalExit`;
the internal primitive additionally requires a closed/destroyed empty input
stream. No production issuer of that native observation exists in this chunk.

Until exit is observed, exactly one bounded-memory data sink discards and zeroes
subsequent chunks without buffering or further parsing beyond the budget.
Ownership, raw mode and cleanup remain explicit, even after the input promise
rejects. The owner cannot report `closed` while the input is live/queued. Cleanup
failure reports primary and cleanup codes separately, with no raw exception or
secret result; only that owner can retry release. All listeners/timers are removed
after successful post-exit cleanup. Deadline expiry is not quiescence evidence.
JavaScript strings, terminal/native copies and upstream allocation cannot be
guaranteed erased; this is not a hostile same-user input sandbox.

This terminal protocol would still need a proven dedicated-console adapter for
real use: physical confirmation, paste-marker/control handling, bounded delivery
and actual terminal exit observation. Bracketed-paste support or a mode-status
reply alone is insufficient. The separately reviewed native capture role below
instead implements an app-owned Windows masked dialog with its own lifecycle.
Synthetic terminal-owner tests and permanent `ACTION_REQUIRED` are **not**
completion of user PAT setup.
No console/dialog is spawned or displayed by this terminal primitive.

After that reviewed entry exists, its trusted owner must recheck native
principal/project/user approval and issue an at-most-30-second admin capability,
without renewing expired proof. No real PAT, vault access or agent-observed
secret prompt is part of these tests.

## Native capture credential commands

The separate `capture` bootstrap role now has a concrete app-owned Windows x64
dialog/helper/controller implementation. It is not routed through the fixture
CLI, browser/API server, or the unsupported terminal-input primitive. It requires
an independently reviewed and installed `figma-capture-v1` release, and every
command other than `--help` fails closed in an ordinary worktree or fixture
installation.

Using that release's pinned Node/bootstrap after separate user approval:

```text
launch.mjs capture project create --new [--json]
launch.mjs capture credential status --project <capture-ID> --confirm-reference <figma_pat-ID> [--json]
launch.mjs capture credential remove --project <capture-ID> --confirm-reference <figma_pat-ID> [--json]
launch.mjs capture credential setup --project <capture-ID> --confirm-reference <figma_pat-ID> --interactive
launch.mjs capture credential update --project <capture-ID> --confirm-reference <figma_pat-ID> --interactive
launch.mjs capture figma capture --project <capture-ID> --url <single-frame URL> --request-id <logical ID>
launch.mjs capture figma inspect --project <capture-ID> --request-id <logical ID>
launch.mjs capture figma convert --project <capture-ID> --request-id <logical ID>
launch.mjs capture figma artifact --project <capture-ID> --request-id <logical ID> --role <role> --output <private filename>
```

Capture/inspect/convert/artifact commands emit one closed
`NativeCaptureEnvelope`, never raw source.
Exit 0 means accepted/complete (not render readiness), exit 4 means partial,
and a failed/cancelled/interrupted result is nonzero. A completed partial job
is not relabeled full success. The same logical ID cannot change selection;
replay makes no new network call. Persisted 429 cooldown and unknown spent
effects prevent automatic retries with another ID. Inspection is metadata only;
explicit artifact export stays in the owned private project, with no arbitrary
root, overwrite, raw stdout, source upload or learned CDN allowlist.

Capture has at most four requests/30 seconds across vault/DNS/TLS/HTTP/decode/
stage/commit. Node/installed closure verification precedes that work deadline.
Default empty image origins stop after metadata/nodes/render-map with a partial
result and safe origin remediation. No URL establishes authentication or rights.
Draft conversion is source-bound to the private committed job and uses the
shared source-neutral converter, never promotion of offline asserted JSON.
Remaining actual native UI/vault/ABI/full helper latency/exact-release and
CDN-origin approval gates are not replaced by synthetic test success.

Capture cleanup no longer polls `close()` indefinitely. An unreconciled
publication or still-running original callback produces one nonzero,
contract-valid interrupted envelope with sanitized operational and cleanup
causes. Programmatic `runCaptureCommand` throws
`NativeCaptureCommandCleanupRequired`, whose `result` is that envelope and
whose idempotent `close()` retains the exact runtime/project/installation
owner for an explicit current-authorized retry. New commands are denied while
such an owner remains retained; there is no automatic network/vault retry.
The native entry prints the envelope once. Process exit only releases OS
resources: it is **not** publication recovery, secret-scrub or job-completion
proof. Private uncertain data remains; the in-memory retry owner is usable
only while its process survives. Cross-process adoption/recovery is not added
by this correction. Stored queued/claimed captures without a live admitted
executor are reported interrupted, never falsely accepted conversion/export.

### Explicit offline authorization of one next capture

`figma recover` additionally requires the exact installed recovery-policy
supplement (version-3 capture release metadata). An old capture installation,
fixture installation, copied policy or caller flag cannot authorize it. The
base capture policy/hash, project namespace and credential reference remain
unchanged; there is no project adoption or credential replacement.

First request a read-only proposal, then record the exact displayed proof:

```text
launch.mjs capture figma recover --project <capture-ID> --request-id <failed-request> --failed-job-id <failed-job> --next-request-id <next-request>
launch.mjs capture figma recover --project <capture-ID> --request-id <failed-request> --failed-job-id <failed-job> --next-request-id <next-request> --expected-proof <proposal-SHA256> --confirm AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA
```

The bounded `NativeCaptureRecoveryEnvelope` contains only logical identities,
counts, digests, confirmation text and authorization/receipt references. It
does not expose provider/node data, signed URLs, secret bytes or private paths.
`complete` means a proposal or authorization was produced, **not** that a
capture completed. No credential readiness/status/vault lookup, provider call,
capture scheduler or automatic retry is part of this action.

The confirmation acknowledges that settled accounting does not prove successful
responses, available quota, valid credentials or no network effect. Only a
stopped terminal failed attempt with resolved effects and verifiable private
stage/publication/receipt evidence qualifies. Known future Retry-After and
retry-after-unknown remain blocking. Missing/ambiguous publications, unknown or
reserved effects, unowned stages and unclassified output-root files require
separate recovery; this command never adopts or deletes them.

Authorization preserves the original failed job and binds one exact next
normalized request for the same selection, credential reference, principal,
project and policy, including the nonsecret credential-journal fingerprint.
Invoke `figma capture` separately using that next request ID and selection URL.
The successor job's atomic insertion consumes the authorization; replay never
restarts it. Exact unchanged acknowledgment replay returns the same durable
receipt, including after successor insertion. A changed target or stale proof
is refused. **Third requests remain blocked even if the authorized successor
succeeds.** Recovery chains and quota-review overrides are not implemented.

A crash before the acknowledgment receipt commits leaves no usable grant;
unowned or uncertain residue is preserved and refused. A crash after the receipt
but before successor insertion leaves authorization only, not scheduled work.
A crash after insertion does not permit a different target or an automatic
restart. Failed successors with unresolved retained publication evidence still
require separate recovery; acknowledgment replay is not permission to clear it.

Setup/update reject `--json` and require explicit `--interactive`; optional
`--expires-at <ISO timestamp>` is only a user-declared claim. There is no token
argument, environment/file/stdin route or JSON credential input. The fixed
app-owned dialog says Figma PAT, not Windows password, uses a single masked
EDIT control and no account/provider/SSO/save-checkbox controls. No CredUI or
Windows authentication operation is used.

Paste validation examines the complete bounded Unicode clipboard copy only on
the dialog's paste action (Ctrl+V or Shift+Insert), before the edit control can
normalize or truncate it. The edit context menu and copy/cut/undo are disabled.
Invalid multiline/non-ASCII/control/NUL/oversize input clears the candidate.
No clipboard polling, history lookup or clipboard alteration is performed.
The helper returns bytes only through its private binary channel after normal
owned-window cleanup; the parent withholds them until actual child close and
empty owned Job membership. It then rechecks current project/principal/action
authority before native vault use. No secret is printed or handed to an agent.

Input lifetime is at most five minutes, separate from the 30-second admin work
context. Startup and close observation initially retain the planned five-second
bounds; there is no automatic increase. Cancellation/failed cleanup retains
ownership with fixed visible recovery diagnostics. Cleanup retry never retries
a vault mutation. An interrupted command may already have changed its exact
owned entry; use a new explicitly authorized status action rather than assuming
rollback or repeating setup.

**Evidence:** a separately authorized dummy-only native check reached READY.
The user confirmed masking, multiline-paste rejection and Cancel; independent
machine evidence showed ERROR 1/CLOSED 3, confirmed scrub, normal child exit,
empty Job and exact TEMP cleanup. Earlier pre-READY and unconfirmed-timeout
attempts remain recorded failures. An isolated actual Windows byte-backend
check subsequently passed synthetic write/read equality/delete/absence through
the corrected pinned adapter, with no leftover entry. No real PAT was used.

These scoped checks are not full installed enrollment or proof of every native
path. Exact production capture release/candidate approval, fresh real private
project creation, real entry enrollment and live call authorization remain
separate user gates. Private evidence and generated test key names stay outside Git.
The existing installed fixture release/project is unchanged. Native capture
code does not establish actual Figma permission, seat or quota availability.

## Supported invocation model

An ordinary checkout can run `--help --json`, `--version --json`, `doctor --json`
and `openapi --json` without provisioning anything. Privileged local commands
require the independently approved offline release. `fixtures init` explicitly
creates its one new registered synthetic project; no other command auto-adopts
or creates a project. Missing installation returns actionable structured failure,
not an environment flag or current-worktree trust shortcut.

`with-session -- <command> ... --json` owns one service and one CLI child,
then observes shutdown. It rejects nested launchers, setup commands and `--async`
before startup. Persistent automation calls `launchLocalSession()`, awaits each
`runCli(argv)` result and finally awaits `close()`. It may use `render --async`
then `jobs get/wait/cancel`. Cold local async is rejected before submission.
`runCli` accepts no caller executable, environment, credentials or nested service;
client arguments are arrays, never a shell command string.

All logical mutations require `--request-id`; new fixture roots require `--new`,
revision updates require expected base and strong quoted content ETag, and
cancel requires the exact quoted job/version ETag. The control key is distinct
from the job's original submission key. The store owns durable deduplication;
the client performs no automatic mutation retries.

Operation/wait default and maximum are 30 seconds. Full installed startup and
owned-child observation have a separate 180-second bound; this does not enlarge
job budgets. The service's private control idle interval is three minutes, renewed
by each controller command. Transport sessions expire after five minutes without
implicit renewal. Shutdown waits for authoritative quiescence before releasing
installation ownership; incomplete cleanup is not a successful result.

For `artifacts get --output-root foundation_outputs`, the command's original
absolute deadline and cancellation signal cover metadata retrieval, content,
installed/project rechecks, policy issuance and native publication. There is no
fresh publication budget. A slow callback is awaited, not raced away while
cleanup releases its resources. A late plain callback cannot return success;
only the exact native result proven fully committed and verified within the
same command deadline may be delivered after cleanup. Expiry may leave visible
or uncertain output bytes and never implies rollback.

Service startup owns fd3 before acquiring a project. Acquisition or subsequent
startup failure always closes that channel; cleanup failures retain the primary
typed error and a close-only retry capability for acquired resources.

Controller shutdown records the fixed service's exit and teardown evidence
independently. An already-exited service does not need another exchange on a
dead pipe: release requires actual child `close` **and** either its strict final
`service_stop` / `project_synthetic` stopped envelope or one exact project-bound
stopped frame emitted after confirmed project shutdown. Truncated, duplicate,
conflicting or foreign evidence is rejected. Abnormal exit after proven
quiescence releases controller resources but remains a typed interrupted failure.
Unknown crashes and still-live children retain installation pins; Node exit or
kill-on-owner-close alone is not asserted to be renderer Job-empty evidence.
Owner-close failures are retryable without repeating the dead IPC exchange,
and successfully released resources are not closed twice.

On an error path with unavailable fd3, the service emits a single private
`DESIGNCTL_SERVICE_QUIESCENCE` record on its existing owned stderr stream only
after API teardown and acquired-project cleanup have both completed. This
bounded record is separate from public stdout, which retains the original
typed failure under the fixed `service_stop` identity and a nonzero exit.
The controller incrementally parses only that strict project/request-bound
record; arbitrary stderr is not authority and is not forwarded. Release still
requires actual child close and a matching complete failure envelope, and close
continues to report interruption rather than success. Missing, duplicated,
oversized, conflicting or truncated records do not authorize release.
Any transport failure invalidates unfinished control-frame evidence before
clearing its buffer; a later stderr record cannot rescue an invalid stream.

`preview` returns verified PNG artifact metadata with an unapproved warning;
it never launches a browser. `artifacts get` optionally writes only to
`--output-root foundation_outputs --output-relative <path>` using native verified
no-replace publication. Copying bytes out cannot enforce future server permissions.
Raw filesystem paths, imports, approval/handoff compiler, model/device commands
and browser enrollment remain absent.

See the application package README for current owner-integration blockers.
Built subprocess tests cover metadata/usage, actual Windows overlapped-pipe
credential delivery and secret-safe output on the pinned runtime. The same
HTTP client reads actual accepted revisions/jobs from the owned native facade.
The installed functional passes used real F08 entries with only disclosed copied
KnownFolder/diagnostic instrumentation, not a user-approved release. No live
installation or performance pass is claimed.
