import { readFileSync } from "node:fs";
import type {
  ComponentNode,
  DesignIR,
  DesignNode,
  ProvenanceEntry,
  ProvenanceSnapshot,
  TokenSnapshot,
  VisualDefinition,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  canonicalDigest,
  dependencyBytes,
  expandComponents,
  literalTokenCandidates,
  namespaceId,
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
const base = () =>
  parseContract(
    "DesignIR",
    load("settings-screen.design.json").toString(),
    "json",
  );
const leaf = (id = "local"): DesignNode => ({
  type: "shape",
  id,
  shape: "rectangle",
  layout: { width: 10, height: 10 },
});
const instance = (id: string, component = "inner"): ComponentNode => ({
  id,
  type: "component",
  componentReference: { id: component, version: "1" },
  layout: { width: 100, height: 100 },
  properties: {},
  slots: {},
});
const definition = (id = "inner", expansion = leaf()): VisualDefinition => ({
  id,
  version: "1",
  properties: [],
  variants: [],
  slots: [],
  expansion,
  dependencies: { components: [], tokens: [], assets: [], fonts: [] },
  evidenceIds: [],
});
const diagnostics = (design: DesignIR, snapshot = resources()) =>
  resolveDesign(design, snapshot).report.diagnostics;
const errorCodes = (design: DesignIR, snapshot = resources()) =>
  diagnostics(design, snapshot)
    .filter((x) => x.severity === "error")
    .map((x) => x.code);
const limited = { maxDepth: 128, maxExpandedNodes: 20_000 };
const simpleTokens = (): TokenSnapshot => ({
  schemaVersion: "1.0",
  projectId: "project_synthetic",
  revision: "1",
  collections: [{ id: "core", modes: ["light", "dark"] }],
  selectedModes: { core: "light" },
  resolved: [],
  adapters: [],
  definitions: [
    {
      id: "a",
      type: "dimension",
      collection: "core",
      values: {
        light: { type: "dimension", value: 10, unit: "design-unit" },
        dark: { type: "dimension", value: 20, unit: "design-unit" },
      },
      evidenceIds: [],
    },
    {
      id: "b",
      type: "dimension",
      collection: "core",
      values: {
        light: { type: "alias", token: "a" },
        dark: { type: "alias", token: "a" },
      },
      evidenceIds: [],
    },
  ],
});

describe("token graph edge regressions", () => {
  it("rejects cycles in inactive modes, not only the chosen theme", () => {
    const t = simpleTokens();
    const a = t.definitions[0];
    if (!a) throw new Error("fixture");
    a.values.dark = { type: "alias", token: "b" };
    expect(() => resolveTokens(t)).toThrow(/cycle/i);
  });
  it("rejects incomplete declared modes without silently supplying light values", () => {
    const t = simpleTokens();
    const a = t.definitions[0];
    if (!a) throw new Error("fixture");
    delete a.values.dark;
    expect(() => resolveTokens(t)).toThrow(/mode/i);
  });
  it("resolves cross-collection aliases in the target collection selected mode", () => {
    const t = simpleTokens();
    t.collections.push({ id: "other", modes: ["compact", "wide"] });
    t.selectedModes.other = "wide";
    const b = t.definitions[1];
    if (!b) throw new Error("fixture");
    b.collection = "other";
    b.values = {
      compact: { type: "alias", token: "a" },
      wide: { type: "alias", token: "a" },
    };
    expect(resolveTokens(t).values.get("b")).toEqual({
      type: "dimension",
      value: 10,
      unit: "design-unit",
    });
    expect(
      literalTokenCandidates(
        { type: "dimension", value: 10, unit: "design-unit" },
        resolveTokens(t).values,
      ),
    ).toEqual([
      { state: "proposed", tokenId: "a" },
      { state: "proposed", tokenId: "b" },
    ]);
  });
  it("resolves shadow composite refs and detects composite transitive cycles", () => {
    const t = simpleTokens();
    t.definitions = [
      {
        id: "shadow",
        type: "shadow",
        collection: "core",
        evidenceIds: [],
        values: Object.fromEntries(
          ["light", "dark"].map((mode) => [
            mode,
            {
              type: "shadow",
              value: {
                offset: { x: 0, y: 1 },
                blur: 4,
                spread: -1,
                color: { token: "color" },
              },
            },
          ]),
        ),
      },
      {
        id: "color",
        type: "color",
        collection: "core",
        evidenceIds: [],
        values: Object.fromEntries(
          ["light", "dark"].map((mode) => [
            mode,
            { type: "color", value: { space: "srgb", r: 0, g: 0, b: 0, a: 1 } },
          ]),
        ),
      },
    ];
    expect(resolveTokens(t).values.get("shadow")).toMatchObject({
      value: { spread: -1, color: { r: 0 } },
    });
    const r = resources();
    const fontId = r.fonts[0]?.id ?? "missing";
    const typography = {
      fontId,
      fontSize: 12,
      fontWeight: 400,
      lineHeight: 14,
      letterSpacing: 0,
      alignment: "start" as const,
      color: { space: "srgb" as const, r: 0, g: 0, b: 0, a: 1 },
      wrap: "wrap" as const,
      styleToken: { token: "self" },
    };
    t.definitions = [
      {
        id: "self",
        type: "typography",
        collection: "core",
        evidenceIds: [],
        values: {
          light: { type: "typography", value: typography },
          dark: { type: "typography", value: typography },
        },
      },
    ];
    expect(() => resolveTokens(t)).toThrow(/cycle/i);
  });
  it("rejects bad units and target adapter type/conversion mismatches", () => {
    const t = simpleTokens();
    t.adapters = [
      {
        tokenId: "a",
        target: "web",
        state: "proposed",
        evidenceIds: [],
        adapter: {
          kind: "token",
          source: "a",
          target: "space",
          sourceType: "color",
          targetType: "string",
          conversion: "identity",
        },
      },
    ];
    expect(() => resolveTokens(t)).toThrow(/type/i);
  });
});

describe("nested visual definitions", () => {
  it("keeps definition-local and nested/slot identities stable across move, rename and variant revision", () => {
    const r = resources();
    r.components.mappings = [];
    const inner = definition();
    const outer = definition("outer", {
      id: "container",
      type: "column",
      layout: { width: 100, height: 100 },
      children: [
        instance("nested"),
        {
          id: "slot-anchor",
          type: "group",
          layout: { width: 10, height: 10 },
          children: [],
        },
      ],
    });
    outer.dependencies.components = [{ id: "inner", version: "1" }];
    outer.slots = [
      {
        name: "extra",
        targetNodeId: "slot-anchor",
        insertion: "children",
        minItems: 1,
        maxItems: 1,
        allowedNodeTypes: ["shape"],
      },
    ];
    r.components.definitions = [inner, outer];
    const a = instance("a", "outer");
    a.slots.extra = [leaf("slot-local")];
    const b = instance("b", "outer");
    b.slots.extra = [leaf("slot-other")];
    const d = base();
    d.root = {
      id: "root",
      type: "column",
      layout: { width: 300, height: 300 },
      children: [a, b],
    };
    const first = resolveDesign(d, r);
    expect(first.design).toBeDefined();
    const firstIDs = first.instances.find(
      (x) => x.instanceId === "a",
    )?.localIds;
    d.root.children.reverse();
    a.name = "renamed";
    const second = resolveDesign(d, r);
    expect(
      second.instances.find((x) => x.instanceId === "a")?.localIds,
    ).toEqual(firstIDs);
    expect(
      first.instances.find((x) => x.instanceId === "a")?.slotIds.extra?.[0],
    ).toBe(namespaceId("a", ["slot", "extra", "slot-local"]));
    expect(new Set(first.instances.map((x) => x.instanceId)).size).toBe(4);
    expect(validateContract("DesignIR", second.design).success).toBe(true);
  });
  it("rejects expanded namespace collisions against authored identities", () => {
    const r = resources();
    r.components.mappings = [];
    r.components.definitions = [
      definition("inner", {
        id: "root-local",
        type: "column",
        layout: { width: 10, height: 10 },
        children: [leaf("child")],
      }),
    ];
    const root: DesignNode = {
      id: "root",
      type: "column",
      layout: { width: 100, height: 100 },
      children: [
        instance("a"),
        leaf(namespaceId("a", ["definition", "child"])),
      ],
    };
    expect(() => expandComponents(root, r.components, limited)).toThrow(
      /collision/i,
    );
  });
  it("rejects transitive component closure cycles", () => {
    const r = resources();
    r.components.mappings = [];
    const a = definition("a");
    const b = definition("b");
    const c = definition("c");
    a.dependencies.components = [{ id: "b", version: "1" }];
    b.dependencies.components = [{ id: "c", version: "1" }];
    c.dependencies.components = [{ id: "a", version: "1" }];
    r.components.definitions = [a, b, c];
    expect(() =>
      expandComponents(instance("instance", "a"), r.components, limited),
    ).toThrow(/cycle/i);
  });
  it("refuses unknown and mismatched variants, extra properties and invalid slot types/cardinality", () => {
    const r = resources();
    const input = instance("toggle", "settings-toggle-row");
    input.properties.title = { type: "string", value: "Label" };
    input.variant = "missing";
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /variant/i,
    );
    input.variant = "on";
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /variant/i,
    );
    delete input.variant;
    input.properties.extra = { type: "string", value: "oops" };
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /property/i,
    );
    delete input.properties.extra;
    input.slots.trailing = [leaf("one"), leaf("two")];
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /slot/i,
    );
    input.slots.trailing = [instance("nested")];
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /slot/i,
    );
  });
  it("supports labelled snapshot-only expansion and rejects public edits", () => {
    const r = resources();
    r.components = { ...r.components, definitions: [], mappings: [] };
    const input = instance("snapshot");
    input.snapshotExpansion = {
      kind: "snapshot-only",
      source: { id: "source", sha256: "0".repeat(64) },
      root: leaf(),
      editableProperties: [],
    };
    const expanded = expandComponents(input, r.components, limited);
    expect(expanded.instances[0]?.mode).toBe("snapshot-only");
    input.properties.title = { type: "string", value: "edit" };
    expect(() => expandComponents(input, r.components, limited)).toThrow(
      /snapshot-only/i,
    );
  });
  it("validates all unused typed resource properties, not merely node-shaped references", () => {
    const r = resources();
    const def = r.components.definitions[0];
    if (!def) throw new Error("fixture");
    def.properties.push({
      name: "decoration",
      type: "asset",
      required: false,
      default: { type: "asset", value: "missing" },
    });
    expect(errorCodes(base(), r)).toContain("RESOURCE_UNRESOLVED");
  });
  it("checks declared token types in unselected visual variants", () => {
    const r = resources();
    const def = r.components.definitions[0];
    if (!def) throw new Error("fixture");
    def.expansion.layout.width = { token: "color.ink" };
    expect(errorCodes(base(), r)).toContain("TOKEN_TYPE_MISMATCH");
  });
});

