# Architecture

## Implemented boundary: F00

The repository contains development tooling and one private workspace harness:

```text
TypeScript source -> compiler -> ESM + declarations
       |                            |
   unit tests              public-package import
                                    |
                         offline Node process smoke
```

`fingerprintFixture(Uint8Array)` computes SHA-256 for synthetic test bytes. Its
name and package deliberately do not model product identity, approval, DesignIR,
or handoff readiness. It is not the first shared product-schema package, a CLI,
an executable locator, or a production host adapter. The root has development
dependencies only; the harness has no external runtime dependencies.

## Implemented boundary: F01

`@design-studio/contracts` is an independent shared dependency: one authoritative
draft-07 JSON Schema graph generates public schemas and TypeScript types.
Strict JSON/YAML shape validation does not resolve dependencies or confer
readiness. Provider/host interfaces and opt-in labeled test fakes allow later
packages to build independently; no production adapter is included.
Five original synthetic fixture cases include pinned OFL font and authored
image bytes. See DESIGN_IR.md for profile, authority, ownership and deferred
semantic cases. Downstream packages depend on contracts, never vice versa.

The remaining architecture is **planned**, based on specification sections 4.4,
33/33A/34, 37, and 49-56. None of the following capabilities is shipped by F00.

## Planned modular monolith and data flow

```text
Figma REST / authorized read-only plugin snapshot
                      |
             immutable source evidence
                      |
       normalization + disclosed conversion losses
                      |
        canonical DesignIR + pinned dependencies
                      |
       mappings + static render + local approval
                      |
             immutable offline handoff
                      |
       Android implementation capture / comparison
```

M1 is one local TypeScript application service with in-process deterministic
modules. The future CLI and optional read-only loopback inspection UI share that
core. Bounded workers are reserved for expensive or isolated work; logical modules
in the specification do not imply independently deployed microservices.

SQLite and local artifact storage are the planned starting model. Concrete
browser, database-binding, image/metric, font, and packaging choices require the
separate feasibility results and approval. There is no database or browser
dependency in F00. Later shared schemas must have one versioned source rather
than duplicated contracts across modules or languages.

## Planned authority, recovery, and trust

Keep source snapshots, canonical revisions, renders, approval records, and
implementation captures distinct. Approvals bind exact revisions, references,
targets, scenarios, and pinned resources. A hash alone proves none of these
relationships, and image similarity alone is not approval.

Future writes require transactional/atomic artifacts, immutable prior revisions,
explicit stale-revision conflicts, bounded retries/cancellation, and visible
partial-failure diagnostics. Retention covers source-derived caches, exports,
and traces; loss of remote source access cannot revoke already copied files.

The first local API must authenticate loopback requests, validate origins/Host,
and protect browser sessions from CSRF. Store credentials in OS secure stores,
not project files or logs. External content remains untrusted; enforce bounded
inputs, artifact-root confinement, and explicitly authorized argument-array tool
operations. No model egress is enabled by default. F00 has no server, credentials,
providers, uploads, telemetry, or external product calls.

Generated `.design`, `.design-system`, screenshots, handoffs, databases, secrets,
and caches are ignored. Reviewed synthetic/sanitized fixtures can be curated
under `tests/fixtures`; fixture exceptions do not make secrets safe to commit.

## Release and host boundaries

| Gate | Planned capability, not current implementation |
| --- | --- |
| G0 | Review F00 evidence and separate P01/P02/P03 feasibility findings before authorizing expansion. |
| M1 | Trustworthy Figma-to-handoff, manual mappings, static render/approval, and controlled Android validation on Windows and macOS. |
| M2 | AI/sketch creation, alternatives, local interactive review, and macOS iOS Simulator capture. |
| M3 | Editable Figma publishing, conflict-aware round trips, authenticated team review/sharing. |

Windows and macOS are first-class planned hosts for platform-neutral and Android
work. Native iOS Simulator execution is macOS-only; remote Mac workers and
physical iOS automation are not F00/M1 requirements. Current evidence is only the
Windows x64 bootstrap; a CI matrix is not evidence that macOS behavior passed.
