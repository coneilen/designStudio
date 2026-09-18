import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("built storage package exposes its actual public entrypoint", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { LocalStore, StorageError, encodeBackup, decodeBackup } from "@design-studio/storage";
    if ([LocalStore.open, encodeBackup, decodeBackup].some(value => typeof value !== "function")) process.exit(1);
    if (new StorageError("CONFLICT", "test").code !== "CONFLICT") process.exit(2);
    console.log("storage-package-ok");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 262144,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("storage-package-ok");
});
