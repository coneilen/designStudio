import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ownedTest } from "./support.js";

test("pinned Node synchronous guards cover ESM, CommonJS and createRequire without outside fallback", async () => {
  await ownedTest(async (root) => {
    const app = path.join(root, "app");
    await mkdir(app);
    await writeFile(path.join(app, "good.cjs"), "module.exports = 42;");
    await writeFile(path.join(app, "good.mjs"), "export default 42;");
    await writeFile(
      path.join(root, "outside.cjs"),
      "throw new Error('outside code executed');",
    );
    await cp(
      new URL("./installation-fixtures/resolution-probe.mjs", import.meta.url),
      path.join(app, "probe.mjs"),
    );
    await cp(
      new URL("../dist/installation-resolver.js", import.meta.url),
      path.join(app, "resolver.mjs"),
    );
    const result = await promisify(execFile)(
      process.execPath,
      [path.join(app, "probe.mjs")],
      {
        timeout: 10000,
        maxBuffer: 16384,
        env: { SystemRoot: process.env.SystemRoot, TZ: "UTC" },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      esm: 42,
      require: 42,
      createRequire: 42,
      denied: 3,
    });
  });
});
