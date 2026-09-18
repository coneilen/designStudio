import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("consumes the built pure converter by package name in a clean process", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./consume-package.mjs", import.meta.url)),
      fileURLToPath(
        new URL(
          "../../../tests/fixtures/figma-import/frame.json",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 5000, maxBuffer: 65536 },
  );
  expect(JSON.parse(stdout)).toEqual({
    transport: "figma-offline",
    consistency: "unknown",
    draft: "design_test",
    readiness: "needs-review",
  });
  expect(stderr).toBe("");
});