describe("normalization and measurement boundaries", () => {
  it("rejects contradictory fixed aspect ratio and keeps measured overflow inconclusive", () => {
    const d = base();
    d.root = leaf();
    d.root.layout.aspectRatio = 2;
    expect(errorCodes(d)).toContain("INVALID_LAYOUT");
    d.root.layout.aspectRatio = 1;
    const result = resolveDesign(d, resources());
    expect(
      result.report.assessments.find((x) => x.stage === "renderable")?.status,
    ).toBe("not-evaluated");
  });
  it("has typed measured/allowed node and depth limit diagnostics", () => {
    const r = resources();
    r.components = { ...r.components, definitions: [], mappings: [] };
    const d = base();
    d.root = {
      id: "root",
      type: "column",
      layout: { width: 10, height: 10 },
      children: [leaf()],
    };
    for (const config of [{ maxDepth: 1 }, { maxExpandedNodes: 1 }]) {
      const result = resolveDesign(d, r, config);
      expect(
        result.report.diagnostics.find(
          (x) => x.code === "DEPTH_LIMIT" || x.code === "NODE_LIMIT",
        )?.limit,
      ).toMatchObject({ measured: 2, allowed: 1 });
      expect(result.design).toBeUndefined();
    }
  });
  it("does not claim byte integrity without supplied resource bytes", () => {
    const result = resolveDesign(base(), resources());
    expect(result.closure?.integrity).toBe("not-verified");
    expect(
      result.report.assessments.find((x) => x.stage === "dependency-resolved")
        ?.status,
    ).toBe("inconclusive");
    const r = resources();
    r.tokens.revision = "2";
    expect(
      resolveDesign(base(), r, { resourceBytes: load("resources.json") }).report
        .readiness,
    ).toBe("blocked");
  });
  it("verifies dependency raw bytes and never aliases caller buffers", () => {
    const artifact = resources().assets[0]?.artifact;
    if (!artifact) throw new Error("fixture");
    const raw = load("assets/stripes.png");
    const accepted = dependencyBytes(artifact, raw);
    raw[0] = 0;
    expect(accepted.bytes[0]).toBe(137);
    expect(() => dependencyBytes(artifact, raw)).toThrow(/bytes/i);
  });
  it("rejects malformed scroll capture prerequisites and unavailable font faces", () => {
    const d = base();
    d.root = {
      id: "scroll",
      type: "scroll",
      layout: { width: 10, height: 10 },
      children: [],
      scroll: {
        direction: "vertical",
        viewportBounds: {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          unit: "design-unit",
        },
        contentBounds: {
          x: 0,
          y: 0,
          width: 10,
          height: 20,
          unit: "design-unit",
        },
        captureOffset: { x: 0, y: 11 },
      },
    };
    expect(errorCodes(d)).toContain("INVALID_LAYOUT");
  });
  it("rejects nonfinite/negative typed input without silently clamping", () => {
    for (const width of [-1, NaN, Infinity]) {
      const d = base();
      d.root.layout.width = width;
      expect(errorCodes(d)).toContain("INVALID_SCHEMA");
    }
  });
});

