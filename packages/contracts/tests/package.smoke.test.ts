import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("imports built ESM, public schema and explicitly labeled test utilities by package name", async () => {
  const consumer = fileURLToPath(
    new URL("./consume-package.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL(
      "../../../tests/fixtures/foundation/settings-screen.design.json",
      import.meta.url,
    ),
  );
  const result = await promisify(execFile)(
    process.execPath,
    [consumer, fixture],
    { timeout: 5_000, maxBuffer: 65_536 },
  );
  expect(JSON.parse(result.stdout)).toEqual({
    designId: "design_settings-screen",
    schemaRef: "foundation.schema.json#/definitions/DesignIR",
    implementation: "test-fake",
  });
  expect(result.stderr).toBe("");
});
