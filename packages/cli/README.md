# @design-studio/cli

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
```

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

**Evidence limit:** code, synthetic Win32/clipboard/process tests and an owned
pinned-Node/Job no-UI probe are not a real dialog or vault feasibility proof.
No real UI display, clipboard read or vault action was run during this slice.
Synthetic display validation, exact capture release/candidate approval, fresh
private project creation and real entry enrollment remain separate user gates.
The existing installed fixture release/project is unchanged. No network capture
or Figma permission/seat/quota proof is enabled.

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
