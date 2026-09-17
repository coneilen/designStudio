import { readFile } from "node:fs/promises";
import type { FixtureInstallationLease } from "@design-studio/project-host";
import { createWorker } from "@design-studio/renderer";

export async function createInstalledWorker(
  installation: FixtureInstallationLease,
) {
  const manifest: unknown = JSON.parse(
    await readFile(
      new URL("../generated/browser-inventory.json", import.meta.url),
      "utf8",
    ),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("files" in manifest) ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Approved browser inventory unavailable.");
  const files = manifest.files.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !("byteLength" in entry) ||
      typeof entry.byteLength !== "number"
    )
      throw new Error("Invalid approved browser inventory.");
    return {
      path: entry.path,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
    };
  });
  return createWorker({
    root: installation.paths.browserRoot,
    executable:
      "chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
    files,
  });
}
