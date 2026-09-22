import { describe, expect, it } from "vitest";
import {
  ContractBoundaryError,
  DEFAULT_BUDGETS,
  EXIT_CODES,
  MOBILE_STATIC_POLICY,
  parseContract,
  validateContract,
} from "../src/index.js";

it("reuses compiled schemas without trusting previously validated mutable input", () => {
  const value: Record<string, unknown> = { ...DEFAULT_BUDGETS };
  expect(validateContract("Budget", value).success).toBe(true);
  value.maxAttempts = -1;
  expect(validateContract("Budget", value).success).toBe(false);
  let invoked = false;
  Object.defineProperty(value, "maxAttempts", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  expect(validateContract("Budget", value).success).toBe(false);
  expect(invoked).toBe(false);
  const cycle: Record<string, unknown> = {};
  expect(validateContract("JsonValue", cycle).success).toBe(true);
  cycle.self = cycle;
  expect(validateContract("JsonValue", cycle).success).toBe(false);
  for (const primitive of [null, true, false, "stable_id", 0, 1])
    expect(validateContract("JsonValue", primitive).success).toBe(true);
  for (const primitive of [
    NaN,
    Infinity,
    -Infinity,
    undefined,
    1n,
    Symbol("invalid"),
    () => {},
  ])
    expect(validateContract("JsonValue", primitive).success).toBe(false);
});

export const minimalDesign = () => ({
  schemaVersion: "1.0",
  projectId: "project_synthetic",
  designId: "design_empty",
  screen: {
    id: "screen_empty",
    name: "Synthetic",
    viewport: { width: 393, height: 852, unit: "design-unit" },
  },
  resources: {
    snapshotId: "resources_synthetic",
    sha256: "a".repeat(64),
    componentRegistryRevision: "1",
    tokenRegistryRevision: "1",
    selectedModes: { core: "light" },
  },
  root: {
    id: "node_root",
    type: "column",
    layout: { width: "fill", height: "fill" },
    children: [],
  },
});

describe("F01 structural acceptance, not semantic readiness", () => {
  it("accepts JSON/YAML into one schema without mutating or applying defaults", () => {
    const design = minimalDesign();
    const before = structuredClone(design);
    expect(validateContract("DesignIR", design)).toMatchObject({
      success: true,
      stage: "schema-valid",
      value: before,
    });
    expect(parseContract("DesignIR", JSON.stringify(design), "json")).toEqual(
      before,
    );
    expect(parseContract("DesignIR", JSON.stringify(design), "yaml")).toEqual(
      before,
    );
    expect(design).toEqual(before);
    expect(design.root.layout).not.toHaveProperty("spacing");
  });

  it.each([
    ["major version", { schemaVersion: "2.0" }],
    ["unknown core field", { css: {} }],
    ["second root", { roots: [] }],
  ])("rejects %s", (_reason, change) => {
    expect(
      validateContract("DesignIR", { ...minimalDesign(), ...change }).success,
    ).toBe(false);
  });

  it.each([
    { id: "n", type: "button", layout: { width: 12, height: 12 } },
    {
      id: "n",
      type: "text",
      layout: { width: "hug", height: "hug" },
      content: "A",
      children: [],
    },
    { id: "n", type: "image", layout: { width: 12, height: 12 }, children: [] },
    { id: "n", type: "spacer", layout: { width: -1, height: 12 } },
    { id: "n", type: "spacer", layout: { width: "100%", height: 12 } },
    {
      id: "n",
      type: "component",
      layout: { width: "fill", height: "hug" },
      componentReference: { id: "toggle", version: "1" },
      properties: { checked: { type: "boolean", value: "yes" } },
      slots: {},
    },
  ])(
    "rejects invalid discriminants, typed values and layout: $type",
    (root) => {
      expect(
        validateContract("DesignIR", { ...minimalDesign(), root }).success,
      ).toBe(false);
    },
  );

  it("accepts unresolved references structurally without pretending to resolve them", () => {
    const result = validateContract("DesignIR", {
      ...minimalDesign(),
      root: {
        id: "instance_unresolved",
        type: "component",
        layout: { width: "fill", height: "hug" },
        componentReference: { id: "unavailable", version: "1" },
        properties: {},
        slots: {},
      },
    });
    expect(result).toMatchObject({ success: true, stage: "schema-valid" });
    expect(result).not.toHaveProperty("readiness");
  });

  it("allows only namespaced, JSON-valued extensions", () => {
    expect(
      validateContract("DesignIR", {
        ...minimalDesign(),
        extensions: { "synthetic.example": { observed: true } },
      }).success,
    ).toBe(true);
    expect(
      validateContract("DesignIR", {
        ...minimalDesign(),
        extensions: { css: "red" },
      }).success,
    ).toBe(false);
  });
});

describe("untrusted authoring boundary", () => {
  it.each([
    ["duplicate YAML keys", "schemaVersion: '1.0'\nschemaVersion: '1.0'\n"],
    ["custom YAML tag", "root: !execute hello\n"],
    ["infinite YAML number", "root: .inf\n"],
    ["NaN YAML number", "root: .nan\n"],
    ["overflow", "root: 1e999\n"],
    ["alias", "root: &r {child: *r}\n"],
    ["multiple documents", "---\na: 1\n---\na: 2\n"],
  ])("rejects %s before semantic work", (_reason, text) => {
    expect(() => parseContract("DesignIR", text, "yaml")).toThrow(
      ContractBoundaryError,
    );
  });

  it("rejects duplicate JSON keys and malformed JSON syntax", () => {
    expect(() => parseContract("DesignIR", '{"a":1,"a":2}', "json")).toThrow(
      ContractBoundaryError,
    );
    expect(() =>
      parseContract("DesignIR", "schemaVersion: '1.0'", "json"),
    ).toThrow(ContractBoundaryError);
  });

  it("rejects non-finite in-memory numbers, cycles and non-JSON objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [
      Infinity,
      Number.NaN,
      cycle,
      new Date(),
      { value: undefined },
    ]) {
      expect(validateContract("DesignIR", input).success).toBe(false);
    }
  });

  it("bounds UTF-8 input and depth with measured diagnostics", () => {
    expect(() =>
      parseContract("DesignIR", "é".repeat(5), "yaml", { maxInputBytes: 9 }),
    ).toThrow(/INPUT_LIMIT/);
    let input: unknown = {};
    for (let i = 0; i < 130; i++) input = { child: input };
    expect(validateContract("DesignIR", input)).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DEPTH_LIMIT" }),
      ]),
    });
  });

  it.each([
    "../secret",
    "/absolute",
    "C:\\secret",
    "assets\\bad.png",
    "assets/../bad.png",
    "assets//bad.png",
    "assets/a%2fb",
    "assets/a:stream",
    "assets/CON",
    "assets/trailing.",
  ])("rejects unsafe artifact path %s", (path) => {
    expect(
      validateContract("Artifact", {
        id: "artifact_a",
        path,
        mediaType: "image/png",
        byteLength: 8,
        sha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      id: "",
      path: "assets/a.png",
      mediaType: "image/png",
      byteLength: 1,
      sha256: "a".repeat(64),
    },
    {
      id: "artifact_a",
      path: "assets/a.png",
      mediaType: "image/png",
      byteLength: -1,
      sha256: "a".repeat(64),
    },
    {
      id: "artifact_a",
      path: "assets/a.png",
      mediaType: "png",
      byteLength: 1,
      sha256: "a".repeat(64),
    },
    {
      id: "artifact_a",
      path: "assets/a.png",
      mediaType: "image/png",
      byteLength: 1,
      sha256: "A".repeat(64),
    },
  ])("rejects malformed artifact identity", (artifact) => {
    expect(validateContract("Artifact", artifact).success).toBe(false);
  });
});

