import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { type Artifact, parseContract } from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import { ApplicationError } from "./response.js";
import { PROJECT_ID } from "./routes.js";

export const CATALOG_SHA256 =
  "64a32cfab49a3835a515f0c6bb5b3c850a88956052aafc5321577dd58517ae54";
export const FIXTURE_IDS = [
  "settings-screen",
  "mixed-styled-text",
  "image-crop-transform",
  "component-variants-slots",
  "unsupported-feature",
] as const;
export async function boundedFile(
  root: string,
  relative: string,
  maximum: number,
): Promise<Uint8Array> {
  if (
    !relative ||
    /[%\\:]/.test(relative) ||
    relative.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new ApplicationError("PATH_FORBIDDEN", 403);
  const file = path.join(root, ...relative.split("/"));
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maximum
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  if ((await realpath(file)).toLowerCase() !== file.toLowerCase())
    throw new ApplicationError("PATH_FORBIDDEN", 403);
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    const bytes = new Uint8Array(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > maximum ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      length !== after.size
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    return bytes.slice(0, length);
  } finally {
    await handle.close();
  }
}
export async function loadCatalog(root: string) {
  root = path.resolve(root);
  const manifestBytes = await boundedFile(root, "manifest.json", 12703);
  if (
    manifestBytes.length !== 12703 ||
    hashBytes(manifestBytes) !== CATALOG_SHA256
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  // The exact reviewed byte pin precedes interpretation; this is not provenance for user catalogs.
  const manifest: unknown = JSON.parse(
    Buffer.from(manifestBytes).toString("utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("files" in manifest) ||
    !Array.isArray(manifest.files)
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  const files = new Map<string, { artifact: Artifact; bytes: Uint8Array }>();
  for (const entry of manifest.files) {
    const artifact = parseContract("Artifact", JSON.stringify(entry), "json");
    const bytes = await boundedFile(root, artifact.path, artifact.byteLength);
    if (
      hashBytes(bytes) !== artifact.sha256 ||
      bytes.length !== artifact.byteLength ||
      files.has(artifact.path)
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    files.set(artifact.path, { artifact, bytes });
  }
  function bytes(name: string) {
    const file = files.get(name);
    if (!file) throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    return file.bytes.slice();
  }
  return {
    identity: CATALOG_SHA256,
    manifestBytes: manifestBytes.slice(),
    fixture(id: string) {
      if (!FIXTURE_IDS.some((candidate) => candidate === id))
        throw new ApplicationError("NOT_FOUND", 404);
      const designBytes = bytes(`${id}.design.json`);
      const resourceBytes = bytes("resources.json");
      const provenanceBytes = bytes(`${id}.provenance.json`);
      const design = parseContract(
        "DesignIR",
        Buffer.from(designBytes).toString("utf8"),
        "json",
      );
      const resources = parseContract(
        "ResourceSnapshot",
        Buffer.from(resourceBytes).toString("utf8"),
        "json",
      );
      const provenance = parseContract(
        "ProvenanceSnapshot",
        Buffer.from(provenanceBytes).toString("utf8"),
        "json",
      );
      if (
        design.projectId !== PROJECT_ID ||
        resources.projectId !== PROJECT_ID ||
        design.designId !== `design_${id}`
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
      return {
        design,
        resources,
        provenance,
        designBytes,
        resourceBytes,
        provenanceBytes,
        artifacts: [...files.values()].map((file) => ({
          artifact: structuredClone(file.artifact),
          bytes: file.bytes.slice(),
        })),
      };
    },
  };
}
export type FixtureCatalog = Awaited<ReturnType<typeof loadCatalog>>;
