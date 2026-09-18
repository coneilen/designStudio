import { readFile } from "node:fs/promises";
import { hashBytes } from "@design-studio/design-ir";
import {
  convertFigmaSnapshot,
  verifyFigmaConversion,
} from "@design-studio/figma-import";

const bytes = await readFile(process.argv[2]);
const input = {
  manifest: {
    schemaVersion: "1.0",
    format: "figma-rest-nodes-v1",
    selectionUrl:
      "https://www.figma.com/design/SyntheticFixture/Original?node-id=1-2",
    structure: {
      id: "original",
      path: "raw.json",
      mediaType: "application/json",
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    },
    assets: [],
    fonts: [],
  },
  structureBytes: bytes,
  projectId: "project_test",
  designId: "design_test",
  intakeId: "intake_test",
  actorId: "actor_test",
  observedAt: "2026-09-18T00:00:00Z",
};
const result = convertFigmaSnapshot(input);
verifyFigmaConversion(input, result);
console.log(
  JSON.stringify({
    transport: result.source.identity.transport,
    consistency: result.source.consistency.guarantee,
    draft: result.design?.designId,
    readiness: result.report.readiness,
  }),
);