it("pins normative budgets, comparison vocabulary, and exits without a comparator", () => {
  expect(DEFAULT_BUDGETS).toMatchObject({
    maxInputBytes: 26_214_400,
    maxRasterPixels: 64_000_000,
    maxExpandedNodes: 20_000,
    maxDepth: 128,
    maxSnapshotAssetBytes: 262_144_000,
  });
  expect(EXIT_CODES).toEqual({
    success: 0,
    operationalFailure: 1,
    invalidInput: 2,
    policyFailure: 3,
    inconclusive: 4,
    actionRequired: 5,
  });
  expect(MOBILE_STATIC_POLICY).toMatchObject({
    schemaVersion: "1.0",
    id: "mobile-static-v1",
    pixel: {
      predicate: "max-absolute-srgb-channel-delta",
      operator: ">",
      threshold: 16 / 255,
    },
    globalChangedFraction: { operator: ">", threshold: 0.01 },
    criticalChangedFraction: { operator: ">", threshold: 0.005 },
    exactGeometry: {
      operator: ">",
      threshold: 2,
      unit: "design-unit",
      evidence: "actual-view-hierarchy",
    },
    ssim: "diagnostic-only",
    calibration: "unverified",
  });
  expect(
    validateContract("ValidationPolicy", MOBILE_STATIC_POLICY).success,
  ).toBe(true);
});
