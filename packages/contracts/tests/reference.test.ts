import { expect, it } from "vitest";
import { referenceDiagnosticFields, validateContract } from "../src/index.js";
import { DEFAULT_BUDGETS } from "../src/profile.js";

const artifact = { id: `sha256_${"a".repeat(64)}`, sha256: "a".repeat(64) };
it("keeps legacy source proof reasons and the additional metadata phase closed", () => {
  const envelope = {
    schemaVersion: "1.0",
    operation: "reference-recovery-plan",
    projectId: "synthetic",
    requestId: "original",
    status: "failed",
  };
  for (const reason of ["source-proof-invalid", "source-metadata-invalid"])
    expect(
      validateContract("NativeReferenceRecoveryPlanEnvelope", {
        ...envelope,
        reason,
      }).success,
    ).toBe(true);
  for (const detail of [
    { reason: "native ACL text" },
    { reason: "source-metadata-invalid", path: "private" },
    { reason: "source-metadata-invalid", sid: "private" },
    { reason: "source-metadata-invalid", acl: "private" },
  ])
    expect(
      validateContract("NativeReferenceRecoveryPlanEnvelope", {
        ...envelope,
        ...detail,
      }).success,
    ).toBe(false);
});

it("keeps retained-byte plans closed and distinct from recovered acquisition receipts", () => {
  const stage = {
    role: "evidence",
    sha256: artifact.sha256,
    byteLength: 128,
    disposition: "recovery-needed",
    publication: "published-only",
  };
  const plan = {
    verification: "retained-bytes",
    eligibility: "eligible-for-recovery-review",
    consumed: true,
    historicalStatus: "interrupted",
    jobId: "diagnostic_synthetic",
    jobSha256: artifact.sha256,
    stateSha256: artifact.sha256,
    identitySha256: artifact.sha256,
    sourceSha256: artifact.sha256,
    approvalSha256: artifact.sha256,
    policySha256: artifact.sha256,
    proofSha256: artifact.sha256,
    referenceStatus: "complete",
    pixelWidth: 2,
    pixelHeight: 2,
    colorSpace: "srgb",
    stages: [stage, { ...stage, role: "reference" }],
  };
  expect(validateContract("ReferenceRecoveryPlan", plan).success).toBe(true);
  for (const bad of [
    { ...plan, bytes: "private" },
    { ...plan, url: "private" },
    { ...plan, receipt: {} },
    { ...plan, eligibility: "recovered" },
    { ...plan, historicalStatus: "completed" },
    { ...plan, consumed: false },
    { ...plan, pixelWidth: 6553601 },
    { ...plan, stages: [stage] },
    { ...plan, stages: [stage, stage, stage] },
    { ...plan, stages: [{ ...stage, path: "private" }, stage] },
    {
      ...plan,
      stages: [
        { ...stage, publication: "known-pair-native-read-blocked" },
        stage,
      ],
    },
  ])
    expect(validateContract("ReferenceRecoveryPlan", bad).success).toBe(false);
});
it("closes diagnostic job metadata and input accounting against payloads and oversized projections", () => {
  const usage = {
    inputBytes: 0,
    outputBytes: 128,
    externalCalls: 1,
    modelTokens: 0,
    costMicros: 0,
  };
  const effect = {
    id: "reference-image-get",
    state: "unknown",
    reserved: usage,
  };
  const stage = {
    sha256: artifact.sha256,
    byteLength: 128,
    disposition: "retained",
  };
  const metadata = {
    verification: "metadata-only",
    jobId: "diagnostic_synthetic",
    jobSha256: artifact.sha256,
    status: "interrupted",
    attempt: 1,
    errorCode: "INPUT_LIMIT",
    usage,
    effects: [effect],
    stages: [stage],
    receiptPresent: false,
  };
  expect(validateContract("ReferenceJobMetadata", metadata).success).toBe(true);
  for (const bad of [
    { ...metadata, url: "private" },
    { ...metadata, attempt: 2 },
    { ...metadata, effects: [effect, effect] },
    { ...metadata, stages: [stage, stage, stage] },
    { ...metadata, usage: { ...usage, networkBody: "private" } },
    { ...metadata, effects: [{ ...effect, response: "private" }] },
    { ...metadata, effects: [{ ...effect, id: "private-effect-name" }] },
    { ...metadata, stages: [{ ...stage, path: "private" }] },
    { ...metadata, stages: [{ ...stage, byteLength: 26214401 }] },
  ])
    expect(validateContract("ReferenceJobMetadata", bad).success).toBe(false);
  const accounting = {
    limitBytes: 26214400,
    privateBytes: 26214400,
    networkBytes: 0,
    phase: "inspection",
    rejected: {
      kind: "private",
      bytes: 1,
      limit: "aggregate",
      phase: "commit",
    },
  };
  expect(validateContract("ReferenceInputAccounting", accounting).success).toBe(
    true,
  );
  for (const bad of [
    { ...accounting, privateBytes: 26214401 },
    { ...accounting, phase: "private-path" },
    { ...accounting, rejected: { ...accounting.rejected, text: "private" } },
  ])
    expect(validateContract("ReferenceInputAccounting", bad).success).toBe(
      false,
    );
});
it("accepts only closed nonsecret diagnostics and leaves legacy absence untouched", () => {
  const legacy = {
    code: "INVALID_INPUT",
    message: "legacy",
    retryable: false,
    diagnosticIds: [],
  };
  expect(validateContract("ContractError", legacy).success).toBe(true);
  expect(referenceDiagnosticFields(legacy)).toEqual({});
  const diagnostic = {
    stage: "png",
    reason: "png-malformed",
    mimeClass: "generic-binary",
  };
  expect(
    validateContract("ContractError", {
      ...legacy,
      referenceDiagnostic: diagnostic,
    }).success,
  ).toBe(true);
  for (const bad of [
    { ...diagnostic, reason: "private exception text" },
    { ...diagnostic, mimeClass: "image/png;private=header" },
    { ...diagnostic, stage: "https://private.invalid/query" },
    { ...diagnostic, message: "private PNG text" },
  ]) {
    expect(validateContract("ReferenceDiagnostic", bad).success).toBe(false);
    expect(referenceDiagnosticFields({ referenceDiagnostic: bad })).toEqual({});
  }
});
const proposal = {
  schemaVersion: "1.0",
  format: "figma-reference-proposal-v1",
  approvalGeneration: 0,
  capturePolicySha256: "b".repeat(64),
  referencePolicySha256: "c".repeat(64),
  limits: DEFAULT_BUDGETS,
  proofSha256: "d".repeat(64),
  limitations: [],
  binding: {
    projectId: "project_synthetic",
    actorId: "actor_synthetic",
    originalRequestId: "original",
    originalJobId: "capture_synthetic",
    originalRecordSha256: "e".repeat(64),
    originalReceiptSha256: "f".repeat(64),
    request: artifact,
    source: artifact,
    manifest: artifact,
    result: artifact,
    nodes: artifact,
    renderMap: artifact,
    fileKey: "SyntheticFile",
    nodeId: "1:2",
    sourceVersion: "v1",
    bounds: { x: 0, y: 0, width: 2, height: 2, unit: "design-unit" },
    scale: 1,
    origin: "https://figma-alpha-api.s3.us-west-2.amazonaws.com",
    acquisitionId: "reference_synthetic",
  },
};
it("closes reference proof/approval schemas against URL/path/policy flags and foreign origins", () => {
  expect(validateContract("FigmaReferenceProposal", proposal).success).toBe(
    true,
  );
  for (const extra of [
    { url: "https://foreign.invalid/x" },
    { path: "private.json" },
    { approved: true },
  ])
    expect(
      validateContract("FigmaReferenceProposal", { ...proposal, ...extra })
        .success,
    ).toBe(false);
  for (const origin of ["https://foreign.invalid", "https://*.amazonaws.com"])
    expect(
      validateContract("FigmaReferenceProposal", {
        ...proposal,
        binding: { ...proposal.binding, origin },
      }).success,
    ).toBe(false);
  expect(
    validateContract("FigmaReferenceProposal", {
      ...proposal,
      approvalGeneration: 32,
    }).success,
  ).toBe(false);
  const approval = {
    schemaVersion: "1.0",
    proposal,
    confirmation: "APPROVE-ONE-SELECTED-REFERENCE",
    recordedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
  };
  expect(validateContract("FigmaReferenceApproval", approval).success).toBe(
    true,
  );
  expect(
    validateContract("FigmaReferenceApproval", {
      ...approval,
      confirmation: "yes",
    }).success,
  ).toBe(false);
});
