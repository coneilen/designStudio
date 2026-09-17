import { decodeRaster } from "@design-studio/assets";
import {
  type Artifact,
  type ArtifactReference,
  type Budget,
  parseContract,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { ApplicationError } from "./response.js";

// Pure integrity check, called only after current authorization and trusted store receipt lookup.
export function verifyPreviewBytes(
  outputs: readonly Artifact[],
  evidenceBytes: Uint8Array,
  png: Uint8Array,
  expected: {
    revision: ArtifactReference;
    inputSha256: string;
    resourcesSha256: string;
    artifactRootId: string;
  },
  budget: Budget,
): { artifact: Artifact; bytes: Uint8Array; mediaType: "image/png" } {
  const fail = (): never => {
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  };
  if (
    evidenceBytes.length > budget.maxInputBytes ||
    png.length > budget.maxOutputBytes
  )
    fail();
  const evidenceArtifact = outputs.find(
    (artifact) =>
      artifact.sha256 === hashBytes(evidenceBytes) &&
      artifact.byteLength === evidenceBytes.length,
  );
  if (!evidenceArtifact) fail();
  const value = parseContract(
    "JsonValue",
    Buffer.from(evidenceBytes).toString("utf8"),
    "json",
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  if (
    value.version !== 1 ||
    value.artifactRootId !== expected.artifactRootId ||
    canonicalDigest(value.revision) !== canonicalDigest(expected.revision) ||
    value.acceptedDesignSha256 !== expected.inputSha256 ||
    value.resourceSnapshotSha256 !== expected.resourcesSha256 ||
    !Array.isArray(value.artifacts)
  )
    return fail();
  let preview: Artifact | undefined;
  const seen = new Set<string>();
  for (const item of value.artifacts) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.role !== "string" ||
      seen.has(item.role)
    )
      return fail();
    seen.add(item.role);
    const checked = validateContract("Artifact", item.artifact);
    if (
      !checked.success ||
      !outputs.some(
        (artifact) =>
          canonicalDigest(artifact) === canonicalDigest(checked.value),
      )
    )
      return fail();
    if (item.role === "preview") {
      if (
        item.mediaType !== "image/png" ||
        checked.value.mediaType !== "application/octet-stream"
      )
        return fail();
      preview = checked.value;
    }
  }
  if (
    !preview ||
    preview.sha256 !== hashBytes(png) ||
    preview.byteLength !== png.length
  )
    return fail();
  decodeRaster(png, budget);
  return { artifact: preview, bytes: png.slice(), mediaType: "image/png" };
}
