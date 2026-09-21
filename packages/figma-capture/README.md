# @design-studio/figma-capture

## Separate one-shot reference acquisition

The reference handler consumes only a native-approved immutable capture binding,
not a fresh capture or caller URL. It reuses the existing public-DNS check, pinned
TLS peer, bundled roots, HTTP framing validation and isolated decoder. The fixed
reference origin receives no PAT, authorization header or cookies; redirects and
automatic retries are forbidden. One DNS lookup and one GET are independently
bounded by the new job's original 30-second deadline and approval expiry.

Reference limits are 25 MiB aggregate logical private input plus received network
bytes, 25 MiB output including evidence, and 6,553,600 decoded pixels (also subject
to the RGBA output bound). Storage/host verification reads retain their own
existing finite budgets. Every admission uses one attempt. Recognized SigV4
expiry can deny locally; a 403 alone is reported as denial, not asserted expiry.
Persisted observations distinguish actual HTTP status from unknown effects and
proven no-HTTP effects. Neither a successful GET nor a decoded PNG establishes
font/image-fill rights, original capture completeness or renderer readiness.

Version 0.1.0. Bounded, single-selected-FRAME REST capture core. This package
does not implement a public native capture command, converter wrapper, Figma
writes, fills/variables/libraries/history traversal, model/device actions, or
credential enrollment. It does not enable network access in an installed profile.
Those native integration and actual-use approvals remain separate.

## Trusted composition and public surface

`createFigmaCaptureJobs({ policy, authority, credentials, repository, readArtifact })`
returns one `capture` job handler, its byte-bound `verifyCompletion` hook,
`normalize`, `submit`, `readResult`, and explicit preparation release methods.
Use it with the existing JobService, LocalStore job repository, private artifact
store and real current authorization. A callback or JSON policy is not proof of
native project/installation trust. The host must provide owner-scoped job-history
discovery/read permissions and exclusively owned artifact read buffers.

The policy is snapshotted/frozen before awaits and fixes project, source,
artifact root, exact file key/node, credential reference and independently
reviewed exact image origins. Requests bind its canonical SHA-256 as well as its
logical ID. No private target is hard-coded. `normalize` validates a supported
explicit Figma selection and removes UI tracking/name data from the stored URL.
No file-only, duplicate-selector, credential-bearing or encoded-path escape is
accepted. Native credential use is delegated to the existing CredentialStore;
use the explicit capture ceilings when composing ScopedCredentialStore.

`CAPTURE_LIMITS` preserves existing byte/node/depth/duration ceilings and changes
only the capture allowance to at most four external calls and one attempt.
Supply the original absolute deadline within 30 seconds; earlier authorization
expiry wins. Every awaited operation and each effect/commit checkpoint rechecks
current authority. Required scopes include source capture, provider read,
credential use, and private artifact writes. There is no authorization fallback.

## Request sequence and HTTPS boundary

The maximum sequence is metadata, nodes pinned to metadata version V, render-map
pinned to the same V, and one uncredentialed reference PNG. Stop early on missing
version, null/non-FRAME selection, mismatched nodes version, denied/rate-limited
response or unapproved image origin. No retries, redirects, address fallback,
connection reuse, cookies, implicit decompression or whole-file/dependency crawl.
Default image origins should be empty: a valid three-response partial package
can be retained without contacting the returned CDN. Only a sanitized origin
may be emitted as remediation; signed path/query data stays private.

The transport first resolves one hostname (at most four lookups, up to 64 returned
addresses, all public), connects to exactly one selected address and verifies TLS
1.2+, certificate/expected hostname, SNI and actual normalized peer address.
Only after current authority passes is an HTTPS request/PAT header constructed.
A one-use owned `https.Agent.createConnection` returns that exact verified
TLSSocket and rechecks authority before handoff. The PAT can only be attached to
fixed constructed `https://api.figma.com` GET endpoints; the image method has no
credential argument. The native header string is transient but cannot be
cryptographically erased in JavaScript. Unsafe debug/TLS/proxy routing settings
are refused; no environment or global TLS setting is changed.

