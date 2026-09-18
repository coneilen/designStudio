import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { HostBoundaryError } from "@design-studio/host";

export async function installedBuildIdentity() {
  async function identity(directory: string, name: string) {
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".js"))
      .sort();
    if (!files.length || files.length > 64)
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Installed compiler manifest limit.",
      );
    const entries = [];
    let total = 0;
    for (const file of files) {
      const location = path.join(directory, file),
        stat = await lstat(location);
      total += stat.size;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        total > 5 * 1024 * 1024
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Invalid installed compiler resource.",
        );
      const bytes = await readFile(location);
      entries.push({
        path: file,
        byteLength: bytes.byteLength,
        sha256: hashBytes(bytes),
      });
    }
    return { name, version: "1.0.0", sha256: canonicalDigest(entries) };
  }
  return {
    renderer: await identity(
      fileURLToPath(new URL("../dist/", import.meta.url)),
      "@design-studio/renderer",
    ),
    kernel: await identity(
      path.dirname(
        fileURLToPath(import.meta.resolve("@design-studio/design-ir")),
      ),
      "@design-studio/design-ir",
    ),
  };
}
