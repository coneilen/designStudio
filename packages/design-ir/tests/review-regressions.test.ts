import { readFileSync } from "node:fs";
import type {
  ComponentNode,
  ComponentSnapshot,
} from "@design-studio/contracts";
import { parseContract } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  canonicalDigest,
  expandComponents,
  hashBytes,
  namespaceId,
  resolveDesign,
} from "../src/index.js";

const load = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/foundation/${name}`, import.meta.url),
    "utf8",
  );

describe("global closure artifact identity", () => {
  it.each(["descriptor-first", "reference-first"] as const)(
    "rejects inconsistent hashes with %s insertion",
    (order) => {
      const resources = parseContract(
        "ResourceSnapshot",
        load("resources.json"),
        "json",
      );
      const design = parseContract(
        "DesignIR",
        load("settings-screen.design.json"),
        "json",
      );
      const asset = resources.assets[0];
      if (!asset) throw new Error("Missing fixture asset");
      const conflicting = { id: asset.artifact.id, sha256: "0".repeat(64) };
      if (order === "descriptor-first") asset.source = conflicting;
      else design.root.metadata = { rawSource: conflicting };
      const resourceBytes = canonicalBytes(resources);
      design.resources.sha256 = hashBytes(resourceBytes);
      const result = resolveDesign(design, resources, { resourceBytes });
      expect(
        result.report.diagnostics.some((x) => x.code === "ARTIFACT_INTEGRITY"),
      ).toBe(true);
      expect(
        result.report.assessments.find((x) => x.stage === "dependency-resolved")
          ?.status,
      ).toBe("fail");
      expect(result.design).toBeUndefined();
      expect(result.closure).toBeUndefined();
    },
  );
  it("accepts consistent descriptor/reference hashes in either insertion order", () => {
    const resources = parseContract(
      "ResourceSnapshot",
      load("resources.json"),
      "json",
    );
    const design = parseContract(
      "DesignIR",
      load("settings-screen.design.json"),
      "json",
    );
    const asset = resources.assets[0];
    if (!asset) throw new Error("Missing fixture asset");
    const reference = { id: asset.artifact.id, sha256: asset.artifact.sha256 };
    asset.source = reference;
    design.root.metadata = { rawSource: reference };
    const resourceBytes = canonicalBytes(resources);
    design.resources.sha256 = hashBytes(resourceBytes);
    const result = resolveDesign(design, resources, { resourceBytes });
    expect(result.closure?.integrity).toBe("verified-bytes");
    expect(
      result.report.assessments.find((x) => x.stage === "dependency-resolved")
        ?.status,
    ).toBe("pass");
  });
});

const box = (id: string, children: ComponentNode[] = []): ComponentNode => ({
  id,
  type: "component",
  componentReference: { id: "box", version: "1" },
  layout: { width: 100, height: 100 },
  properties: {},
  slots: { children },
});
const registry = (): ComponentSnapshot => ({
  schemaVersion: "1.0",
  projectId: "project",
  revision: "1",
  mappings: [],
  definitions: [
    {
      id: "box",
      version: "1",
      properties: [],
      variants: [],
      evidenceIds: [],
      expansion: {
        id: "body",
        type: "column",
        layout: { width: 100, height: 100 },
        children: [],
      },
      slots: [
        {
          name: "children",
          targetNodeId: "body",
          insertion: "children",
          minItems: 0,
          maxItems: 2,
          allowedNodeTypes: ["component"],
        },
      ],
      dependencies: { components: [], assets: [], fonts: [], tokens: [] },
    },
  ],
});
const limits = { maxDepth: 128, maxExpandedNodes: 20_000 };

describe("finite same-component authored slots", () => {
  it("expands repeated components with stable nested slot namespaces", () => {
    const root = box("outer", [box("inner", [box("deep")])]);
    const before = canonicalDigest(root);
    const result = expandComponents(root, registry(), limits);
    const innerId = namespaceId("outer", ["slot", "children", "inner"]);
    const preScopedDeepId = namespaceId("outer", ["slot", "children", "deep"]);
    const deepId = namespaceId(innerId, ["slot", "children", preScopedDeepId]);
    expect(result.instances.map((x) => x.instanceId)).toEqual([
      "outer",
      innerId,
      deepId,
    ]);
    expect(result.root.type).toBe("column");
    expect(canonicalDigest(root)).toBe(before);
    root.name = "Renamed";
    expect(expandComponents(root, registry(), limits).instances).toEqual(
      result.instances,
    );
  });
  it.each([
    { maxDepth: 1, maxExpandedNodes: 20_000, expected: /depth/i },
    { maxDepth: 128, maxExpandedNodes: 1, expected: /node count/i },
  ])(
    "retains global budgets: $maxDepth/$maxExpandedNodes",
    ({ expected, ...budget }) => {
      expect(() =>
        expandComponents(box("outer", [box("inner")]), registry(), budget),
      ).toThrow(expected);
    },
  );
  it("still rejects genuine definition recursion", () => {
    const snapshot = registry();
    const definition = snapshot.definitions[0];
    if (!definition) throw new Error("Missing definition");
    definition.dependencies.components.push({ id: "box", version: "1" });
    definition.expansion = box("recursive");
    definition.slots = [];
    expect(() => expandComponents(box("outer"), snapshot, limits)).toThrow(
      /cycle/i,
    );
  });
  it("retains expansion budgets beyond the smaller authored slot tree", () => {
    const snapshot = registry();
    const definition = snapshot.definitions[0];
    if (!definition || !("children" in definition.expansion))
      throw new Error("Missing definition");
    definition.expansion.children.push({
      id: "decoration",
      type: "spacer",
      layout: { width: 1, height: 1 },
    });
    const root = box("outer", [box("inner")]);
    expect(() =>
      expandComponents(root, snapshot, { ...limits, maxExpandedNodes: 2 }),
    ).toThrow(/node count 3 exceeds 2/i);
    expect(() =>
      expandComponents(root, snapshot, { ...limits, maxDepth: 2 }),
    ).toThrow(/depth 3 exceeds 2/i);
  });
  it("accepts same-component nesting through a non-component authored slot root", () => {
    const snapshot = registry();
    const slot = snapshot.definitions[0]?.slots[0];
    if (!slot) throw new Error("Missing slot");
    slot.allowedNodeTypes.push("group");
    const root = box("outer");
    root.slots.children = [
      {
        id: "wrapper",
        type: "group",
        layout: { width: 100, height: 100 },
        children: [box("inner")],
      },
    ];
    const result = expandComponents(root, snapshot, limits);
    expect(result.instances.map((x) => x.instanceId)).toEqual([
      "outer",
      namespaceId("outer", ["slot", "children", "inner"]),
    ]);
  });
});
