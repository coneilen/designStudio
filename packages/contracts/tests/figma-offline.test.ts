import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  contractNames,
  parseContract,
  validateContract,
} from "../src/index.js";

const identity = {
  transport: "figma-offline",
  intakeId: "intake_original_test",
  contentDigest: "a".repeat(64),
  binding: {
    status: "asserted",
    assertedUrl:
      "https://www.figma.com/design/SyntheticFixture/Original?node-id=1-2",
    actorId: "actor_test",
  },
};
it("keeps readonly conversion inspection states closed and readiness non-renderable", () => {
  const proof = {
    inspectionPolicySha256: "a".repeat(64),
    recoveryPolicySha256: "b".repeat(64),
    recoveryId: "recovery",
    recoveryReceiptSha256: "c".repeat(64),
    originalJobSha256: "d".repeat(64),
    originalStateSha256: "e".repeat(64),
    identitySha256: "f".repeat(64),
    controlSha256: "0".repeat(64),
    proofSha256: "1".repeat(64),
  };
  const conversion = {
    operationId: "conversion",
    receiptSha256: "2".repeat(64),
    evidence: { id: "evidence", sha256: "3".repeat(64) },
    readiness: "needs-review",
  };
  for (const value of [
    {
      verification: "conversion-readonly-v1",
      state: "blocked",
      detail: "verification-incomplete",
    },
    {
      verification: "conversion-readonly-v1",
      state: "incomplete",
      detail: "no-conversion-intent-observed",
      proof,
    },
    {
      verification: "conversion-readonly-v1",
      state: "incomplete",
      detail: "conversion-intent-without-committed-receipt",
      proof,
    },
    {
      verification: "conversion-readonly-v1",
      state: "committed",
      proof,
      conversion,
    },
  ])
    expect(
      validateContract("ReferenceConversionInspection", value).success,
    ).toBe(true);
  for (const value of [
    {
      verification: "conversion-readonly-v1",
      state: "blocked",
      detail: "verification-incomplete",
      proof,
    },
    {
      verification: "conversion-readonly-v1",
      state: "incomplete",
      detail: "no-conversion-intent-observed",
      proof,
      conversion,
    },
    { verification: "conversion-readonly-v1", state: "committed", proof },
    {
      verification: "conversion-readonly-v1",
      state: "committed",
      proof,
      conversion: { ...conversion, readiness: "ready" },
    },
    {
      verification: "conversion-readonly-v1",
      state: "committed",
      proof,
      conversion,
      privateText: "forbidden",
    },
  ])
    expect(
      validateContract("ReferenceConversionInspection", value).success,
    ).toBe(false);
});

it("limits retained proof diagnostics to failed blocked inspection and existing closed fields", () => {
  const base = {
    schemaVersion: "1.0",
    operation: "reference-conversion-inspect",
    projectId: "synthetic",
    requestId: "original",
    status: "failed",
    reason: "integrity",
    error: {
      code: "ACTION_REQUIRED",
      message: "Closed failure.",
      retryable: false,
      diagnosticIds: [],
    },
    inspection: {
      verification: "conversion-readonly-v1",
      state: "blocked",
      detail: "verification-incomplete",
    },
  };
  for (const diagnostic of [
    { stage: "ineligible-job" },
    { stage: "inventory-invalid" },
    {
      stage: "inventory-invalid",
      inventoryFailure: {
        check: "publication-shape",
        category: "history-stage",
        detail: "unproven-history-coexistence",
      },
    },
    {
      stage: "inventory-invalid",
      inventoryFailure: {
        check: "committed-size",
        category: "committed-inventory",
      },
    },
  ]) {
    const value = {
      ...base,
      inspection: { ...base.inspection, diagnostic },
    };
    expect(
      validateContract("NativeReferenceOfflineEnvelope", value).success,
    ).toBe(true);
    for (const status of ["complete", "cancelled", "interrupted"])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", { ...value, status })
          .success,
      ).toBe(false);
    for (const code of [
      "CANCELLED",
      "DEADLINE_EXCEEDED",
      "FORBIDDEN",
      "INTERRUPTED",
    ])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", {
          ...value,
          error: { ...value.error, code },
        }).success,
      ).toBe(false);
    for (const operation of ["reference-recovery-inspect", "convert-reference"])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", {
          ...value,
          operation,
        }).success,
      ).toBe(false);
  }
  for (const diagnostic of [
    { stage: "private-path" },
    { stage: "inventory-invalid", path: "private" },
    { stage: "inventory-invalid", message: "private" },
    {
      stage: "ineligible-job",
      inventoryFailure: { check: "body-hash", category: "retained-target" },
    },
    {
      stage: "inventory-invalid",
      inventoryFailure: {
        check: "publication-shape",
        category: "namespace",
        detail: "orphan-stage",
      },
    },
  ])
    expect(
      validateContract("NativeReferenceOfflineEnvelope", {
        ...base,
        inspection: { ...base.inspection, diagnostic },
      }).success,
    ).toBe(false);
  expect(validateContract("NativeReferenceOfflineEnvelope", base).success).toBe(
    true,
  );
  expect(
    validateContract("NativeReferenceOfflineEnvelope", {
      schemaVersion: "1.0",
      operation: "reference-recovery-apply-plan",
      projectId: "synthetic",
      requestId: "original",
      status: "complete",
    }).success,
  ).toBe(true);
});

