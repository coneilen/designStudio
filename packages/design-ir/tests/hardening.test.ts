import { readFileSync } from "node:fs";
import type {
  ComponentNode,
  DesignNode,
  ProvenanceEntry,
  ProvenanceSnapshot,
  TokenSnapshot,
} from "@design-studio/contracts";
import { parseContract } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  expandComponents,
  reconcileProvenance,
  resolveDesign,
  resolveTokens,
  updateProvenance,
  validateProvenance,
} from "../src/index.js";

const load = (file: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/foundation/${file}`, import.meta.url),
  );
const resources = () =>
  parseContract("ResourceSnapshot", load("resources.json").toString(), "json");
const design = () =>
  parseContract(
    "DesignIR",
    load("unsupported-feature.design.json").toString(),
    "json",
  );
const leaf: DesignNode = {
  id: "local",
  type: "spacer",
  layout: { width: 1, height: 1 },
};

describe("resource closure and bounded expansion", () => {
  it("includes preserved raw evidence references in the dependency closure", () => {
    const d = design();
    const result = resolveDesign(d, resources(), {
      resourceBytes: load("resources.json"),
    });
    expect(result.closure?.references).toContainEqual({
      id: "source_unsupported",
      sha256:
        "4486c69719ac419db30afa27826f1cb0774ada1ac86e22f215cbfc4867167dd6",
    });
  });
  it("rejects nonfinite public expansion budgets before visiting nodes", () => {
    const r = resources();
    expect(() =>
      expandComponents(leaf, r.components, {
        maxDepth: NaN,
        maxExpandedNodes: Infinity,
      }),
    ).toThrow(/budget/i);
  });
  it("rejects unmatched variants instead of inventing a visual fallback", () => {
    const r = resources();
    const def = r.components.definitions[0];
    if (!def) throw new Error("fixture");
    const node: ComponentNode = {
      id: "instance",
      type: "component",
      componentReference: { id: def.id, version: def.version },
      layout: { width: 100, height: 100 },
      properties: {
        title: { type: "string", value: "test" },
        checked: { type: "boolean", value: false },
        disabled: { type: "boolean", value: true },
      },
      slots: {},
    };
    expect(() =>
      expandComponents(node, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/variant/i);
  });
  it("requires slots on a snapshot-only instance to be completely absent", () => {
    const r = resources();
    r.components.definitions = [];
    r.components.mappings = [];
    const node: ComponentNode = {
      id: "snapshot",
      type: "component",
      componentReference: { id: "unknown", version: "1" },
      layout: { width: 1, height: 1 },
      properties: {},
      slots: { unknown: [] },
      snapshotExpansion: {
        kind: "snapshot-only",
        source: { id: "source", sha256: "0".repeat(64) },
        editableProperties: [],
        root: leaf,
      },
    };
    expect(() =>
      expandComponents(node, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/snapshot-only/i);
  });
  it("retains instance accessibility and behavior when an expansion root initially omits them", () => {
    const r = resources();
    r.components.mappings = [];
    r.components.definitions = [
      {
        id: "visual",
        version: "1",
        expansion: { ...leaf, type: "shape", shape: "rectangle" },
        variants: [],
        properties: [],
        slots: [],
        dependencies: { tokens: [], assets: [], fonts: [], components: [] },
        evidenceIds: [],
      },
    ];
    const node: ComponentNode = {
      id: "instance",
      type: "component",
      componentReference: { id: "visual", version: "1" },
      layout: { width: 1, height: 1 },
      properties: {},
      slots: {},
      accessibility: {
        role: "button",
        label: "Action",
        evidence: "declared-intent",
      },
      behavior: { critical: true, intent: "none", status: "reviewed" },
    };
    const expanded = expandComponents(node, r.components, {
      maxDepth: 128,
      maxExpandedNodes: 20_000,
    });
    expect(expanded.root).toMatchObject({
      accessibility: node.accessibility,
      behavior: node.behavior,
    });
  });
  it("applies definition semantics as root defaults before visual bindings", () => {
    const r = resources();
    r.components.mappings = [];
    r.components.definitions = [
      {
        id: "visual",
        version: "1",
        expansion: { ...leaf, type: "shape", shape: "rectangle" },
        accessibility: {
          role: "button",
          label: "Definition action",
          evidence: "declared-intent",
        },
        variants: [],
        properties: [],
        slots: [],
        dependencies: { tokens: [], assets: [], fonts: [], components: [] },
        evidenceIds: [],
      },
    ];
    const node: ComponentNode = {
      id: "instance",
      type: "component",
      componentReference: { id: "visual", version: "1" },
      layout: { width: 1, height: 1 },
      properties: {},
      slots: {},
    };
    expect(
      expandComponents(node, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }).root,
    ).toMatchObject({
      accessibility: r.components.definitions[0]?.accessibility,
    });
  });
  it("accounts for long transitive depths independently of registry array order", () => {
    const r = resources();
    r.components.mappings = [];
    r.components.definitions = ["a", "b", "c"].map((id, index) => ({
      id,
      version: "1",
      expansion: { ...leaf, id },
      variants: [],
      properties: [],
      slots: [],
      evidenceIds: [],
      dependencies: {
        components: index
          ? [{ id: index === 1 ? "a" : "b", version: "1" }]
          : [],
        tokens: [],
        assets: [],
        fonts: [],
      },
    }));
    expect(() =>
      expandComponents(leaf, r.components, {
        maxDepth: 2,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/depth/i);
  });
  it("rejects replacement slots that discard another declared slot anchor", () => {
    const r = resources();
    r.components.mappings = [];
    r.components.definitions = [
      {
        id: "visual",
        version: "1",
        properties: [],
        variants: [],
        evidenceIds: [],
        dependencies: { tokens: [], assets: [], fonts: [], components: [] },
        expansion: {
          id: "root",
          type: "group",
          layout: { width: 10, height: 10 },
          children: [
            {
              id: "outer",
              type: "group",
              layout: { width: 10, height: 10 },
              children: [
                {
                  id: "inner",
                  type: "group",
                  layout: { width: 10, height: 10 },
                  children: [],
                },
              ],
            },
          ],
        },
        slots: [
          {
            name: "replacement",
            targetNodeId: "outer",
            insertion: "replace",
            minItems: 0,
            maxItems: 1,
            allowedNodeTypes: ["shape"],
          },
          {
            name: "discarded",
            targetNodeId: "inner",
            insertion: "children",
            minItems: 0,
            maxItems: 1,
            allowedNodeTypes: ["shape"],
          },
        ],
      },
    ];
    expect(() =>
      expandComponents(leaf, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/anchor/i);
  });
  it("rejects multiple bindings competing for one destination", () => {
    const r = resources();
    const def = r.components.definitions[0];
    if (!def) throw new Error("fixture");
    if (!("bindings" in def.expansion)) throw new Error("fixture");
    def.expansion.bindings = [
      { property: "checked", target: "accessibility.state.checked" },
      { property: "disabled", target: "accessibility.state.checked" },
    ];
    expect(() =>
      expandComponents(leaf, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/binding/i);
  });
  it("rejects unowned visual bindings on ordinary authored nodes", () => {
    const r = resources();
    const node: DesignNode = {
      id: "shape",
      type: "shape",
      shape: "rectangle",
      layout: { width: 1, height: 1 },
      bindings: [{ property: "unknown", target: "appearance.opacity" }],
    };
    expect(() =>
      expandComponents(node, r.components, {
        maxDepth: 128,
        maxExpandedNodes: 20_000,
      }),
    ).toThrow(/binding/i);
  });
  it("retains complete snapshot visuals when code mappings cannot resolve the absent library", () => {
    const r = resources();
    r.components.definitions = [];
    const d = design();
    d.root = {
      id: "snapshot",
      type: "component",
      componentReference: { id: "settings-toggle-row", version: "1" },
      layout: { width: 1, height: 1 },
      properties: {},
      slots: {},
      snapshotExpansion: {
        kind: "snapshot-only",
        source: { id: "source", sha256: "0".repeat(64) },
        editableProperties: [],
        root: leaf,
      },
    };
    const result = resolveDesign(d, r);
    expect(result.design).toBeDefined();
    expect(result.instances[0]?.mode).toBe("snapshot-only");
    expect(
      result.report.diagnostics.some((x) => x.code === "MAPPING_STALE"),
    ).toBe(true);
  });
});

describe("provenance and dictionary edge cases", () => {
  it("allows stable constructor IDs without mutating inherited objects", () => {
    const d = design();
    d.root = { ...leaf, id: "constructor" };
    const p: ProvenanceSnapshot = {
      schemaVersion: "1.0",
      id: "p",
      projectId: d.projectId,
      designId: d.designId,
      nodes: {},
      evidence: [
        {
          id: "e",
          kind: "manual-decision",
          artifact: { id: "source", sha256: "0".repeat(64) },
        },
      ],
      history: [],
    };
    const e: ProvenanceEntry = {
      id: "e1",
      type: "manual-edit",
      authority: "manual",
      evidenceIds: ["e"],
      acceptedAt: "2026-01-01T00:00:00Z",
      supersedes: [],
    };
    const next = updateProvenance(p, "constructor", "/layout/width", e);
    expect(Object.hasOwn(next.nodes, "constructor")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(Object, "/layout/width"),
    ).toBeUndefined();
  });
  it("checks external source pointers for historical as well as active evidence", () => {
    const d = design();
    d.root = leaf;
    const p: ProvenanceSnapshot = {
      schemaVersion: "1.0",
      id: "p",
      projectId: d.projectId,
      designId: d.designId,
      nodes: {},
      evidence: [
        {
          id: "e",
          kind: "manual-decision",
          pointer: "/missing",
          artifact: { id: "source", sha256: "0".repeat(64) },
        },
      ],
      history: [
        {
          id: "past",
          type: "manual-edit",
          authority: "manual",
          evidenceIds: ["e"],
          acceptedAt: "2026-01-01T00:00:00Z",
          supersedes: [],
        },
      ],
    };
    expect(() => validateProvenance(d, p, () => ({ actual: 1 }))).toThrow(
      /pointer/i,
    );
  });
  it("reports contradictory exact-source histories rather than silently accepting supersession", () => {
    const d = design();
    d.root = leaf;
    const old: ProvenanceEntry = {
      id: "old",
      type: "figma-exact",
      authority: "exact-source",
      evidenceIds: ["a"],
      acceptedAt: "2026-01-01T00:00:00Z",
      supersedes: [],
    };
    const next: ProvenanceEntry = {
      ...old,
      id: "new",
      evidenceIds: ["b"],
      supersedes: ["old"],
    };
    const p: ProvenanceSnapshot = {
      schemaVersion: "1.0",
      id: "p",
      projectId: d.projectId,
      designId: d.designId,
      nodes: { local: { "/layout/width": next } },
      history: [old],
      evidence: ["a", "b"].map((id) => ({
        id,
        kind: "source-property",
        pointer: "/width",
        artifact: {
          id: `source-${id}`,
          sha256: (id === "a" ? "0" : "1").repeat(64),
        },
      })),
    };
    expect(
      validateProvenance(d, p, (e) => ({ width: e.id === "a" ? 2 : 1 })).some(
        (x) => x.code === "CONFLICT",
      ),
    ).toBe(true);
  });
  it("handles constructor as an actual token/mode ID rather than inherited content", () => {
    const t: TokenSnapshot = {
      schemaVersion: "1.0",
      projectId: "p",
      revision: "1",
      collections: [{ id: "core", modes: ["constructor", "light"] }],
      selectedModes: { core: "constructor" },
      definitions: [
        {
          id: "a",
          collection: "core",
          type: "number",
          values: { light: { type: "number", value: 1 } },
          evidenceIds: [],
        },
      ],
      resolved: [],
      adapters: [],
    };
    expect(() => resolveTokens(t)).toThrow(/mode/i);
  });
  it("never aliases historical provenance entries back into the authoritative input", () => {
    const d = design();
    d.root = leaf;
    const p: ProvenanceSnapshot = {
      schemaVersion: "1.0",
      id: "p",
      projectId: d.projectId,
      designId: d.designId,
      nodes: {
        local: {
          "/layout/width": {
            id: "entry",
            type: "manual-edit",
            authority: "manual",
            acceptedAt: "2026-01-01T00:00:00Z",
            evidenceIds: ["e"],
            supersedes: [],
          },
        },
      },
      evidence: [
        {
          id: "e",
          kind: "manual-decision",
          artifact: { id: "source", sha256: "0".repeat(64) },
        },
      ],
      history: [],
    };
    const after = { ...d, root: { ...leaf, id: "replacement" } };
    const next = reconcileProvenance(d, after, p, () => {
      throw new Error("removed");
    });
    const old = next.history[0];
    if (!old) throw new Error("fixture");
    old.acceptedAt = "2026-01-02T00:00:00Z";
    expect(p.nodes.local?.["/layout/width"]?.acceptedAt).toBe(
      "2026-01-01T00:00:00Z",
    );
  });
  it("rejects imported inference that supersedes an accepted manual decision", () => {
    const d = design();
    d.root = leaf;
    const old: ProvenanceEntry = {
      id: "old",
      type: "manual-edit",
      authority: "manual",
      evidenceIds: ["e"],
      acceptedAt: "2026-01-01T00:00:00Z",
      supersedes: [],
    };
    const next: ProvenanceEntry = {
      id: "next",
      type: "ai-generated",
      authority: "inferred",
      evidenceIds: ["e"],
      acceptedAt: old.acceptedAt,
      supersedes: ["old"],
      confidence: 0.99,
      confidenceMeaning: "uncalibrated-score",
      inferenceRunId: "run",
    };
    const p: ProvenanceSnapshot = {
      schemaVersion: "1.0",
      id: "p",
      projectId: d.projectId,
      designId: d.designId,
      nodes: { local: { "/layout/width": next } },
      history: [old],
      evidence: [
        {
          id: "e",
          kind: "manual-decision",
          artifact: { id: "source", sha256: "0".repeat(64) },
        },
      ],
    };
    expect(() => validateProvenance(d, p)).toThrow(/authority/i);
  });
});
