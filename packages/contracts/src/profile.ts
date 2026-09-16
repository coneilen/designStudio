import type { Budget, SemanticCase, ValidationPolicy } from "./generated.js";

export const DEFAULT_BUDGETS: Readonly<Budget> = Object.freeze({
  maxInputBytes: 26_214_400,
  maxRasterPixels: 64_000_000,
  maxExpandedNodes: 20_000,
  maxDepth: 128,
  maxSnapshotAssetBytes: 262_144_000,
  maxAttempts: 3,
  maxExternalCalls: 0,
  maxOutputBytes: 26_214_400,
  maxDurationMs: 30_000,
  maxModelTokens: 0,
  maxCostMicros: 0,
});

export const EXIT_CODES = Object.freeze({
  success: 0,
  operationalFailure: 1,
  invalidInput: 2,
  policyFailure: 3,
  inconclusive: 4,
  actionRequired: 5,
} as const);

export const MOBILE_STATIC_POLICY: Readonly<ValidationPolicy> = Object.freeze({
  schemaVersion: "1.0",
  id: "mobile-static-v1",
  pixel: {
    predicate: "max-absolute-srgb-channel-delta",
    operator: ">",
    threshold: 0.06274509803921569,
  },
  globalChangedFraction: { operator: ">", threshold: 0.01 },
  criticalChangedFraction: { operator: ">", threshold: 0.005 },
  exactGeometry: {
    operator: ">",
    threshold: 2,
    unit: "design-unit",
    evidence: "actual-view-hierarchy",
  },
  ssim: "diagnostic-only",
  calibration: "unverified",
  background: { space: "srgb", r: 1, g: 1, b: 1, a: 1 },
  maxMaskedAreaFraction: 0,
  requiredLabelsAndStates: "exact-match-when-measured",
  regionDenominator: "region-unmasked-pixels",
  missingEvidence: "inconclusive",
} satisfies ValidationPolicy);

export const SEMANTIC_CASES: readonly SemanticCase[] = [
  {
    id: "stable-identity",
    owner: "F02",
    requirement:
      "Moves/renames preserve IDs; copies get new IDs; duplicate IDs and ambiguous source matches are rejected or proposed.",
    expected:
      "Stable identity map; no index/content-derived IDs or reassignment.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "component-closure",
    owner: "F02",
    requirement:
      "Resolve typed defaults/variants/named slots, reject undeclared properties, namespace nested expansion by instance/slot paths, detect cycles and limits.",
    expected:
      "Complete pinned expansion or explicit dependency failure, independent of code mappings.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "token-resolution",
    owner: "F02",
    requirement:
      "Check token type/collection/mode/alias cycles, composite shapes and target adapters. Equal literals are only mapping proposals.",
    expected:
      "Pinned typed values or explicit unresolved diagnostics, never default modes.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "text-layout",
    owner: "F02",
    requirement:
      "Check UTF-16 ordered nonoverlapping in-bounds ranges, surrogate boundaries, frame flow, crop units and min/max; reject hug around unbounded fill.",
    expected:
      "Deterministic normal form or typed error, no truncation/zero fallback.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "canonical-content",
    owner: "F02",
    requirement:
      "Canonical UTF-8/numbers/key order, stable arrays and accepted evidence; exclude delivery paths/times without losing provenance.",
    expected:
      "Repeatable design/resource hashes, explicit migrations and semantic patches.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "provenance-authority",
    owner: "F02",
    requirement:
      "Resolve stable-node JSON pointers and evidence; manual authority supersedes inference with history; conflicting exact sources remain conflicts.",
    expected:
      "No stale authority on modified values or silent conflict resolution.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "revision-cas",
    owner: "F03",
    requirement:
      "Expected base and strong If-Match must match atomically; immutable revisions with parents; backups/migrations/recovery.",
    expected: "Stale conflict; no overwrite or partial committed artifacts.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "approval-binding",
    owner: "F03",
    requirement:
      "Append-only actor/event/waiver chain binds exact revision/resources/baseline/target/repository/scenario/policy; verify against trusted local store.",
    expected:
      "Changed material context requires new approval; embedded hashes are not authentication.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "host-boundary",
    owner: "F04",
    requirement:
      "Authenticate exact loopback Host/origin/CSRF, resource scope, process arguments, credentials, artifact roots, symlinks, Windows reserved paths and cancellation.",
    expected:
      "No wildcard core loopback grant, shell strings, secret leakage, arbitrary app execution or cross-project access.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "asset-rights-integrity",
    owner: "F05",
    requirement:
      "Verify signatures/decode/pixels/hash/bytes, sanitized derivatives and fonts/rights/glyph coverage within input/snapshot limits.",
    expected:
      "Missing or substituted fonts, unknown rights and historical fill gaps block strict readiness.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "render-evidence",
    owner: "F06",
    requirement:
      "Resolve dependencies, measure intrinsic text, equal fills and overflow, preserve transforms/clips/scroll; same capture PNG+bounds map after font/asset readiness.",
    expected:
      "Pinned offline static output or labeled degraded inspection. No goldens proved by F01.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "job-recovery",
    owner: "F07",
    requirement:
      "Persist lease/fencing/heartbeat/budgets, idempotency scope/hash, retry-after, deadlines, cancellation, receipt reconciliation and output integrity.",
    expected:
      "No exactly-once external claim; completed commit wins cancellation; unknown effects remain interrupted.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "cli-api-boundary",
    owner: "F08",
    requirement:
      "Same services, single JSON stdout object, redacted stderr, exits 0-5, noninteractive action-required, HTTP202 async job not artifact success, resource authorization.",
    expected:
      "Schema-valid response and operational versus source versus comparison states remain separate.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "handoff-compiler",
    owner: "later-integration",
    requirement:
      "Exactly Section28 artifacts, same-snapshot reference or approved edited render, transitive permitted bytes, sorted hashes/no self-cycle and staged atomic publication.",
    expected:
      "Deterministic verified offline bundle; no compiler implemented in F01.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "figma-live-contract",
    owner: "later-integration",
    requirement:
      "Pinned version reads versus plugin digest/asserted binding; missing historical fills, null renders, downscale, denied seat/plugin, 429, interrupted transport and selection changes.",
    expected:
      "Explicit unavailable/partial/source-changed outcomes; never current-fill or invented-version substitution.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "device-scenario-contract",
    owner: "later-integration",
    requirement:
      "Explicit device/server/app authority and lease; binary PNG, actual build/nonce/generation readiness before/after capture; no shared server restarts.",
    expected:
      "Wrong stable screen, unverified density/insets/fonts or failed capture never become strict comparison pass.",
    evidence: "contract-only-not-executed",
  },
  {
    id: "comparison-boundaries",
    owner: "later-integration",
    requirement:
      "Delta 15/16/17; exactly/above 1% global, 0.5% own critical-region denominator and 2 measured units; required control coverage, alpha/background, masks and seeded small defects.",
    expected:
      "Normative strict-greater predicate; SSIM diagnostic only; missing evidence or zero eligible pixels inconclusive.",
    evidence: "contract-only-not-executed",
  },
];