it("closes five direct refusal tags without accepting application/host conflation or stale diagnostics", () => {
  const envelope = (diagnostic: object) => ({
    schemaVersion: "1.0",
    operation: "reference-conversion-inspect",
    projectId: "synthetic",
    requestId: "original",
    status: "failed",
    reason: "integrity",
    error: {
      code: "ACTION_REQUIRED",
      message: "Closed failure.",
      retryable: false,
      diagnosticIds: [],
    },
    inspection: {
      verification: "conversion-readonly-v1",
      state: "blocked",
      detail: "verification-incomplete",
      diagnostic,
    },
  });
  for (const check of [
    "scan-blob-classification",
    "scan-stage-classification",
    "scan-root-entry-classification",
  ]) {
    const inventoryFailure = { check, category: "namespace" };
    expect(
      validateContract("RetainedInventoryFailure", inventoryFailure).success,
    ).toBe(true);
    expect(
      validateContract(
        "NativeReferenceOfflineEnvelope",
        envelope({ stage: "inventory-invalid", inventoryFailure }),
      ).success,
    ).toBe(true);
    for (const extra of [
      { category: "committed-inventory" },
      { detail: "missing-stage-or-entry" },
      { path: "private" },
    ])
      expect(
        validateContract("RetainedInventoryFailure", {
          ...inventoryFailure,
          ...extra,
        }).success,
      ).toBe(false);
    expect(
      validateContract("NativeReferenceRecoveryPlanEnvelope", {
        schemaVersion: "1.0",
        operation: "reference-recovery-plan",
        projectId: "synthetic",
        requestId: "original",
        status: "failed",
        reason: "inventory-invalid",
        error: envelope({}).error,
        inventoryFailure,
      }).success,
    ).toBe(true);
  }
  for (const publicationCheck of [
    "pending-stages-without-capture-recovery-binding",
    "pending-stage-provenance-mismatch",
  ]) {
    const diagnostic = { stage: "inventory-invalid", publicationCheck };
    expect(
      validateContract("RetainedPublicationCheck", publicationCheck).success,
    ).toBe(true);
    const value = envelope(diagnostic);
    expect(
      validateContract("NativeReferenceOfflineEnvelope", value).success,
    ).toBe(true);
    for (const status of ["complete", "cancelled", "interrupted"])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", { ...value, status })
          .success,
      ).toBe(false);
    for (const code of [
      "ARTIFACT_INTEGRITY",
      "CANCELLED",
      "DEADLINE_EXCEEDED",
      "FORBIDDEN",
      "INTERRUPTED",
    ])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", {
          ...value,
          error: { ...value.error, code },
        }).success,
      ).toBe(false);
    for (const invalid of [
      { ...diagnostic, stage: "source-proof-invalid" },
      {
        ...diagnostic,
        inventoryFailure: {
          check: "scan-stage-classification",
          category: "namespace",
        },
      },
      { ...diagnostic, message: "private" },
      { ...diagnostic, publicationCheck: "specific-private-field" },
    ])
      expect(
        validateContract("NativeReferenceOfflineEnvelope", envelope(invalid))
          .success,
      ).toBe(false);
    expect(
      validateContract("NativeReferenceOfflineEnvelope", {
        ...value,
        reason: "cleanup-required",
      }).success,
    ).toBe(false);
  }
});

