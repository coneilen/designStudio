import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { convertFigmaSnapshot, convertFigmaStructure } from "../src/index.js";

const envelope = {
  version: "synthetic_version",
  nodes: {
    "1:2": {
      document: {
        id: "1:2",
        type: "FRAME",
        name: "Selected",
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        children: [],
      },
    },
    "9:9": {
      document: {
        id: "9:9",
        type: "TEXT",
        characters: "Unselected",
        style: {},
      },
    },
  },
};
function input() {
  const structureBytes = canonicalBytes(envelope);
  return {
    selection: { fileKey: "SyntheticFile", nodeId: "1:2" },
    structure: {
      id: "raw_original",
      path: "raw.json",
      mediaType: "application/octet-stream",
      byteLength: structureBytes.length,
      sha256: hashBytes(structureBytes),
    },
    structureBytes,
    projectId: "project_one",
    designId: "design_one",
    intakeId: "capture_one",
    actorId: "actor_one",
    observedAt: "2026-09-18T00:00:00Z",
  };
}
it("converts only a selected view while preserving original envelope/hash/pointers and issuing no source identity", () => {
  const request = input();
  const result = convertFigmaStructure(request);
  expect("source" in result).toBe(false);
  expect(Buffer.from(result.originalBytes)).toEqual(
    Buffer.from(request.structureBytes),
  );
  expect(result.conversionEvidence.source.sha256).toBe(
    hashBytes(request.structureBytes),
  );
  expect(result.sourceMap.entries.map((entry) => entry.sourceNodeId)).toEqual([
    "1:2",
  ]);
  expect(
    result.provenance.evidence.every((entry) => entry.sourceNodeId !== "9:9"),
  ).toBe(true);
  expect(result.report.readiness).not.toBe("ready");
});
it("preserves strict offline subtree admission instead of laundering a sibling envelope", () => {
  const request = input();
  expect(() =>
    convertFigmaSnapshot({
      ...request,
      manifest: {
        schemaVersion: "1.0",
        format: "figma-rest-nodes-v1",
        selectionUrl:
          "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
        structure: { ...request.structure, mediaType: "application/json" },
        assets: [],
        fonts: [],
      },
    }),
  ).toThrow();
});
