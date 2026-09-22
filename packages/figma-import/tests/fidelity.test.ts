import { readFile } from "node:fs/promises";
import {
  DEFAULT_BUDGETS,
  type DesignNode,
  type JsonObject,
  parseContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { inspectFont } from "../../assets/src/font.js";
import { compileDocument } from "../../renderer/src/document.js";
import { layoutDesign } from "../../renderer/src/layout.js";
import { translationOnly } from "../src/geometry.js";
import {
  convertFigmaSnapshot,
  convertFigmaStructure,
  figmaConversionPolicy,
  verifyFigmaConversion,
} from "../src/index.js";

function fixture(edit?: (root: JsonObject) => void) {
  const root: JsonObject = {
    id: "1:1",
    type: "FRAME",
    name: "Synthetic translated hierarchy",
    absoluteBoundingBox: { x: 100, y: 200, width: 240, height: 160 },
    relativeTransform: [
      [1, 0, 100],
      [0, 1, 200],
    ],
    clipsContent: true,
    children: [
      {
        id: "1:2",
        type: "GROUP",
        absoluteBoundingBox: { x: 112, y: 220, width: 100, height: 80 },
        relativeTransform: [
          [1, 0, 12],
          [0, 1, 20],
        ],
        children: [
          {
            id: "1:3",
            type: "FRAME",
            absoluteBoundingBox: { x: 117, y: 227, width: 80, height: 60 },
            relativeTransform: [
              [1, 0, 5],
              [0, 1, 7],
            ],
            cornerRadius: 4,
            clipsContent: true,
            children: [
              {
                id: "1:4",
                type: "RECTANGLE",
                absoluteBoundingBox: { x: 120, y: 231, width: 20, height: 10 },
                relativeTransform: [
                  [1, 0, 3],
                  [0, 1, 4],
                ],
                fills: [
                  { type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
                ],
                opacity: 0.5,
                strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
                strokeWeight: 2,
                strokeAlign: "INSIDE",
              },
            ],
          },
        ],
      },
    ],
  };
  edit?.(root);
  const structureBytes = canonicalBytes({
    nodes: { "1:1": { document: root } },
  });
  return {
    structureBytes,
    structure: {
      id: "raw_synthetic_translation",
      path: "synthetic.json",
      mediaType: "application/json",
      byteLength: structureBytes.length,
      sha256: hashBytes(structureBytes),
    },
    selection: { fileKey: "SyntheticTranslation", nodeId: "1:1" },
    projectId: "project_translation",
    designId: "design_translation",
    intakeId: "intake_translation",
    actorId: "actor_translation",
    observedAt: "2026-09-18T00:00:00Z",
  };
}

function descend(node: DesignNode | undefined): DesignNode[] {
  if (!node) throw new Error("Missing synthetic design");
  return [node, ...("children" in node ? node.children.flatMap(descend) : [])];
}

it("projects translated nested structure with exact parent-relative geometry, not an opaque root", () => {
  const input = fixture();
  const result = convertFigmaStructure(input);
  const nodes = descend(result.design?.root);
  expect(nodes.map((node) => node.type)).toEqual([
    "frame",
    "group",
    "frame",
    "shape",
  ]);
  expect(nodes.map((node) => node.layout)).toEqual([
    { width: 240, height: 160, position: "absolute", offset: { x: 0, y: 0 } },
    { width: 100, height: 80, position: "absolute", offset: { x: 12, y: 20 } },
    { width: 80, height: 60, position: "absolute", offset: { x: 5, y: 7 } },
    { width: 20, height: 10, position: "absolute", offset: { x: 3, y: 4 } },
  ]);
  expect(
    new Set(result.conversionEvidence.entries.map((entry) => entry.nodeId))
      .size,
  ).toBe(4);
  expect(result.sourceMap.entries).toHaveLength(4);
  expect(Buffer.from(result.originalBytes)).toEqual(
    Buffer.from(input.structureBytes),
  );
  expect(result.report.losses).toEqual([]);
  expect(result.report.readiness).toBe("needs-review");
  expect(
    result.report.assessments
      .slice(2)
      .every((stage) => stage.status === "not-evaluated"),
  ).toBe(true);
  const nested = nodes[2];
  expect(nested && "appearance" in nested && nested.appearance?.clip).toEqual({
    kind: "rounded-bounds",
    radius: 4,
  });
  const shape = nodes[3];
  expect(shape && "appearance" in shape && shape.appearance).toEqual({
    fill: { space: "srgb", r: 0.2, g: 0.4, b: 0.6, a: 1 },
    opacity: 0.5,
    border: { width: 2, color: { space: "srgb", r: 1, g: 0, b: 0, a: 1 } },
  });
  expect(canonicalDigest(result.conversionEvidence)).toBe(
    canonicalDigest(convertFigmaStructure(input).conversionEvidence),
  );
});

it.each(
  [
    [
      [0, -1, 100],
      [1, 0, 200],
    ],
    [
      [2, 0, 100],
      [0, 1, 200],
    ],
    [
      [-1, 0, 100],
      [0, 1, 200],
    ],
    [
      [1, 0.1, 100],
      [0, 1, 200],
    ],
    [
      [1, 0, "100"],
      [0, 1, 200],
    ],
    [
      [1, 0, 100],
      [0, 1],
    ],
    [
      [1, 0, 100, 0],
      [0, 1, 200],
    ],
    null,
  ].map((matrix) => ({ matrix })),
)(
  "keeps unsupported or malformed matrix %j opaque and preserves descendants",
  ({ matrix }) => {
    const input = fixture((root) => {
      root.relativeTransform = matrix;
    });
    const result = convertFigmaStructure(input);
    expect(result.design?.root.type).toBe("unsupported");
    expect(result.sourceMap.entries).toHaveLength(4);
    expect(result.report.readiness).toBe("blocked");
    expect(
      result.report.losses.some((loss) =>
        loss.pointer.endsWith("/relativeTransform"),
      ),
    ).toBe(true);
    expect(Buffer.from(result.originalBytes)).toEqual(
      Buffer.from(input.structureBytes),
    );
  },
);

it.each([false, "true", null])(
  "keeps invalid or hidden visibility %j opaque",
  (visible) => {
    const result = convertFigmaStructure(
      fixture((root) => {
        root.visible = visible;
      }),
    );
    expect(result.design?.root.type).toBe("unsupported");
    expect(result.report.readiness).toBe("blocked");
  },
);

it("does not erase unknown properties while opening supported descendants", () => {
  const result = convertFigmaStructure(
    fixture((root) => {
      root["hostile~/future"] = { enabled: true };
    }),
  );
  expect(descend(result.design?.root)).toHaveLength(4);
  expect(
    result.report.losses.some((loss) =>
      loss.pointer.endsWith("/hostile~0~1future"),
    ),
  ).toBe(true);
  expect(result.report.readiness).toBe("blocked");
});

it("projects equal explicit render bounds rather than reporting an unrepresented footprint", () => {
  const result = convertFigmaStructure(
    fixture((root) => {
      root.absoluteRenderBounds = { x: 100, y: 200, width: 240, height: 160 };
    }),
  );
  expect(result.report.losses).toEqual([]);
  expect(
    result.conversionEvidence.entries.find((entry) =>
      entry.sourcePointer.endsWith("/absoluteRenderBounds"),
    ),
  ).toMatchObject({
    outputPointer: "/metadata/sourceAbsoluteBounds",
    rule: "fixed-layout",
    value: { x: 100, y: 200, width: 240, height: 160, unit: "design-unit" },
  });
});

it.each([
  { x: 99, y: 200, width: 242, height: 160 },
  { x: 100, y: 200, width: 240, height: 160, unknown: true },
  { x: 100, y: 200, width: "240", height: 160 },
  { x: 100, y: 200, width: 240 },
  null,
])(
  "retains meaningful, malformed or unavailable render bounds %j as a loss",
  (bounds) => {
    const result = convertFigmaStructure(
      fixture((root) => {
        root.absoluteRenderBounds = bounds;
      }),
    );
    expect(
      result.report.losses.some((loss) =>
        loss.pointer.endsWith("/absoluteRenderBounds"),
      ),
    ).toBe(true);
    expect(result.report.readiness).toBe("blocked");
  },
);

it.each([Infinity, -Infinity, NaN])(
  "rejects nonfinite matrix translation %s before projection",
  (value) => {
    expect(
      translationOnly([
        [1, 0, value],
        [0, 1, 0],
      ]),
    ).toBe(false);
    expect(
      translationOnly([
        [1, 0, 0],
        [0, 1, value],
      ]),
    ).toBe(false);
  },
);

it("retains the legacy transform bailout only under explicitly selected v1", () => {
  const result = convertFigmaStructure({ ...fixture(), policy: "fixed-v1" });
  expect(result.design?.root.type).toBe("unsupported");
  expect(result.conversionEvidence.entries).toHaveLength(3);
  expect(result.sourceMap.entries).toHaveLength(4);
  expect(result.conversionEvidence.adapter).toBe("figma-structure-fixed-v1");
});

it.each(["fixed-v3", "__proto__", null, {}])(
  "rejects unknown caller-selected policy %j instead of silently choosing a version",
  (policy) => {
    expect(() =>
      Reflect.apply(figmaConversionPolicy, undefined, [policy]),
    ).toThrow("Unknown intended conversion policy");
  },
);

it("replays accepted translation projections from separately retained source, not candidate values", () => {
  const selected = fixture();
  const input = {
    ...selected,
    manifest: {
      schemaVersion: "1.0",
      format: "figma-rest-nodes-v1",
      selectionUrl:
        "https://www.figma.com/design/SyntheticTranslation/selection?node-id=1-1",
      structure: selected.structure,
      assets: [],
      fonts: [],
    },
  };
  const candidate = convertFigmaSnapshot(input);
  const transforms = candidate.conversionEvidence.entries.filter((entry) =>
    entry.sourcePointer.endsWith("/relativeTransform"),
  );
  expect(transforms).toHaveLength(4);
  expect(
    transforms.every(
      (entry) =>
        entry.rule === "fixed-layout" &&
        entry.outputPointer === "/layout/offset",
    ),
  ).toBe(true);
  expect(() => verifyFigmaConversion(input, candidate)).not.toThrow();
  const altered = structuredClone(candidate);
  const entry = altered.conversionEvidence.entries.find((entry) =>
    entry.sourcePointer.endsWith("/relativeTransform"),
  );
  if (!entry || !altered.design)
    throw new Error("Missing synthetic projection");
  entry.value = { x: 100, y: 200 };
  altered.design.root.layout.offset = { x: 100, y: 200 };
  expect(() => verifyFigmaConversion(input, altered)).toThrow(
    "deterministic source replay",
  );
  const changedSource = structuredClone(candidate);
  changedSource.originalBytes[0] = 0;
  expect(() => verifyFigmaConversion(input, changedSource)).toThrow(
    "original bytes differ",
  );
});

it("keeps a rotated child opaque without losing its supported sibling or translating it twice", () => {
  const result = convertFigmaStructure(
    fixture((root) => {
      root.children = [
        {
          id: "1:2",
          type: "GROUP",
          relativeTransform: [
            [0, -1, 12],
            [1, 0, 20],
          ],
          absoluteBoundingBox: { x: 112, y: 220, width: 20, height: 10 },
          children: [],
        },
        {
          id: "1:3",
          type: "RECTANGLE",
          relativeTransform: [
            [1, 0, 40],
            [0, 1, 50],
          ],
          absoluteBoundingBox: { x: 140, y: 250, width: 30, height: 20 },
        },
      ];
    }),
  );
  const nodes = descend(result.design?.root);
  expect(nodes.map((node) => node.type)).toEqual([
    "frame",
    "unsupported",
    "shape",
  ]);
  expect(nodes[2]?.layout.offset).toEqual({ x: 40, y: 50 });
  expect(result.report.readiness).toBe("blocked");
});

it("traverses captured instance children as a fixed frame while disclosing lost component semantics", () => {
  const input = fixture((root) => {
    const group = Array.isArray(root.children) && root.children[0];
    if (!group || typeof group !== "object" || Array.isArray(group))
      throw new Error("Missing synthetic group");
    group.type = "INSTANCE";
    group.componentId = "synthetic_component";
    group.componentProperties = {};
    group.clipsContent = true;
    group.opacity = 0.5;
  });
  const result = convertFigmaStructure(input);
  const nodes = descend(result.design?.root);
  expect(nodes.map((node) => node.type)).toEqual([
    "frame",
    "frame",
    "frame",
    "shape",
  ]);
  expect(nodes[1]?.layout).toEqual({
    width: 100,
    height: 80,
    position: "absolute",
    offset: { x: 12, y: 20 },
  });
  expect(nodes[1] && "appearance" in nodes[1] && nodes[1].appearance).toEqual({
    clip: { kind: "bounds" },
    opacity: 0.5,
  });
  expect(nodes[2]?.layout.offset).toEqual({ x: 5, y: 7 });
  const loss = result.report.losses.find(
    (loss) => loss.sourceNodeId === "1:2" && loss.pointer.endsWith("/type"),
  );
  expect(loss).toMatchObject({
    support: "approximated",
    operations: ["render", "editable-export", "handoff"],
  });
  expect(
    result.provenance.evidence.find(
      (entry) => entry.id === loss?.evidenceIds[0],
    ),
  ).toMatchObject({
    kind: "source-property",
    sourceNodeId: "1:2",
    pointer: "/nodes/1:1/document/children/0/type",
  });
  expect(
    result.report.losses.some((loss) => loss.pointer.endsWith("/componentId")),
  ).toBe(true);
  expect(
    result.report.losses.some((loss) =>
      loss.pointer.endsWith("/componentProperties"),
    ),
  ).toBe(true);
  expect(result.resources.components.definitions).toEqual([]);
  expect(result.resources.components.mappings).toEqual([]);
  expect(result.report.readiness).toBe("blocked");
  const legacyInput = fixture((root) => {
    delete root.relativeTransform;
    root.children = [
      {
        id: "1:2",
        type: "INSTANCE",
        absoluteBoundingBox: { x: 112, y: 220, width: 100, height: 80 },
        children: [],
      },
    ];
  });
  const legacy = convertFigmaStructure({ ...legacyInput, policy: "fixed-v1" });
  expect(descend(legacy.design?.root).map((node) => node.type)).toEqual([
    "frame",
    "unsupported",
  ]);
});

it.each(["absent", "malformed"] as const)(
  "rejects %s instance children rather than inventing expansion",
  (kind) => {
    expect(() =>
      convertFigmaStructure(
        fixture((root) => {
          root.type = "INSTANCE";
          if (kind === "absent") delete root.children;
          else root.children = {};
        }),
      ),
    ).toThrow(
      kind === "absent"
        ? "Container children are absent"
        : "Invalid source children",
    );
  },
);

it.each(["hidden", "rotated", "image"] as const)(
  "keeps a %s instance opaque",
  (kind) => {
    const input = fixture((root) => {
      root.type = "INSTANCE";
      if (kind === "hidden") root.visible = false;
      if (kind === "rotated")
        root.relativeTransform = [
          [0, -1, 100],
          [1, 0, 200],
        ];
      if (kind === "image")
        root.fills = [{ type: "IMAGE", imageRef: "synthetic_missing" }];
    });
    const result = convertFigmaStructure(input);
    expect(result.design?.root.type).toBe("unsupported");
    expect(result.sourceMap.entries).toHaveLength(4);
    expect(result.report.readiness).toBe("blocked");
  },
);

it("passes translated geometry and nested clipping to pure layout/CSS without double translation", async () => {
  const result = convertFigmaStructure(fixture());
  const root = result.design?.root;
  if (!root) throw new Error("Missing synthetic design");
  const nodes = descend(root);
  const layout = await layoutDesign(root, 240, 160, async () => {
    throw new Error("This hierarchy has no text");
  });
  expect(nodes.map((node) => layout.boxes[node.id])).toEqual([
    { x: 0, y: 0, width: 240, height: 160 },
    { x: 12, y: 20, width: 100, height: 80 },
    { x: 5, y: 7, width: 80, height: 60 },
    { x: 3, y: 4, width: 20, height: 10 },
  ]);
  expect(
    nodes.reduce((sum, node) => sum + (layout.boxes[node.id]?.x ?? 0), 0),
  ).toBe(20);
  expect(
    nodes.reduce((sum, node) => sum + (layout.boxes[node.id]?.y ?? 0), 0),
  ).toBe(31);
  const compiled = compileDocument(root, layout, [], []);
  expect(compiled.html).toContain("left:3px;top:4px;width:20px;height:10px");
  expect(compiled.html).toContain("inset 0 0 0 2px rgba(255,0,0,1)");
  expect(compiled.html).toContain("overflow:hidden;border-radius:4px");
  expect(compiled.html).not.toContain("transform:matrix");
  expect(compiled.elements.map((element) => element.node.id)).toEqual(
    nodes.map((node) => node.id),
  );
});

it.each(["FRAME", "INSTANCE"] as const)(
  "preserves exact translated %s text with declared synthetic font, and blocks missing fonts",
  async (type) => {
    const input = fixture((root) => {
      root.type = type;
      root.children = [
        {
          id: "1:2",
          type: "TEXT",
          absoluteBoundingBox: { x: 112, y: 220, width: 100, height: 40 },
          relativeTransform: [
            [1, 0, 12],
            [0, 1, 20],
          ],
          characters: "Original text",
          fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }],
          opacity: 0.75,
          clipsContent: true,
          style: {
            fontFamily: "ABeeZee",
            fontPostScriptName: "ABeeZee-Regular",
            fontWeight: 400,
            fontSize: 14,
            lineHeightPx: 20,
            letterSpacing: 0,
            textAlignHorizontal: "LEFT",
            textAlignVertical: "TOP",
          },
          characterStyleOverrides: Array.from({ length: 13 }, (_, index) =>
            index < 8 ? 1 : 0,
          ),
          styleOverrideTable: { "1": { fontSize: 16 } },
        },
      ];
    });
    const missing = convertFigmaStructure(input);
    expect(descend(missing.design?.root).map((node) => node.type)).toEqual([
      "frame",
      "unsupported",
    ]);
    expect(
      missing.report.diagnostics.some(
        (diagnostic) => diagnostic.code === "FONT_MISSING",
      ),
    ).toBe(true);
    const declarations = parseContract(
      "ResourceSnapshot",
      await readFile(
        new URL(
          "../../../tests/fixtures/foundation/resources.json",
          import.meta.url,
        ),
        "utf8",
      ),
      "json",
    );
    const resources = missing.resources;
    resources.fonts = declarations.fonts;
    const result = convertFigmaStructure({
      ...input,
      resources: { snapshot: resources, bytes: canonicalBytes(resources) },
    });
    const root = result.design?.root;
    if (!root) throw new Error("Missing synthetic design");
    const text = descend(root)[1];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Missing text");
    expect(text.layout.offset).toEqual({ x: 12, y: 20 });
    expect(text.typography).toMatchObject({
      fontSize: 14,
      fontWeight: 400,
      lineHeight: 20,
      letterSpacing: 0,
      color: { space: "srgb", r: 0.1, g: 0.2, b: 0.3, a: 1 },
    });
    expect(text.styledRanges).toHaveLength(1);
    expect(text.styledRanges?.[0]).toMatchObject({
      start: 0,
      end: 8,
      typography: { fontSize: 16 },
    });
    expect(text.appearance).toEqual({
      opacity: 0.75,
      clip: { kind: "bounds" },
    });
    const layout = await layoutDesign(root, 240, 160, async () => ({
      width: 90,
      height: 20,
    }));
    const font = await readFile(
      new URL(
        "../../../tests/fixtures/foundation/assets/ABeeZee-Regular.ttf",
        import.meta.url,
      ),
    );
    const compiled = compileDocument(
      root,
      layout,
      [
        {
          id: text.typography.fontId,
          bytes: font.toString("base64"),
          face: inspectFont(font, text.content, DEFAULT_BUDGETS),
        },
      ],
      [],
    );
    expect(compiled.html).toContain("font-size:14px");
    expect(compiled.html).toContain("font-size:16px");
    expect(compiled.html).toContain("line-height:20px");
    expect(compiled.html).toContain("color:rgba(25.5,51,76.5,1)");
    expect(result.report.readiness).toBe(
      type === "INSTANCE" ? "blocked" : "needs-review",
    );
  },
);