Capture trust is the approved Node release's bundled Mozilla roots, supplied
explicitly as `ca` on the pinned socket. It never inherits the process default
CA set. Admission rejects `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`,
`SSL_CERT_FILE`, `SSL_CERT_DIR` and `OPENSSL_CONF`, plus `--use-openssl-ca`,
`--use-system-ca`, `--openssl-config` and `--openssl-shared-config` in execArgv
or NODE_OPTIONS (including Node's underscore aliases). Checks precede DNS and
are repeated before connection. No override values, paths or certificates are
included in errors. Explicit bundled trust matters even after startup variables
are cleared: Node loads extra roots at process start, and thread-local default
roots can also be replaced. `--use-bundled-ca` alone does not add trust.
This follows the pinned [Node 24 TLS](https://nodejs.org/download/release/v24.21.0/docs/api/tls.html#tlsrootcertificates)
and [CLI CA-source rules](https://nodejs.org/download/release/v24.21.0/docs/api/cli.html#node_extra_ca_certsfile).
Custom enterprise/system CAs are not implicitly authorized for PAT capture.

Node's maintained parser supplies **one HTTP/1.1 message**, Content-Length or
chunked. We require semantic completion, exact declared Content-Length, no raw
duplicate/conflicting framing, no trailers, identity content encoding, one
response and no request/response/parser failure through actual request/socket
closure. The header parser limit is 16 KiB; the full raw header inventory is
checked at 64 fields with `maxHeadersCount=0` so truncation cannot hide extras.
Observed extra responses/garbage are rejected. This is **not a TLS transcript
EOF claim**: Node can close after a complete response before peer EOF, and bytes
a peer would send after local close are not observed. Node may tolerate terminal
HTTP delimiter whitespace. No socket reuse means such data cannot feed a later
request. This HTTP boundary must not be substituted for the stricter PAT IPC
terminal protocol.

Pinned Node synthetic-local-TLS probes demonstrated zero application bytes before
authorization, denial/cancel with zero bytes and observed socket closure, one
Agent handoff, CL/chunked completion, framing conflicts/truncation/trailers and
observed extra-response errors. This is not evidence of live Figma/CDN compatibility.
Production has no CA/private-IP/transport injection option. Tests mock DNS/public
address policy and the connector only within the test runner, restrict actual
connections to loopback, retain real certificate verification, and generate
ephemeral test certificates/keys in memory. No key fixture is committed.
Isolated child tests additionally load a synthetic CA through startup
NODE_EXTRA_CA_CERTS, remove that variable, and confirm ambient TLS still trusts
it while the capture socket rejects it with zero application bytes. The same
check covers replaced thread-local defaults. Only the synthetic public CA is
written to an identity-checked temporary directory; its key stays in memory.
This introduces no production CA/private-address bypass or parent-process TLS
trust mutation, and is not a live Figma compatibility claim.

## Budgets and ownership

At most 26,214,400 aggregate received TLS application bytes, decoded body bytes
and persisted output bytes (separate counters); caller-lower limits apply.
Received bytes include headers, chunk framing and observed error/extra data.
Metadata/render-map bodies are individually limited to 256 KiB. The selected
subtree is bounded to 20,000 nodes/depth 128; reference decode has a 26,214,400-byte
RGBA ceiling, hence at most 6,553,600 pixels before caller-lower bounds.

JSON/PNG parsing runs in a fixed bounded worker with the original cancellation/
deadline signal. No credential or authorization is sent as worker configuration.
The worker receives only response bytes and limits, returns JSON or raster
metadata, and clears owned bytes/RGBA. The owner awaits observed worker exit and
any termination promise before proceeding/releasing credential ownership.
Forced worker termination does not attest explicit wiping of every worker/runtime
copy; only observed exit and parent-owned cleanup are claimed on that path.
Original DNS, socket, request/write, worker and staging work are joined, not
abandoned behind Promise.race. A native callback may outlast a deadline; that is
retained work, never invented completed cleanup.

Each HTTP effect reserves/settles one external call before connection. Unknown
effects stay unknown/spent and prevent automatic replay. The existing job stage
accounting already charges persisted input/output, so network bodies are not
double-charged there. The manifest records actual network received/body counters
and persisted bytes through the manifest; the final result accounts for all
outputs including itself. No global budget is increased.

## Private evidence, completion and recovery

Successful raw JSON is UTF-8/schema bounded and checked for known credential
material (including parsed byte-array aliases) before original bytes are staged.
Decoded reference bytes are likewise checked and pinned without rewriting.
Original artifact hashes are preserved. Error bodies and raw errors/property
paths are not exposed. Redaction is defensive against known representations,
not a proof against arbitrary encoding or erasure of immutable JS strings.

The strict capture manifest records requested/returned versions and node inventory,
request outcomes, original artifacts, PNG dimensions/color evidence, missing data,
limitations and usage. A SourceSnapshot is absent without matching known source
version and valid selected frame; authenticated evidence uses `figma-rest`, never
promoted `figma-offline`. Render version mismatch is unstable, not version-pinned.
Null/missing/unsupported/downscaled/different-dimension/color-unknown references,
image fills, fonts and rights remain partial/unresolved. Successful capture is
not conversion, render or implementation readiness (`readiness: not-evaluated`).

The job's final outputs are source evidence when available, manifest and result
after raw artifacts. `verifyCompletion` requires current identical authority,
original deadline/lease/input and exact staged descriptors/hashes/bytes. A job
may complete a **partial-inspection package**; `completed` does not mean full
source/reference capture. Inspect `FigmaCaptureResult.completeness`.

Submission identity uses existing owner-scoped discovery and job idempotency.
Replaying an existing job does not use credentials or repeat network work, and
requires current source/reference/credential authority. It is past immutable
evidence, not a new upstream credential-validity check. Changing input/policy/
resources under the same capture ID is a conflict.

Validated 429 Retry-After seconds (up to one year) become persisted nextEligibleAt;
there is no scheduled retry or polling. Owned history (bounded to 1000 records)
is inspected before new effects, including after restart. An unknown retry time
requires explicit quota review; a prior spent capture lacking committed evidence
requires recovery, not a new call. The resource key serializes file/reference
capture. Existing jobs/stages/commit/checkpoint/recovery retain interrupted stages;
no new database schema, index, audit store, or silent orphan deletion is added.

Tests cover local TLS policy/lifetime, selected capture and lower limits,
private immutable stages, exact completion bytes, and real JobService/SQLite
commit/restart/cooldown/unknown-effect stage retention on an exact synthetic TEMP
root. The disk adapter in that integration test is explicitly synthetic, not
native privacy/durability proof. No real Figma, vault, UI or clipboard action was
performed. Native public capture CLI and authenticated converter integration are
the separately reviewed C2 scope.
