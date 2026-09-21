import { expect, it } from "vitest";
import { validateContract } from "../src/index.js";
import { DEFAULT_BUDGETS } from "../src/profile.js";

const artifact = { id: `sha256_${"a".repeat(64)}`, sha256: "a".repeat(64) };
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
