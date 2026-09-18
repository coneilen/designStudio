import type { DesignNode } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import { type TextRun, textMarkup } from "./document.js";
import { children } from "./layout.js";
import type { PreparedFont } from "./resources.js";

export function validateFaces(
  root: DesignNode,
  fonts: PreparedFont[],
  evidence: unknown,
): void {
  if (!Array.isArray(evidence))
    throw new HostBoundaryError(
      "FONT_FALLBACK",
      "Missing actual-face evidence.",
    );
  const required = new Map<string, PreparedFont[]>();
  function collect(node: DesignNode) {
    if (node.type === "text") {
      const runs: TextRun[] = [];
      textMarkup(node, fonts, [], runs, "proof");
      required.set(
        node.id,
        runs.filter((r) => r.content.trim()).map((r) => r.font),
      );
    } else if (node.type === "unsupported" && fonts[0])
      required.set(node.id, [fonts[0]]);
    for (const child of children(node)) collect(child);
  }
  collect(root);
  const covered = new Set<string>();
  for (const value of evidence) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("nodeId" in value) ||
      typeof value.nodeId !== "string" ||
      !("fontId" in value) ||
      typeof value.fontId !== "string" ||
      !("fontSha256" in value) ||
      !("family" in value) ||
      !("custom" in value) ||
      value.custom !== true ||
      !("glyphs" in value) ||
      typeof value.glyphs !== "number" ||
      !Number.isSafeInteger(value.glyphs) ||
      value.glyphs <= 0
    )
      throw new HostBoundaryError(
        "FONT_FALLBACK",
        "Malformed actual custom-face evidence.",
      );
    const face = required
      .get(value.nodeId)
      ?.find(
        (f) =>
          f.id === value.fontId &&
          f.face.sha256 === value.fontSha256 &&
          f.face.family === value.family,
      );
    if (!face)
      throw new HostBoundaryError(
        "FONT_FALLBACK",
        "Unrequested actual face or text node.",
      );
    covered.add(`${value.nodeId}/${face.face.sha256}`);
  }
  for (const [nodeId, faces] of required)
    for (const face of faces)
      if (!covered.has(`${nodeId}/${face.face.sha256}`))
        throw new HostBoundaryError(
          "FONT_FALLBACK",
          "Missing actual custom-face coverage.",
        );
}
