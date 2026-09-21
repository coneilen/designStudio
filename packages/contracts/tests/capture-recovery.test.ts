import { expect, it } from "vitest";
import { validateContract } from "../src/index.js";

it("accepts only bounded nonsecret recovery proposal facts", () => {
  const value = {
    schemaVersion: "1.0",
    projectId: "project",
    actorId: "actor",
    originalRequestId: "old_request",
    originalJobId: "old_job",
    nextRequestId: "next_request",
    nextJobId: "next_job",
    originalVersion: 4,
    originalGeneration: 1,
    proofSha256: "a".repeat(64),
    externalCalls: 2,
    responseEvidence: "unknown",
    quotaEvidence: "unknown",
    credentialValidity: "unknown",
  };
  expect(validateContract("CaptureRecoveryProposal", value).success).toBe(true);
  for (const extra of [
    { responseEvidence: "successful" },
    { quotaEvidence: "available" },
    { credentialValidity: "valid" },
    { node: { name: "private provider data" } },
    { selectionUrl: "https://private.invalid/?signed=secret" },
    { privatePath: "C:\\private\\source" },
    { originalVersion: -1 },
    { externalCalls: 5 },
  ])
    expect(
      validateContract("CaptureRecoveryProposal", { ...value, ...extra })
        .success,
    ).toBe(false);
});
