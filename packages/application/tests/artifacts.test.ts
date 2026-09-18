import { readFile } from "node:fs/promises";
import { type Artifact, DEFAULT_BUDGETS } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { verifyPreviewBytes } from "../src/artifacts.js";

it("derives PNG MIME from exact receipt-bound evidence, never the physical filename", async () => {
  const png = new Uint8Array(
    await readFile("tests\\fixtures\\foundation\\assets\\stripes.png"),
  );
  const physical = (bytes: Uint8Array): Artifact => ({
    id: `sha256_${hashBytes(bytes)}`,
    sha256: hashBytes(bytes),
    byteLength: bytes.length,
    path: `blobs/${hashBytes(bytes)}`,
    mediaType: "application/octet-stream",
  });
  const preview = physical(png);
  const expected = {
    revision: { id: "revision_1", sha256: "a".repeat(64) },
    inputSha256: "a".repeat(64),
    resourcesSha256: "b".repeat(64),
    artifactRootId: "foundation_artifacts",
  };
  const evidence = canonicalBytes({
    version: 1,
    revision: expected.revision,
    artifactRootId: expected.artifactRootId,
    acceptedDesignSha256: expected.inputSha256,
    resourceSnapshotSha256: expected.resourcesSha256,
    artifacts: [{ role: "preview", artifact: preview, mediaType: "image/png" }],
  });
  expect(
    verifyPreviewBytes(
      [preview, physical(evidence)],
      evidence,
      png,
      expected,
      DEFAULT_BUDGETS,
    ).mediaType,
  ).toBe("image/png");
  expect(preview.mediaType).toBe("application/octet-stream");
  const changed = png.slice();
  changed[20] = (changed[20] ?? 0) ^ 1;
  expect(() =>
    verifyPreviewBytes(
      [preview, physical(evidence)],
      evidence,
      changed,
      expected,
      DEFAULT_BUDGETS,
    ),
  ).toThrow();
  expect(() =>
    verifyPreviewBytes([preview], evidence, png, expected, DEFAULT_BUDGETS),
  ).toThrow();
});
