import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("consumes the built public kernel from a separate Node process", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./consume-package.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    imported: true,
    fixtures: 5,
    unsupported: "blocked",
  });
});
