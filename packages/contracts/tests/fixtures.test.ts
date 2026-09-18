import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseContract, validateContract } from "../src/index.js";

const fixtures = new URL(
  "../../../tests/fixtures/foundation/",
  import.meta.url,
);
const read = (path: string) => readFile(new URL(path, fixtures), "utf8");

describe("five original self-contained foundation cases", () => {
  it("validates every declared artifact, resource identity, font/asset hash and provenance", async () => {
    const manifest = parseContract(
      "FixtureManifest",
      await read("manifest.json"),
      "json",
    );
    expect(manifest.cases.map((item) => item.id)).toEqual([
      "settings-screen",
      "mixed-styled-text",
      "image-crop-transform",
      "component-variants-slots",
      "unsupported-feature",
    ]);
    for (const artifact of manifest.files) {
      const bytes = await readFile(new URL(artifact.path, fixtures));
      expect(bytes.byteLength, artifact.path).toBe(artifact.byteLength);
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.path,
      ).toBe(artifact.sha256);
    }
    for (const item of manifest.cases) {
      const design = parseContract("DesignIR", await read(item.design), "json");
      const resources = parseContract(
        "ResourceSnapshot",
        await read(item.resources),
        "json",
      );
      const provenance = parseContract(
        "ProvenanceSnapshot",
        await read(item.provenance),
        "json",
      );
      const diagnostics = parseContract(
        "DiagnosticReport",
        await read(item.diagnostics),
        "json",
      );
      expect(design.resources.snapshotId).toBe(resources.id);
      const resourceBytes = await readFile(new URL(item.resources, fixtures));
      expect(design.resources.sha256).toBe(
        createHash("sha256").update(resourceBytes).digest("hex"),
      );
      expect(provenance.projectId).toBe(design.projectId);
      expect(Object.keys(provenance.nodes)).toContain(design.root.id);
      expect(diagnostics.designId).toBe(design.designId);
      expect(item.semanticExpectations).not.toHaveLength(0);
      for (const font of resources.fonts) {
        expect(font.kind).toBe("bundled");
        expect(font.license.redistribution).toBe("permitted");
      }
      const components = new Set(
        resources.components.definitions.map(
          (definition) => `${definition.id}@${definition.version}`,
        ),
      );
      const tokenIds = new Set(
        resources.tokens.definitions.map((token) => token.id),
      );
      const assetIds = new Set(resources.assets.map((asset) => asset.id));
      const fontIds = new Set(resources.fonts.map((font) => font.id));
      const inspect = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if ("token" in value)
          expect(tokenIds.has(String(value.token))).toBe(true);
        if ("assetId" in value)
          expect(assetIds.has(String(value.assetId))).toBe(true);
        if ("fontId" in value) {
          expect(fontIds.has(String(value.fontId))).toBe(true);
          if ("fontWeight" in value) expect(value.fontWeight).toBe(400);
        }
        if ("componentReference" in value) {
          const reference = value.componentReference;
          if (
            !reference ||
            typeof reference !== "object" ||
            !("id" in reference) ||
            !("version" in reference)
          )
            throw new Error("Malformed fixture component reference.");
          expect(components.has(`${reference.id}@${reference.version}`)).toBe(
            true,
          );
        }
        for (const child of Object.values(value)) inspect(child);
      };
      inspect(design);
      inspect(resources);
      for (const definition of resources.components.definitions) {
        for (const id of definition.dependencies.fonts)
          expect(fontIds.has(id)).toBe(true);
        for (const id of definition.dependencies.tokens)
          expect(tokenIds.has(id)).toBe(true);
        for (const id of definition.dependencies.assets)
          expect(assetIds.has(id)).toBe(true);
        for (const reference of definition.dependencies.components)
          expect(components.has(`${reference.id}@${reference.version}`)).toBe(
            true,
          );
      }
      if (item.id === "unsupported-feature") {
        expect(diagnostics.readiness).toBe("blocked");
        expect(diagnostics.losses).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              support: "unsupported",
              operations: expect.arrayContaining(["editable-export"]),
            }),
          ]),
        );
      }
    }
    expect(fileURLToPath(fixtures)).toContain("foundation");
  });

  it("keeps source binding and plugin content identity distinct", async () => {
    const examples = parseContract(
      "ContractExamples",
      await read("contract-examples.json"),
      "json",
    );
    for (const example of examples.artifacts) {
      expect(
        validateContract(example.contract, example.value).success,
        example.contract,
      ).toBe(true);
    }
    expect(examples.artifacts.length).toBeGreaterThanOrEqual(14);
  });
});