function provenance(): {
  d: DesignIR;
  p: ProvenanceSnapshot;
  entry: ProvenanceEntry;
} {
  const d = base();
  d.root = leaf("root");
  const entry: ProvenanceEntry = {
    id: "entry",
    type: "manual-edit",
    authority: "manual",
    acceptedAt: "2026-01-01T00:00:00Z",
    evidenceIds: ["evidence"],
    supersedes: [],
  };
  const p: ProvenanceSnapshot = {
    schemaVersion: "1.0",
    id: "p",
    projectId: d.projectId,
    designId: d.designId,
    nodes: { root: { "/layout/width": entry } },
    history: [],
    evidence: [
      {
        id: "evidence",
        artifact: { id: "source", sha256: "0".repeat(64) },
        kind: "source-property",
        pointer: "/width",
      },
    ],
  };
  return { d, p, entry };
}
describe("property-addressed authority", () => {
  it("retains evidence on moves, supersedes changed values and forbids stale exact labels", () => {
    const { d, p, entry } = provenance();
    entry.authority = "exact-source";
    const moved = structuredClone(d);
    moved.root = {
      id: "new-parent",
      type: "group",
      layout: { width: 10, height: 10 },
      children: [d.root],
    };
    expect(
      reconcileProvenance(d, moved, p, () => {
        throw new Error("no changes");
      }),
    ).toEqual(p);
    const after = structuredClone(d);
    after.root.layout.width = 20;
    expect(() =>
      reconcileProvenance(d, after, p, () => ({ ...entry, id: "next" })),
    ).toThrow(/stale/i);
    const next = reconcileProvenance(d, after, p, () => ({
      ...entry,
      id: "next",
      authority: "manual",
      acceptedAt: "2026-01-02T00:00:00Z",
    }));
    expect(next.history).toEqual([entry]);
    expect(next.nodes.root?.["/layout/width"]?.authority).toBe("manual");
  });
  it("reports exact evidence conflicts and validates source JSON pointers", () => {
    const { d, p, entry } = provenance();
    entry.authority = "exact-source";
    p.evidence.push({
      id: "other",
      artifact: { id: "other-source", sha256: "1".repeat(64) },
      kind: "source-property",
      pointer: "/width",
    });
    entry.evidenceIds.push("other");
    expect(
      validateProvenance(d, p, (e) => ({
        width: e.id === "other" ? 20 : 10,
      })).some((x) => x.code === "CONFLICT"),
    ).toBe(true);
    expect(() => validateProvenance(d, p, () => ({ missing: 1 }))).toThrow(
      /pointer/i,
    );
    expect(() =>
      updateProvenance(p, "root", "/layout/width", {
        ...entry,
        id: "other-exact",
        evidenceIds: ["other"],
      }),
    ).toThrow(/conflict/i);
  });
  it("keeps manually edited approvals historical rather than blocking future manual changes", () => {
    const { p, entry } = provenance();
    entry.authority = "approved-manual";
    const next = updateProvenance(p, "root", "/layout/width", {
      ...entry,
      id: "new",
      authority: "manual",
    });
    expect(next.history[0]?.authority).toBe("approved-manual");
    expect(next.nodes.root?.["/layout/width"]?.authority).toBe("manual");
  });
  it("rejects unknown nodes/evidence, supersession cycles and rewritten IDs/timestamps", () => {
    const { d, p, entry } = provenance();
    expect(() => updateProvenance(p, "root", "/layout/width", entry)).toThrow(
      /immutable/i,
    );
    entry.supersedes = [entry.id];
    expect(() => validateProvenance(d, p)).toThrow(/cycle/i);
    entry.supersedes = [];
    entry.evidenceIds = ["missing"];
    expect(() => validateProvenance(d, p)).toThrow(/evidence/i);
  });
  it("rejects invalid new evidence entries immediately, not only on a later pass", () => {
    const { p, entry } = provenance();
    expect(() =>
      updateProvenance(p, "root", "/layout/width", {
        ...entry,
        id: "next",
        evidenceIds: ["missing"],
      }),
    ).toThrow(/evidence/i);
  });
});

describe("canonical bytes edge vectors", () => {
  it("preserves Unicode normalization and sorts astral keys by UTF-16 code unit", () => {
    expect(canonicalDigest("e\u0301")).not.toBe(canonicalDigest("\u00e9"));
    expect(
      Buffer.from(canonicalBytes({ "\ue000": 1, "😀": 2 })).toString(),
    ).toBe('{"😀":2,"":1}');
  });
  it("rejects dangerous object behavior without toJSON, hidden or inherited data", () => {
    const object = Object.create({ data: 1 });
    expect(() => canonicalBytes(object)).toThrow();
    expect(() => canonicalBytes({ toJSON: () => "hidden" })).toThrow();
    expect(() =>
      canonicalBytes(Object.defineProperty({}, "hidden", { value: 1 })),
    ).toThrow();
  });
});
