import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports the built public package in a clean Node process without touching any native vault", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const host = await import("@design-studio/host");
    for (const name of ["SystemClock", "OperationGuard", "authorizeOperation", "snapshotOperationContext", "ProjectFileSystem",
      "ConfiguredToolLocator", "BoundedProcessRunner", "LocalSessionAuthenticator",
      "ScopedCredentialStore", "NapiCredentialBackend", "nativeVaultCapability", "Redactor", "decideEgress"]) {
      if (typeof host[name] !== "function") throw new Error("Missing export: " + name);
    }
    if (host.WINDOWS_PUBLICATION_PROFILE !== "windows-ntfs-write-through-v1") throw new Error("Missing explicit native profile");
    process.stdout.write("host-public-import-ok");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {},
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("host-public-import-ok");
});
