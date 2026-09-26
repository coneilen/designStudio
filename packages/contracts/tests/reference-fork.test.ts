import { expect, test } from "vitest";
import { validateContract } from "../src/index.js";

const accounting = {
  limitBytes: 26214400,
  privateBytes: 100,
  networkBytes: 0,
  phase: "inspection",
};
const artifact = {
  id: `sha256_${"a".repeat(64)}`,
  sha256: "a".repeat(64),
  path: `blobs/${"a".repeat(64)}`,
  mediaType: "application/octet-stream",
  byteLength: 10,
};
const complete = {
  schemaVersion: "1.0",
  operation: "reference-fork",
  projectId: "source",
  destinationProjectId: "destination",
  requestId: "request",
  status: "complete",
  inputAccounting: accounting,
  conversion: {
    operationId: `fork_reference_${"b".repeat(64)}`,
    origin: { id: artifact.id, sha256: artifact.sha256 },
    receiptSha256: "c".repeat(64),
    outputs: [artifact],
    artifacts: [
      "resources",
      "source-map",
      "conversion-evidence",
      "provenance",
      "report",
    ].map((role) => ({
      role,
      artifact: { id: artifact.id, sha256: artifact.sha256 },
    })),
    readiness: "needs-review",
  },
};
test("fork response is bounded reference-only output, not an origin receipt reused as destination authority", () => {
  expect(
    validateContract("NativeReferenceForkEnvelope", complete).success,
  ).toBe(true);
});
test.each([
  { ...complete, status: "failed" },
  {
    ...complete,
    error: {
      code: "ACTION_REQUIRED",
      message: "failed",
      retryable: false,
      diagnosticIds: [],
    },
  },
  { ...complete, partialDestination: "blocked-no-replay" },
  { ...complete, rawBody: "private" },
  { ...complete, conversion: { ...complete.conversion, readiness: "ready" } },
  {
    ...complete,
    conversion: { ...complete.conversion, outputs: Array(17).fill(artifact) },
  },
])("fork schema rejects inconsistent or unsafe response %j", (value) => {
  expect(validateContract("NativeReferenceForkEnvelope", value).success).toBe(
    false,
  );
});
test("partial destination is blocked without exposing a conversion proof", () => {
  const { conversion: _conversion, ...base } = complete;
  const value = {
    ...base,
    status: "failed",
    error: {
      code: "ACTION_REQUIRED",
      message: "blocked",
      retryable: false,
      diagnosticIds: [],
    },
  };
  expect(validateContract("NativeReferenceForkEnvelope", value).success).toBe(
    false,
  );
  expect(
    validateContract("NativeReferenceForkEnvelope", {
      ...value,
      partialDestination: "blocked-no-replay",
    }).success,
  ).toBe(true);
});