it.each([
  "figma-offline-fixed-v1",
  "figma-structure-fixed-v1",
  "figma-offline-fixed-v2",
  "figma-structure-fixed-v2",
])("accepts the explicitly versioned conversion adapter %s", (adapter) => {
  const evidence = {
    schemaVersion: "1.0",
    adapter,
    source: { id: "raw_synthetic", sha256: "a".repeat(64) },
    entries: [],
    ignoredProperties: [],
  };
  expect(validateContract("FigmaConversionEvidence", evidence).success).toBe(
    true,
  );
  expect(
    validateContract("FigmaConversionEvidence", {
      ...evidence,
      adapter: "figma-structure-fixed-unrecognized",
    }).success,
  ).toBe(false);
});

it("represents unknown-version offline evidence without inventing a provider identity", () => {
  expect(validateContract("SourceIdentity", identity).success).toBe(true);
  expect(
    validateContract("SourceIdentity", {
      ...identity,
      declaredTransport: "figma-rest",
      declaredSourceVersion: "declared-not-verified",
    }).success,
  ).toBe(true);
  expect(
    validateContract("SourceIdentity", { ...identity, sourceVersion: "fake" })
      .success,
  ).toBe(false);
  expect(
    validateContract("SourceIdentity", {
      ...identity,
      binding: {
        status: "verified",
        fileKey: "SyntheticFixture",
        nodeId: "1:2",
        evidenceId: "self",
      },
    }).success,
  ).toBe(false);
});

it("does not weaken existing REST and plugin identity requirements", () => {
  expect(
    validateContract("SourceIdentity", {
      transport: "figma-rest",
      fileKey: "SyntheticFixture",
      nodeId: "1:2",
    }).success,
  ).toBe(false);
  expect(
    validateContract("SourceIdentity", {
      transport: "figma-rest",
      fileKey: "SyntheticFixture",
      nodeId: "1:2",
      sourceVersion: "V",
    }).success,
  ).toBe(true);
  expect(
    validateContract("SourceIdentity", {
      transport: "figma-plugin",
      sessionId: "session",
      captureId: "capture",
      contentDigest: "a".repeat(64),
      binding: { status: "unknown", reason: "No binding" },
      delivery: "snapshot-file",
    }).success,
  ).toBe(true);
});

it("exposes closed intake inventory without authorization or readiness claims", () => {
  const manifest = {
    schemaVersion: "1.0",
    format: "figma-rest-nodes-v1",
    selectionUrl: identity.binding.assertedUrl,
    structure: {
      id: "raw",
      path: "raw.json",
      mediaType: "application/json",
      byteLength: 5,
      sha256: "a".repeat(64),
    },
    assets: [],
    fonts: [],
  };
  expect(validateContract("FigmaIntakeManifest", manifest).success).toBe(true);
  for (const extra of [
    { grants: [] },
    { approved: true },
    { projectId: "other" },
  ])
    expect(
      validateContract("FigmaIntakeManifest", { ...manifest, ...extra })
        .success,
    ).toBe(false);
});

it("treats third-party schemaVersion only as generic data, never artifact authority", () => {
  for (const name of ["JsonObject", "JsonValue"] as const) {
    const value = parseContract(
      name,
      '{"schemaVersion":42,"nodes":{}}',
      "json",
    );
    expect(value).toEqual({ schemaVersion: 42, nodes: {} });
    expect(validateContract("SourceSnapshot", value).success).toBe(false);
    expect(validateContract("DesignIR", value).success).toBe(false);
    expect(validateContract("AuthorizationContext", value).success).toBe(false);
  }
});

it.each(
  contractNames.filter((name) => name !== "JsonObject" && name !== "JsonValue"),
)("keeps the unsupported-version boundary on named contract %s", (name) => {
  const result = validateContract(name, { schemaVersion: "2.0" });
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Unexpected version acceptance.");
  expect(result.issues[0]?.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
});

const examples = parseContract(
  "ContractExamples",
  await readFile(
    new URL(
      "../../../tests/fixtures/foundation/contract-examples.json",
      import.meta.url,
    ),
    "utf8",
  ),
  "json",
);
it.each(examples.artifacts)(
  "retains required versions and strict fields for materialized $contract examples",
  ({ contract, value }) => {
    const named = contractNames.find((name) => name === contract);
    if (!named || !value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Missing named example.");
    expect(validateContract(named, value).success).toBe(true);
    const missing = { ...value };
    delete missing.schemaVersion;
    expect(validateContract(named, missing).success).toBe(false);
    expect(
      validateContract(named, { ...value, schemaVersion: "2.0" }).success,
    ).toBe(false);
    expect(
      validateContract(named, { ...value, fabricatedAuthority: true }).success,
    ).toBe(false);
  },
);
