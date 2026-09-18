# @design-studio/cli

F08 `designctl` implements one command dispatcher over the shared native
application facade or authenticated loopback API. The shipped launcher and
local fixture initialization are wired to the reviewed offline installation
verifier. The latest two retained, owned installed diagnostics produced one
complete initialization/accept/render/preview/shutdown pass and one render
observation `DEADLINE_EXCEEDED`, despite the renderer opening. This does not
establish the failed observation's final job state. Prior installed checks
intermittently took 56--60 seconds; the passing diagnostic also had a 26.6-second
startup-verification outlier. Reliable latency and the outliers' root cause
remain unresolved. See the application README for retained numerical evidence
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
The installed functional pass used real F08 entries with only disclosed copied
KnownFolder/diagnostic instrumentation, not a user-approved release. No live
installation or performance pass is claimed.
