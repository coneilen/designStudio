import { readFileSync } from "node:fs";
import type {
  DesignIR,
  DesignNode,
  ResourceSnapshot,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptedContent,
  canonicalBytes,
  canonicalDigest,
  copyNode,
  hashBytes,
  namespaceId,
  reconcileIdentity,
  resolveDesign,
  resolveTokens,
  updateProvenance,
  validateProvenance,
} from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/foundation/${name}`, import.meta.url),
  );
const resources = () =>
  parseContract(
    "ResourceSnapshot",
    fixture("resources.json").toString(),
    "json",
  );
const design = (name = "settings-screen") =>
  parseContract("DesignIR", fixture(`${name}.design.json`).toString(), "json");
const options = { resourceBytes: fixture("resources.json") };
const codes = (d: DesignIR, r = resources(), limits = {}) =>
  resolveDesign(d, r, limits).report.diagnostics.map((x) => x.code);
const leaf = (id: string): DesignNode => ({
  id,
  type: "spacer",
  layout: { width: 10, height: 10 },
});

describe("canonical accepted content", () => {
  it("matches the authored canonical byte vectors", () => {
    const vectors: { name: string; input: unknown; canonical: string }[] =
      JSON.parse(
        readFileSync(
          new URL(
            "../../../tests/fixtures/design-ir/canonical-vectors.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    for (const vector of vectors)
      expect(
        Buffer.from(canonicalBytes(vector.input)).toString("utf8"),
        vector.name,
      ).toBe(vector.canonical);
  });
  it("orders UTF-16 keys, preserves arrays, uses ECMAScript finite numbers and UTF-8", () => {
    const a = { z: -0, a: [1e30, "é", 1e-7], "10": 10, "2": 2 };
    expect(Buffer.from(canonicalBytes(a)).toString()).toBe(
      '{"10":10,"2":2,"a":[1e+30,"é",1e-7],"z":0}',
    );
    expect(canonicalDigest(a)).toBe(
      canonicalDigest({ "2": 2, a: [1e30, "é", 1e-7], "10": 10, z: 0 }),
    );
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
    expect(hashBytes(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it.each([
    NaN,
    Infinity,
    undefined,
    BigInt(1),
    new Date(),
    new Map(),
    Array(2),
    { x: undefined },
    "\ud800",
  ])("rejects non-JSON %s", (value) => {
    expect(() => canonicalBytes(value)).toThrow();
  });
  it("rejects accessors without invoking them, cycles and decorations", () => {
    const getter = Object.defineProperty({}, "x", {
      get: () => {
        throw new Error("invoked");
      },
      enumerable: true,
    });
    expect(() => canonicalBytes(getter)).toThrow(/accessor/i);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalBytes(cycle)).toThrow(/cycle/i);
    expect(() => canonicalBytes(Object.assign([1], { extra: 1 }))).toThrow();
  });
  it("excludes delivery only at the explicit envelope, not accepted evidence", () => {
    const content = {
      acceptedAt: "2026-01-01T00:00:00Z",
      url: "immutable-source",
      path: "logical-path",
    };
    const a = acceptedContent({ content, delivery: { temporaryUrl: "a" } });
    expect(a.sha256).toBe(
      acceptedContent({ content, delivery: { temporaryUrl: "b" } }).sha256,
    );
    expect(a.sha256).not.toBe(
      acceptedContent({
        content: { ...content, acceptedAt: "2026-01-02T00:00:00Z" },
      }).sha256,
    );
    content.path = "changed";
    expect(Buffer.from(a.bytes).toString()).toContain("logical-path");
  });
});

describe("foundation semantic resolution", () => {
  it.each([
    "settings-screen",
    "mixed-styled-text",
    "image-crop-transform",
    "component-variants-slots",
    "unsupported-feature",
  ])("%s runs actual resource resolution", (name) => {
    const d = design(name);
    const r = resources();
    const before = canonicalDigest({ d, r });
    const result = resolveDesign(d, r, options);
    expect(result.report.readiness).toBe(
      name === "unsupported-feature" ? "blocked" : "needs-review",
    );
    expect(
      result.report.assessments.find((x) => x.stage === "dependency-resolved")
        ?.status,
    ).toBe("pass");
    expect(
      result.report.assessments.find((x) => x.stage === "renderable")?.status,
    ).not.toBe("pass");
    expect(validateContract("DiagnosticReport", result.report).success).toBe(
      true,
    );
    expect(
      result.design && validateContract("DesignIR", result.design).success,
    ).toBe(true);
    expect(canonicalDigest({ d, r })).toBe(before);
    expect(canonicalDigest(result)).toBe(
      canonicalDigest(resolveDesign(d, r, options)),
    );
  });
  it("normalizes once without confusing source geometry and computed layout", () => {
    const d = design();
    d.root = leaf("root");
    d.root.metadata = {
      sourceAbsoluteBounds: {
        x: 9,
        y: 8,
        width: 99,
        height: 88,
        unit: "design-unit",
      },
    };
    const result = resolveDesign(d, resources(), options);
    expect(result.design?.root.layout).toMatchObject({
      padding: { top: 0, left: 0, bottom: 0, right: 0 },
      spacing: 0,
      position: "flow",
      offset: { x: 0, y: 0 },
      alignment: "start",
      distribution: "start",
    });
    expect(result.design?.root.transform).toEqual({
      matrix: [1, 0, 0, 1, 0, 0],
      origin: { x: 0, y: 0 },
    });
    expect(result.design?.root.metadata).toEqual(d.root.metadata);
    expect(
      resolveDesign(result.design ?? d, resources(), options).design,
    ).toEqual(result.design);
  });
  it("fails contradictory bounds, unbounded fill, invalid frame flow, duplicate identity and limits", () => {
    const d = design();
    d.root = {
      id: "root",
      type: "column",
      layout: { width: "hug", height: 100 },
      children: [{ ...leaf("child"), layout: { width: "fill", height: 10 } }],
    };
    expect(codes(d)).toContain("INVALID_LAYOUT");
    d.root.layout.width = 100;
    d.root.layout.minWidth = 200;
    expect(codes(d)).toContain("INVALID_LAYOUT");
    delete d.root.layout.minWidth;
    d.root.children.push(leaf("child"));
    expect(codes(d)).toContain("DUPLICATE_NODE_ID");
    d.root.children.pop();
    expect(codes(d, resources(), { maxExpandedNodes: 1 })).toContain(
      "NODE_LIMIT",
    );
    expect(codes(d, resources(), { maxDepth: 1 })).toContain("DEPTH_LIMIT");
    d.root.type = "frame";
    expect(codes(d)).toContain("INVALID_LAYOUT");
  });
  it("checks UTF-16 boundaries, font declarations and crop bounds", () => {
    const d = design("mixed-styled-text");
    const findText = (
      n: DesignNode,
    ): Extract<DesignNode, { type: "text" }> | undefined =>
      n.type === "text"
        ? n
        : "children" in n
          ? n.children.map(findText).find(Boolean)
          : undefined;
    const t = findText(d.root);
    expect(t).toBeDefined();
    if (!t) return;
    t.content = "a😀b";
    t.styledRanges = [{ start: 1, end: 2, typography: t.typography }];
    expect(codes(d)).toContain("INVALID_LAYOUT");
    t.styledRanges = [];
    t.typography.fontId = "missing";
    expect(codes(d)).toContain("FONT_MISSING");
    const r = resources();
    r.fonts = [];
    expect(codes(design(), r)).toContain("FONT_MISSING");
    d.root = {
      id: "image",
      type: "image",
      assetId: "asset_stripes",
      fit: "crop",
      crop: { x: 199, y: 0, width: 2, height: 2, unit: "pixel" },
      layout: { width: 2, height: 2 },
    };
    expect(codes(d)).toContain("ASSET_INVALID");
  });
  it("verifies lock bytes and project/revision/mode scope", () => {
    const d = design();
    d.resources.sha256 = "0".repeat(64);
    expect(
      resolveDesign(d, resources(), options).report.diagnostics.map(
        (x) => x.code,
      ),
    ).toContain("ARTIFACT_INTEGRITY");
    const r = resources();
    r.projectId = "wrong";
    expect(codes(design(), r)).toContain("RESOURCE_UNRESOLVED");
  });
});

describe("tokens and components", () => {
  it("resolves aliases without mutating selected snapshots/adapters", () => {
    const r = resources();
    const before = canonicalDigest(r);
    const result = resolveTokens(r.tokens);
    expect(result.values.get("spacing.section")).toEqual({
      type: "dimension",
      value: 16,
      unit: "design-unit",
    });
    expect(canonicalDigest(r)).toBe(before);
  });
  it("rejects missing modes, type mismatches and transitive alias cycles", () => {
    const r = resources();
    r.tokens.selectedModes.core = "dark";
    expect(() => resolveTokens(r.tokens)).toThrow(/mode/i);
    r.tokens.selectedModes.core = "light";
    const first = r.tokens.definitions[0];
    if (!first) throw new Error("fixture");
    first.values.light = { type: "alias", token: "spacing.section" };
    expect(() => resolveTokens(r.tokens)).toThrow(/cycle/i);
    first.values.light = { type: "number", value: 16 };
    expect(() => resolveTokens(r.tokens)).toThrow(/type/i);
  });
  it("expands typed variants and named slots independently of code reuse", () => {
    const result = resolveDesign(
      design("component-variants-slots"),
      resources(),
      options,
    );
    expect(result.design).toBeDefined();
    const text = JSON.stringify(result.design);
    expect(text).not.toContain('"type":"component"');
    expect(text).toContain("Selected option");
    expect(result.instances.length).toBeGreaterThan(0);
    expect(new Set(result.instances.map((x) => x.instanceId)).size).toBe(
      result.instances.length,
    );
  });
  it("rejects invalid props, slots, variants, bindings, anchors and dependency cycles", () => {
    const mutate = (fn: (r: ResourceSnapshot) => void) => {
      const r = resources();
      fn(r);
      return codes(design(), r);
    };
    expect(
      mutate((r) => {
        const def = r.components.definitions[0];
        if (def)
          def.properties[0] = { name: "title", type: "number", required: true };
      }),
    ).toContain("COMPONENT_PROPERTY_INVALID");
    expect(
      mutate((r) => {
        const slot = r.components.definitions[0]?.slots[0];
        if (slot) slot.targetNodeId = "missing";
      }),
    ).toContain("COMPONENT_SLOT_INVALID");
    expect(
      mutate((r) => {
        const def = r.components.definitions[0];
        if (def)
          def.dependencies.components.push({
            id: def.id,
            version: def.version,
          });
      }),
    ).toContain("DEPENDENCY_CYCLE");
    expect(
      mutate((r) => {
        const def = r.components.definitions[0];
        if (def && "bindings" in def.expansion)
          def.expansion.bindings = [
            { property: "title", target: "appearance.opacity" },
          ];
      }),
    ).toContain("COMPONENT_PROPERTY_INVALID");
  });
});

describe("identity and provenance", () => {
  it("namespaces local IDs unambiguously and copies with fresh identity", () => {
    expect(namespaceId("a", ["b", "c"])).not.toBe(namespaceId("a", ["b.c"]));
    const d = leaf("old");
    expect(copyNode(d, () => "new").node.id).toBe("new");
    expect(d.id).toBe("old");
    expect(() => copyNode(d, () => "old")).toThrow();
    const known = [
      {
        adapter: "synthetic",
        document: "file",
        sourceNodeId: "1",
        nodeId: "retained",
      },
    ];
    expect(
      reconcileIdentity(
        known,
        { adapter: "synthetic", document: "file", sourceNodeId: "1" },
        ["other"],
      ),
    ).toEqual({ status: "retained", nodeId: "retained" });
    expect(
      reconcileIdentity(
        known,
        { adapter: "synthetic", document: "file", sourceNodeId: "2" },
        ["retained"],
      ),
    ).toEqual({ status: "proposal", candidates: ["retained"] });
  });
  it("validates property/evidence links and preserves superseded timestamps", () => {
    const d = design();
    const p = parseContract(
      "ProvenanceSnapshot",
      fixture("settings-screen.provenance.json").toString(),
      "json",
    );
    expect(
      validateProvenance(d, p).filter((x) => x.severity === "error"),
    ).toEqual([]);
    const nodeId = Object.keys(p.nodes)[0];
    if (!nodeId) throw new Error("fixture");
    const pointer = Object.keys(p.nodes[nodeId] ?? {})[0];
    if (!pointer) throw new Error("fixture");
    const old = p.nodes[nodeId]?.[pointer];
    if (!old) throw new Error("fixture");
    const entry = {
      ...old,
      id: "new-entry",
      authority: "manual" as const,
      type: "manual-edit" as const,
      acceptedAt: "2026-09-16T00:00:00Z",
      supersedes: [],
    };
    const next = updateProvenance(p, nodeId, pointer, entry);
    expect(next.history).toContainEqual(old);
    expect(next.nodes[nodeId]?.[pointer]?.supersedes).toContain(old.id);
    expect(p.nodes[nodeId]?.[pointer]).toEqual(old);
    expect(() =>
      updateProvenance(next, nodeId, pointer, {
        ...entry,
        id: "inferred",
        authority: "inferred",
      }),
    ).toThrow(/authority/i);
  });
});
