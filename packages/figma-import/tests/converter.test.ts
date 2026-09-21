import { readFile } from "node:fs/promises";
import {
  type JsonObject,
  parseContract,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
  validateProvenance,
} from "@design-studio/design-ir";
import { describe, expect, it } from "vitest";
import {
  convertFigmaSnapshot,
  parseFigmaSelection,
  verifyFigmaConversion,
} from "../src/index.js";

const bytes = await readFile(
  new URL("../../../tests/fixtures/figma-import/frame.json", import.meta.url),
);
const url =
  "https://www.figma.com/design/SyntheticFixture/Original?node-id=1-2";
const fixtureResources = parseContract(
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
function input(data: Uint8Array = bytes) {
  return {
    manifest: {
      schemaVersion: "1.0",
      format: "figma-rest-nodes-v1",
      selectionUrl: url,
      structure: {
        id: "raw_fixture",
        path: "raw.json",
        mediaType: "application/json",
        byteLength: data.length,
        sha256: hashBytes(data),
      },
      assets: [],
      fonts: [],
    },
    structureBytes: data,
    projectId: "project_test",
    designId: "design_test",
    intakeId: "intake_test",
    actorId: "actor_test",
    observedAt: "2026-09-18T00:00:00Z",
  };
}
function changed(
  edit: (root: JsonObject, child: JsonObject, nodes: JsonObject) => void,
) {
  const value = parseContract("JsonObject", bytes.toString(), "json");
  const nodes = value.nodes as JsonObject;
  const root = (nodes["1:2"] as JsonObject).document as JsonObject;
  const child = (root.children as JsonObject[])[0];
  if (!child) throw new Error("Missing synthetic child.");
  edit(root, child, nodes);
  return input(Buffer.from(JSON.stringify(value)));
}

describe("bounded offline Figma conversion", () => {
  it("replays the complete pre-v2 artifact digest only under caller-selected v1 policy", () => {
    const original = { ...input(), policy: "fixed-v1" as const };
    const legacy = convertFigmaSnapshot(original);
    const { originalBytes: _bytes, ...artifacts } = legacy;
    expect(canonicalDigest(artifacts)).toBe(
      "5b6f55cbaa0d9091d3751d7412dddff37811f7cbca38e57bf5697379522c54ff",
    );
    expect(() => verifyFigmaConversion(original, legacy)).not.toThrow();
    expect(() => verifyFigmaConversion(input(), legacy)).toThrow(
      "deterministic source replay",
    );
    expect(convertFigmaSnapshot(input()).conversionEvidence.adapter).toBe(
      "figma-offline-fixed-v2",
    );
  });

  it("converts fixed geometry, preserves raw bytes, and never authenticates declared metadata", () => {
    const result = convertFigmaSnapshot(input());
    expect(result.originalBytes).toEqual(bytes);
    expect(result.source.identity.transport).toBe("figma-offline");
    expect(result.source.consistency.guarantee).toBe("unknown");
    expect(result.source.requests).toEqual([]);
    expect(result.source.completeness).toBe("partial");
    expect(result.report.readiness).toBe("needs-review");
    expect(result.design?.screen.viewport).toEqual({
      width: 240,
      height: 160,
      unit: "design-unit",
    });
    expect(result.design?.root.type).toBe("frame");
    if (!result.design || !("children" in result.design.root))
      throw new Error("Missing frame.");
    expect(result.design.root.children[0]?.layout.offset).toEqual({
      x: 12,
      y: 20,
    });
    expect(validateContract("DesignIR", result.design).success).toBe(true);
    expect(validateContract("SourceSnapshot", result.source).success).toBe(
      true,
    );
    expect(validateContract("FigmaSourceMap", result.sourceMap).success).toBe(
      true,
    );
    expect(
      validateContract("FigmaConversionEvidence", result.conversionEvidence)
        .success,
    ).toBe(true);
    expect(
      validateProvenance(result.design, result.provenance, (evidence) =>
        evidence.artifact.id === result.source.artifacts[0]?.id
          ? JSON.parse(bytes.toString())
          : result.conversionEvidence,
      ),
    ).toEqual([]);
    const { originalBytes, ...artifacts } = result;
    const { originalBytes: repeated, ...again } = convertFigmaSnapshot(input());
    expect(originalBytes).toEqual(repeated);
    expect(canonicalDigest(artifacts)).toBe(canonicalDigest(again));
  });

  it.each([
    ["rotation", 30],
    [
      "relativeTransform",
      [
        [2, 0, 2],
        [0, 1, 3],
      ],
    ],
    ["visible", false],
    ["visible", "false"],
    ["clipsContent", "true"],
    ["blendMode", "MULTIPLY"],
    ["cornerSmoothing", 0.6],
    ["fills", [{ type: "GRADIENT_LINEAR" }]],
    ["unknownFuturePaint", true],
  ] as const)("does not silently discard %s", (key, value) => {
    const result = convertFigmaSnapshot(
      changed((_root, child) => {
        child[key] = JSON.parse(JSON.stringify(value));
      }),
    );
    expect(result.report.readiness).toBe("blocked");
    expect(
      result.report.losses.some((loss) => loss.pointer.endsWith(`/${key}`)),
    ).toBe(true);
  });

  it("labels captured auto-layout geometry as approximated, not editable layout", () => {
    const result = convertFigmaSnapshot(
      changed((root) => {
        root.layoutMode = "HORIZONTAL";
        root.itemSpacing = 12;
      }),
    );
    expect(
      result.report.losses.some(
        (loss) =>
          loss.support === "approximated" &&
          loss.pointer.endsWith("/layoutMode"),
      ),
    ).toBe(true);
    expect(result.report.readiness).toBe("blocked");
    expect(
      result.design?.root.type === "frame" && result.design.root.flow,
    ).toBe("absolute");
  });

  it("keeps image/component/vector nodes opaque without pixel fallbacks", () => {
    for (const type of ["INSTANCE", "VECTOR", "RECTANGLE"]) {
      const result = convertFigmaSnapshot(
        changed((_root, child) => {
          child.type = type;
          if (type === "INSTANCE") child.children = [];
          if (type === "RECTANGLE")
            child.fills = [{ type: "IMAGE", imageRef: "missing" }];
        }),
      );
      const node = result.design?.root;
      const child = node && "children" in node ? node.children[0] : undefined;
      expect(child?.type).toBe("unsupported");
      expect(child && "children" in child).toBe(false);
      expect(child?.metadata?.rawSource?.sha256).toBe(
        result.source.artifacts[0]?.sha256,
      );
      expect(child && "inspectionCrop" in child).toBe(false);
    }
  });

  function textInput(
    content: string,
    overrides?: number[],
    edit?: (child: JsonObject) => void,
  ) {
    const converted = changed((_root, child) => {
      child.type = "TEXT";
      child.characters = content;
      child.style = {
        fontFamily: "ABeeZee",
        fontPostScriptName: "ABeeZee-Regular",
        fontWeight: 400,
        fontSize: 14,
        lineHeightPx: 20,
        letterSpacing: 0,
        textAlignHorizontal: "LEFT",
        textAlignVertical: "TOP",
      };
      if (overrides) {
        child.characterStyleOverrides = overrides;
        child.styleOverrideTable = { "1": { fontSize: 16 } };
      }
      edit?.(child);
    });
    const resources = convertFigmaSnapshot(input()).resources;
    resources.fonts = fixtureResources.fonts;
    return {
      ...converted,
      resources: { snapshot: resources, bytes: canonicalBytes(resources) },
    };
  }

  it("reports text glyph strokes instead of converting them to box borders", () => {
    const result = convertFigmaSnapshot(
      textInput("Outlined text", undefined, (child) => {
        child.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }];
        child.strokeWeight = 2;
        child.strokeAlign = "INSIDE";
      }),
    );
    const root = result.design?.root;
    const text = root && "children" in root ? root.children[0] : undefined;
    expect(text?.type).toBe("text");
    expect(text?.type === "text" && text.appearance?.border).toBeUndefined();
    expect(
      result.report.losses.some(
        (loss) =>
          loss.sourceNodeId === "1:3" &&
          loss.pointer.endsWith("/strokes") &&
          loss.support === "unsupported",
      ),
    ).toBe(true);
    expect(result.report.readiness).toBe("blocked");
  });

  it.each(["empty", "hidden"] as const)(
    "does not invent text borders or glyph-stroke loss for %s strokes",
    (kind) => {
      const result = convertFigmaSnapshot(
        textInput("Plain text", undefined, (child) => {
          child.strokes =
            kind === "empty"
              ? []
              : [
                  {
                    type: "SOLID",
                    visible: false,
                    color: { r: 1, g: 0, b: 0, a: 1 },
                  },
                ];
          child.strokeWeight = 2;
          child.strokeAlign = "INSIDE";
        }),
      );
      const root = result.design?.root;
      const text = root && "children" in root ? root.children[0] : undefined;
      expect(text?.type).toBe("text");
      expect(text?.type === "text" && text.appearance?.border).toBeUndefined();
      expect(
        result.report.losses.filter((loss) =>
          loss.pointer.endsWith("/strokes"),
        ),
      ).toEqual([]);
      expect(result.report.readiness).toBe("needs-review");
    },
  );

  it("preserves the supported rectangle inside border", () => {
    const result = convertFigmaSnapshot(
      changed((_root, child) => {
        child.strokes = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }];
        child.strokeWeight = 2;
        child.strokeAlign = "INSIDE";
      }),
    );
    const root = result.design?.root;
    const rectangle = root && "children" in root ? root.children[0] : undefined;
    expect(
      rectangle?.type === "shape" && rectangle.appearance?.border?.width,
    ).toBe(2);
    expect(
      result.report.losses.filter((loss) => loss.pointer.endsWith("/strokes")),
    ).toEqual([]);
  });

  it("converts original synthetic mixed text without claiming font bytes, rights or renderability", () => {
    const result = convertFigmaSnapshot(textInput("Test", [0, 0, 1, 1]));
    const node = result.design?.root;
    const text = node && "children" in node ? node.children[0] : undefined;
    expect(text?.type).toBe("text");
    expect(text?.type === "text" && text.styledRanges?.[0]?.start).toBe(2);
    expect(
      result.report.assessments.find(
        (item) => item.stage === "dependency-resolved",
      )?.status,
    ).toBe("inconclusive");
    expect(
      result.report.assessments.find((item) => item.stage === "renderable")
        ?.status,
    ).toBe("not-evaluated");
    expect(result.source.completeness).toBe("partial");
    expect(result.resources.fonts[0]?.family).toBe("ABeeZee");
    const absent = textInput("Text");
    absent.resources.snapshot.fonts = [];
    absent.resources.bytes = canonicalBytes(absent.resources.snapshot);
    expect(
      convertFigmaSnapshot(absent).report.diagnostics.some(
        (item) => item.code === "FONT_MISSING",
      ),
    ).toBe(true);
  });

  it("rejects mixed-style boundaries splitting UTF-16 surrogate pairs", () => {
    const result = convertFigmaSnapshot(
      textInput("A\uD83D\uDE00B", [0, 0, 1, 1]),
    );
    expect(result.report.readiness).toBe("blocked");
    expect(
      result.report.losses.some((loss) => loss.reason.includes("surrogate")),
    ).toBe(true);
  });

  it("replays source transformations rather than trusting a self-consistent projection", () => {
    const candidate = convertFigmaSnapshot(input());
    expect(() => verifyFigmaConversion(input(), candidate)).not.toThrow();
    const forged = structuredClone(candidate);
    const entry = forged.conversionEvidence.entries.find(
      (item) => item.outputPointer === "/layout",
    );
    if (!entry || !forged.design)
      throw new Error("Missing synthetic conversion.");
    forged.design.root.layout.width = 999;
    entry.value = parseContract(
      "JsonValue",
      JSON.stringify(forged.design.root.layout),
      "json",
    );
    for (const item of forged.provenance.evidence) {
      if (item.artifact.id.startsWith("conversion_"))
        item.artifact.sha256 = canonicalDigest(forged.conversionEvidence);
    }
    expect(
      validateProvenance(forged.design, forged.provenance, (item) =>
        item.artifact.id.startsWith("conversion_")
          ? parseContract(
              "JsonObject",
              JSON.stringify(forged.conversionEvidence),
              "json",
            )
          : parseContract("JsonObject", bytes.toString(), "json"),
      ),
    ).toEqual([]);
    expect(() => verifyFigmaConversion(input(), forged)).toThrow(
      "deterministic source replay",
    );
  });

  it("rejects cancellation and source depth limits with typed diagnostics", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      convertFigmaSnapshot(input(), { signal: controller.signal }),
    ).toThrow("cancelled");
    expect(() => convertFigmaSnapshot(input(), { maxDepth: 1 })).toThrow(
      "depth budget",
    );
    expect(() => convertFigmaSnapshot(input(), { maxNodes: 0 })).toThrow(
      "Invalid conversion budget",
    );
  });

  it("preserves copy and reorder identity semantics without label matching", () => {
    const withCopy = changed((root, child) => {
      root.children = [child, { ...child, id: "1:4" }];
    });
    const first = convertFigmaSnapshot(withCopy);
    const reversed = parseContract(
      "JsonObject",
      Buffer.from(withCopy.structureBytes).toString(),
      "json",
    );
    const root = ((reversed.nodes as JsonObject)["1:2"] as JsonObject)
      .document as JsonObject;
    (root.children as JsonObject[]).reverse();
    const second = convertFigmaSnapshot(
      input(Buffer.from(JSON.stringify(reversed))),
    );
    const identities = (result: typeof first) =>
      result.sourceMap.entries
        .map((entry) => [entry.sourceNodeId, entry.nodeId])
        .sort();
    expect(identities(second)).toEqual(identities(first));
    expect(
      new Set(first.sourceMap.entries.map((entry) => entry.nodeId)).size,
    ).toBe(3);
  });

  it("accepts third-party schemaVersion metadata without granting our artifact semantics", () => {
    const result = convertFigmaSnapshot(
      input(
        Buffer.from(
          bytes.toString().replace('"nodes":', '"schemaVersion": 0, "nodes":'),
        ),
      ),
    );
    expect(result.source.consistency.guarantee).toBe("unknown");
    expect(
      validateContract("SourceSnapshot", {
        ...result.source,
        consistency: { guarantee: "version-pinned", limitations: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps input objects immutable and retains full-length logical identifier support", () => {
    const selected = input();
    const before = JSON.stringify(selected);
    convertFigmaSnapshot(selected);
    expect(JSON.stringify(selected)).toEqual(before);
    expect(() =>
      convertFigmaSnapshot({ ...selected, intakeId: "a".repeat(160) }),
    ).not.toThrow();
  });

  it("uses stable source coordinates within one intake, never labels or visual content", () => {
    const original = convertFigmaSnapshot(input());
    const renamed = convertFigmaSnapshot(
      changed((_root, child) => {
        child.name = "Renamed";
      }),
    );
    expect(renamed.sourceMap.entries.map((e) => e.nodeId)).toEqual(
      original.sourceMap.entries.map((e) => e.nodeId),
    );
    const independent = convertFigmaSnapshot({
      ...input(),
      intakeId: "another_intake",
    });
    expect(independent.sourceMap.entries[0]?.nodeId).not.toBe(
      original.sourceMap.entries[0]?.nodeId,
    );
  });

  it("projects copied node labels and derives the screen label from the root", () => {
    const result = convertFigmaSnapshot(input());
    const design = result.design;
    if (!design || !("children" in design.root))
      throw new Error("Missing fixture.");
    for (const node of [design.root, ...design.root.children]) {
      const projection = result.conversionEvidence.entries.find(
        (entry) => entry.nodeId === node.id && entry.outputPointer === "/name",
      );
      expect(projection?.value).toBe(node.name);
      expect(projection?.sourcePointer.endsWith("/name")).toBe(true);
      expect(result.provenance.nodes[node.id]?.["/name"]).toBeDefined();
    }
    expect(design.screen.name).toBe(design.root.name);
    expect(
      result.conversionEvidence.ignoredProperties.some((entry) =>
        entry.pointer.endsWith("/name"),
      ),
    ).toBe(false);
  });

  it("reports unconverted visual render bounds instead of silently dropping them", () => {
    const result = convertFigmaSnapshot(
      changed((_root, child) => {
        child.absoluteRenderBounds = { x: 102, y: 210, width: 80, height: 50 };
      }),
    );
    expect(
      result.report.losses.some((loss) =>
        loss.pointer.endsWith("/absoluteRenderBounds"),
      ),
    ).toBe(true);
    expect(result.report.readiness).toBe("blocked");
  });

  it("links losses to exact existing properties including escaped keys", () => {
    const result = convertFigmaSnapshot(
      changed((_root, child) => {
        child.effects = [{ type: "LAYER_BLUR", radius: 5 }];
        child["future/~paint"] = "source-property";
      }),
    );
    for (const suffix of ["/effects", "/future~1~0paint"]) {
      const loss = result.report.losses.find((entry) =>
        entry.pointer.endsWith(suffix),
      );
      if (!loss) throw new Error("Missing expected property loss.");
      const evidence = result.provenance.evidence.find(
        (entry) => entry.id === loss.evidenceIds[0],
      );
      expect(evidence?.pointer).toBe(loss.pointer);
    }
  });

  it("retains exact nested style pointers and honest containing-node evidence for absent styles", () => {
    const nested = convertFigmaSnapshot(
      textInput("Original label", undefined, (child) => {
        const style = child.style as JsonObject;
        style["future/~style"] = true;
      }),
    );
    const loss = nested.report.losses.find((entry) =>
      entry.pointer.endsWith("/style/future~1~0style"),
    );
    expect(loss).toBeDefined();
    expect(
      nested.provenance.evidence.find(
        (entry) => entry.id === loss?.evidenceIds[0],
      )?.pointer,
    ).toBe(loss?.pointer);
    const missing = convertFigmaSnapshot(
      textInput("Original label", undefined, (child) => {
        delete child.style;
      }),
    );
    const absent = missing.report.losses.find((entry) =>
      entry.pointer.endsWith("/style"),
    );
    expect(absent).toBeDefined();
    expect(
      missing.provenance.evidence.find(
        (entry) => entry.id === absent?.evidenceIds[0],
      )?.pointer,
    ).toBe("/nodes/1:2/document/children/0");
    expect(missing.report.readiness).toBe("blocked");
  });

  it.each(["fixed-v1", "fixed-v2"] as const)(
    "rejects a source ID that aliases the %s derived conversion artifact",
    (policy) => {
      const selected = { ...input(), policy };
      const result = convertFigmaSnapshot(selected);
      const projection = result.provenance.evidence.find((entry) =>
        entry.artifact.id.startsWith("conversion_"),
      );
      if (!projection) throw new Error("Missing derived projection identity.");
      selected.manifest.structure.id = projection.artifact.id;
      expect(() => convertFigmaSnapshot(selected)).toThrow(
        "Source artifact collides",
      );
    },
  );
  it("preserves unsupported source and property-level losses instead of flattening", () => {
    const result = convertFigmaSnapshot(
      changed((root, child) => {
        child.effects = [{ type: "LAYER_BLUR", radius: 5 }];
        (root.children as JsonObject[]).push({
          id: "1:4",
          type: "TEXT",
          characters: "Original missing-font text",
          absoluteBoundingBox: { x: 120, y: 260, width: 100, height: 20 },
          style: {
            fontFamily: "Unavailable Original Face",
            fontWeight: 400,
            fontSize: 14,
          },
        });
      }),
    );
    expect(result.report.readiness).toBe("blocked");
    expect(
      result.report.losses.some((loss) => loss.pointer.endsWith("/effects")),
    ).toBe(true);
    expect(
      result.report.diagnostics.some((d) => d.code === "FONT_MISSING"),
    ).toBe(true);
    expect(
      result.design &&
        "children" in result.design.root &&
        result.design.root.children[1]?.type,
    ).toBe("unsupported");
  });

  it("retains malformed selected geometry as diagnostic-only evidence, not a fabricated design", () => {
    const result = convertFigmaSnapshot(
      changed((root) => {
        delete root.absoluteBoundingBox;
      }),
    );
    expect(result.design).toBeUndefined();
    expect(result.report.readiness).toBe("blocked");
    expect(result.originalBytes.length).toBeGreaterThan(0);
  });

  it("rejects corruption, duplicate keys, unrelated selections and unbounded work", () => {
    expect(() =>
      convertFigmaSnapshot({ ...input(), structureBytes: Buffer.from("{}") }),
    ).toThrow();
    expect(() =>
      convertFigmaSnapshot(input(Buffer.from('{"nodes":{},"nodes":{}}'))),
    ).toThrow();
    expect(() =>
      convertFigmaSnapshot(
        changed((_root, _child, nodes) => {
          const selected = nodes["1:2"];
          if (selected === undefined) throw new Error("Missing fixture node.");
          nodes["1:9"] = selected;
        }),
      ),
    ).toThrow();
    expect(() =>
      convertFigmaSnapshot(
        changed((_root, child) => {
          child.id = "1:2";
        }),
      ),
    ).toThrow();
    expect(() => convertFigmaSnapshot(input(), { maxNodes: 1 })).toThrow();
    expect(() =>
      convertFigmaSnapshot(input(), { maxInputBytes: bytes.length - 1 }),
    ).toThrow();
    expect(() =>
      convertFigmaSnapshot(input(), { deadline: 1, now: () => 1 }),
    ).toThrow();
  });
});

it("requires an explicit node and rejects branch/URL ambiguity without network discovery", () => {
  expect(parseFigmaSelection(url)).toEqual({
    fileKey: "SyntheticFixture",
    nodeId: "1:2",
  });
  for (const invalid of [
    "https://www.figma.com/design/SyntheticFixture/Original",
    `${url}&node-id=1-3`,
    `${url}&branch-key=Other`,
    "https://www.figma.com/design/SyntheticFixture/branch/Other/Original?node-id=1-2",
    "https://www.figma.com.evil.test/design/SyntheticFixture/Original?node-id=1-2",
    "https://user@www.figma.com/design/SyntheticFixture/Original?node-id=1-2",
  ])
    expect(() => parseFigmaSelection(invalid)).toThrow();
});
