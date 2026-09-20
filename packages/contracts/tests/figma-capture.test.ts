import { expect, it } from "vitest";
import { validateContract } from "../src/index.js";

const request = {
  schemaVersion: "1.0",
  captureId: "capture_one",
  projectId: "project_one",
  policyId: "capture_policy",
  policySha256: "a".repeat(64),
  selectionUrl:
    "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
  credential: {
    id: "credential_one",
    providerId: "figma_rest",
    store: "windows-credential-manager",
  },
};
it("adds closed native capture requests without a token or arbitrary endpoint field", () => {
  expect(validateContract("FigmaCaptureRequest", request).success).toBe(true);
  for (const extra of [
    { token: "synthetic" },
    { endpoint: "https://other.invalid" },
    { schemaVersion: 2 },
  ])
    expect(
      validateContract("FigmaCaptureRequest", { ...request, ...extra }).success,
    ).toBe(false);
});
it("keeps capture result readiness unassessed and private data in artifact references", () => {
  const result = {
    schemaVersion: "1.0",
    captureId: "capture_one",
    projectId: "project_one",
    manifest: { id: "manifest_one", sha256: "a".repeat(64) },
    completeness: "partial",
    referenceStatus: "unavailable",
    readiness: "not-evaluated",
    persistedBytes: 100,
  };
  expect(validateContract("FigmaCaptureResult", result).success).toBe(true);
  expect(
    validateContract("FigmaCaptureResult", {
      ...result,
      readiness: "implementation-ready",
    }).success,
  ).toBe(false);
  expect(
    validateContract("FigmaCaptureResult", { ...result, rawBytes: [1, 2, 3] })
      .success,
  ).toBe(false);
});
