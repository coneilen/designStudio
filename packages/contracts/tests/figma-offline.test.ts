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
