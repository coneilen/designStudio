import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ContractName, ContractTypes } from "../src/index.js";
import { parseContract, validateContract } from "../src/index.js";
import { foundationSchema } from "../src/schema.generated.js";

const fixtureRoot = new URL(
  "../../../tests/fixtures/foundation/",
  import.meta.url,
);
const examples = parseContract(
  "ContractExamples",
  await readFile(new URL("contract-examples.json", fixtureRoot), "utf8"),
  "json",
);
function example<K extends ContractName>(name: K): ContractTypes[K] {
  const source = examples.artifacts.find((item) => item.contract === name);
  if (!source) throw new Error(`Missing contract example ${name}.`);
  return parseContract(name, JSON.stringify(source.value), "json");
}

describe("public artifact contracts", () => {
  it("uses the authoritative schema unchanged at runtime, including recursive constraints", async () => {
    const source = JSON.parse(
      await readFile(
        new URL("../schemas/foundation.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(foundationSchema).toEqual(source);
  });

  it("rejects children on otherwise valid text/image leaves and component instances", async () => {
    for (const [file, index] of [
      ["settings-screen.design.json", 0],
      ["image-crop-transform.design.json", 0],
      ["settings-screen.design.json", 1],
    ] as const) {
      const design = parseContract(
        "DesignIR",
        await readFile(new URL(file, fixtureRoot), "utf8"),
        "json",
      );
      if (!("children" in design.root))
        throw new Error("Fixture root must have children.");
      const node = design.root.children[index];
      expect(validateContract("DesignNode", node).success).toBe(true);
      expect(
        validateContract("DesignNode", { ...node, children: [] }).success,
      ).toBe(false);
    }
  });
  it("requires all Section28 names, exact paths/media, and forbids alternate mappings and self-hashes", () => {
    const manifest = example("HandoffManifest");
    for (const field of Object.keys(manifest.artifacts)) {
      const artifacts: Record<string, unknown> = { ...manifest.artifacts };
      delete artifacts[field];
      expect(
        validateContract("HandoffManifest", { ...manifest, artifacts }).success,
        field,
      ).toBe(false);
    }
    expect(
      validateContract("HandoffManifest", {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          "component-mappings.json": manifest.artifacts["components.json"],
        },
      }).success,
    ).toBe(false);
    expect(
      validateContract("HandoffManifest", {
        ...manifest,
        selfHash: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      validateContract("HandoffManifest", {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          "preview.png": {
            ...manifest.artifacts["preview.png"],
            path: "other.png",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      validateContract("HandoffManifest", {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          "preview.png": {
            ...manifest.artifacts["preview.png"],
            mediaType: "text/plain",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      validateContract("HandoffManifest", { ...manifest, readiness: "ready" })
        .success,
    ).toBe(false);
  });

  it("requires job receipts, leases, errors and retry deadlines for their respective states", () => {
    const job = example("Job");
    for (const status of [
      "completed",
      "running",
      "retry-wait",
      "failed",
      "waiting-for-user",
      "interrupted",
    ]) {
      expect(validateContract("Job", { ...job, status }).success, status).toBe(
        false,
      );
    }
    expect(
      validateContract("Job", { ...job, status: "successful" }).success,
    ).toBe(false);
  });

  it("rejects bare success envelopes, mixed error/data, and payloads inconsistent with their kind", () => {
    const envelope = example("ResponseEnvelope");
    expect(
      validateContract("ResponseEnvelope", {
        schemaVersion: "1.0",
        success: true,
        requestId: "request",
        data: { warnings: [] },
      }).success,
    ).toBe(false);
    expect(
      validateContract("ResponseEnvelope", {
        ...envelope,
        error: {
          code: "INVALID_INPUT",
          message: "bad",
          retryable: false,
          diagnosticIds: [],
        },
      }).success,
    ).toBe(false);
    expect(
      validateContract("ResponseEnvelope", {
        schemaVersion: "1.0",
        success: true,
        requestId: "request",
        data: { kind: "artifact", warnings: [] },
      }).success,
    ).toBe(false);
    expect(
      validateContract("ResponseEnvelope", {
        schemaVersion: "1.0",
        success: true,
        requestId: "request",
        data: {
          kind: "accepted-job",
          jobId: "job",
          status: "completed",
          warnings: [],
        },
      }).success,
    ).toBe(false);
  });

  it("does not let a plugin capture invent a REST version or upgrade an asserted binding", () => {
    const snapshot = example("SourceSnapshot");
    expect(
      validateContract("SourceSnapshot", {
        ...snapshot,
        identity: { ...snapshot.identity, sourceVersion: "1" },
      }).success,
    ).toBe(false);
    expect(
      validateContract("SourceSnapshot", {
        ...snapshot,
        identity: {
          ...snapshot.identity,
          binding: {
            status: "verified",
            assertedUrl: "https://www.figma.com/design/synthetic/Example",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires typed token composites, strict JSON pointers, exact source/manual distinctions and explicit readiness", () => {
    expect(
      validateContract("PropertyValue", {
        type: "typography",
        value: "16px Arial",
      }).success,
    ).toBe(false);
    expect(
      validateContract("PropertyValue", {
        type: "shadow",
        value: "0 0 1px red",
      }).success,
    ).toBe(false);
    expect(validateContract("JsonPointer", "/text/~2").success).toBe(false);
    const provenance = example("HandoffMetadata").provenance;
    expect(
      validateContract("ProvenanceSnapshot", {
        ...provenance,
        nodes: { invalid: { "not-a-pointer": {} } },
      }).success,
    ).toBe(false);
    const report = example("ValidationReport");
    expect(report.status).toBe("inconclusive");
    expect(report.coverage.geometry.status).toBe("not-measured");
    expect(report).not.toHaveProperty("metrics");
    expect(
      validateContract("PixelMetrics", {
        eligiblePixels: 0,
        changedPixels: 0,
        changedFraction: 0,
        implementation: { name: "test", version: "1" },
      }).success,
    ).toBe(false);
    expect(
      validateContract("Measurement", { status: "measured", evidenceIds: [] })
        .success,
    ).toBe(false);
  });

  it("requires expected-base and strong If-Match, finite budgets and resource-specific grants", () => {
    const patch = example("SemanticPatch");
    expect(
      validateContract("SemanticPatch", {
        ...patch,
        base: { expectedBaseRevision: "r" },
      }).success,
    ).toBe(false);
    expect(
      validateContract("ExpectedBase", {
        expectedBaseRevision: "r",
        ifMatch: "*",
      }).success,
    ).toBe(false);
    const authorization = example("AuthorizationContext");
    expect(
      validateContract("AuthorizationContext", {
        ...authorization,
        grants: [
          { resourceKind: "design", resourceId: "*", operations: ["read"] },
        ],
      }).success,
    ).toBe(false);
    const job = example("Job");
    expect(
      validateContract("Budget", { ...job.budget, maxDurationMs: 0 }).success,
    ).toBe(false);
    expect(validateContract("Timestamp", "2026-02-31T00:00:00Z").success).toBe(
      false,
    );
  });

  it("pins the actual public font metadata, not an assumed version", async () => {
    const resources = parseContract(
      "ResourceSnapshot",
      await readFile(new URL("resources.json", fixtureRoot), "utf8"),
      "json",
    );
    expect(resources.fonts[0]).toMatchObject({
      kind: "bundled",
      postScriptName: "ABeeZee-Regular",
      style: "normal",
      weight: 400,
      version: "Version 1.003; ttfautohint (v1.8.3)",
      artifact: {
        byteLength: 46016,
        sha256:
          "2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9",
      },
    });
  });
});
