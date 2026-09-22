import type { JsonObject, JsonValue } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { convertFigmaStructure } from "../src/index.js";

function input(key: string, value: JsonValue, additional: JsonObject = {}) {
  const root: JsonObject = {
    id: "1:1",
    type: "FRAME",
    absoluteBoundingBox: { x: 40, y: 60, width: 80, height: 50 },
    children: [],
    ...additional,
    [key]: value,
  };
  const structureBytes = canonicalBytes({
    nodes: { "1:1": { document: root } },
  });
  return {
    structureBytes,
    structure: {
      id: "raw_properties",
      path: "synthetic.json",
      mediaType: "application/json",
      sha256: hashBytes(structureBytes),
      byteLength: structureBytes.length,
    },
    selection: { fileKey: "SyntheticDefaults", nodeId: "1:1" },
    projectId: "project_defaults",
    designId: "design_defaults",
    intakeId: "intake_defaults",
    actorId: "actor_defaults",
    observedAt: "2026-09-18T00:00:00Z",
  };
}

const neutral: [string, JsonValue][] = [
  ["size", { x: 80, y: 50 }],
  ["fillGeometry", []],
  ["strokeGeometry", []],
  ["scrollBehavior", "SCROLLS"],
  ["layoutAlign", "INHERIT"],
  ["layoutGrow", 0],
  ["layoutWrap", "NO_WRAP"],
  ["constraints", { horizontal: "LEFT", vertical: "TOP" }],
];

it.each(neutral)(
  "classifies the exact fixed-snapshot neutral %s value without altering geometry",
  (key, value) => {
    const selected = input(key, value);
    const result = convertFigmaStructure(selected);
    expect(result.report.losses).toEqual([]);
    expect(result.design?.root.layout).toEqual({
      position: "absolute",
      width: 80,
      height: 50,
      offset: { x: 0, y: 0 },
    });
    expect(result.report.readiness).toBe("needs-review");
    expect(result.conversionEvidence.ignoredProperties).toEqual([]);
    expect(Buffer.from(result.originalBytes)).toEqual(
      Buffer.from(selected.structureBytes),
    );
    const legacy = convertFigmaStructure({ ...selected, policy: "fixed-v1" });
    expect(
      legacy.report.losses.some((loss) => loss.pointer.endsWith(`/${key}`)),
    ).toBe(true);
  },
);

it("binds redundant size and default constraints to explicit represented values", () => {
  const size = convertFigmaStructure(input("size", { x: 80, y: 50 }));
  expect(
    size.conversionEvidence.entries.find((entry) =>
      entry.sourcePointer.endsWith("/size"),
    ),
  ).toMatchObject({
    rule: "fixed-layout",
    outputPointer: "/layout",
    value: {
      width: 80,
      height: 50,
      position: "absolute",
      offset: { x: 0, y: 0 },
    },
  });
  const constraints = convertFigmaStructure(
    input("constraints", { horizontal: "LEFT", vertical: "TOP" }),
  );
  expect(
    constraints.conversionEvidence.entries.find((entry) =>
      entry.sourcePointer.endsWith("/constraints"),
    ),
  ).toMatchObject({
    rule: "fixed-layout",
    outputPointer: "/layout/offset",
    value: { x: 0, y: 0 },
  });
});

const unsupported: [string, JsonValue][] = [
  ["size", { x: 81, y: 50 }],
  ["size", { x: "80", y: 50 }],
  ["size", { x: 80, y: 50, extra: true }],
  ["size", { x: 80 }],
  ["fillGeometry", [{ path: "M0,0L1,1", windingRule: "NONZERO" }]],
  ["fillGeometry", {}],
  ["strokeGeometry", [{ path: "M0,0L1,1", windingRule: "NONZERO" }]],
  ["strokeGeometry", {}],
  ["scrollBehavior", "FIXED"],
  ["scrollBehavior", "STICKY_SCROLLS"],
  ["scrollBehavior", { value: "SCROLLS", extra: true }],
  ["layoutAlign", "STRETCH"],
  ["layoutAlign", { value: "INHERIT", extra: true }],
  ["layoutGrow", 1],
  ["layoutGrow", "0"],
  ["layoutGrow", { value: 0, extra: true }],
  ["layoutWrap", "WRAP"],
  ["layoutWrap", { value: "NO_WRAP", extra: true }],
  ["constraints", { horizontal: "CENTER", vertical: "TOP" }],
  ["constraints", { horizontal: "LEFT", vertical: "SCALE" }],
  ["constraints", { horizontal: "LEFT", vertical: "TOP", extra: true }],
  ["constraints", { horizontal: "LEFT" }],
  ["constraints", null],
  ["unknownVisual", {}],
  ["boundVariables", {}],
  ["background", []],
  ["styles", {}],
  ["layoutSizingHorizontal", "HUG"],
  ["layoutSizingVertical", "FILL"],
  ["layoutSizingHorizontal", "FIXED"],
];

it.each(unsupported)(
  "retains meaningful or malformed %s=%j as a blocking loss",
  (key, value) => {
    const result = convertFigmaStructure(input(key, value));
    expect(
      result.report.losses.some(
        (loss) =>
          loss.pointer.endsWith(`/${key}`) && loss.support === "unsupported",
      ),
    ).toBe(true);
    expect(result.report.readiness).toBe("blocked");
  },
);

it("does not turn neutral layout defaults into editable auto-layout equivalence", () => {
  const result = convertFigmaStructure(
    input("layoutMode", "HORIZONTAL", {
      layoutAlign: "INHERIT",
      layoutGrow: 0,
      layoutWrap: "NO_WRAP",
    }),
  );
  expect(result.report.losses).toEqual([
    expect.objectContaining({
      support: "approximated",
      pointer: "/nodes/1:1/document/layoutMode",
    }),
  ]);
  expect(result.design?.root.type === "frame" && result.design.root.flow).toBe(
    "absolute",
  );
  expect(result.report.readiness).toBe("blocked");
});
