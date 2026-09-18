import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ownedTest } from "./support.js";

const probe = fileURLToPath(
  new URL(
    "./installation-fixtures/browser-inventory-probe.mjs",
    import.meta.url,
  ),
);
test("browser inventory is byte bounded and fully validated before path traversal or copying", async () => {
  await ownedTest(async (root) => {
    const filename = path.join(root, "browser.json");
    const files = Array.from({ length: 299 }, (_, index) => ({
      path: `browser/file-${index}`,
      byteLength: 0,
      sha256: "1".repeat(64),
    }));
    const run = async (value: unknown, padding = "") => {
      await writeFile(filename, JSON.stringify(value) + padding);
      const result = await promisify(execFile)(
        process.execPath,
        [probe, filename],
        { timeout: 10000, maxBuffer: 16384 },
      );
      return JSON.parse(result.stdout);
    };
    const good = { playwright: "1.63.0", files };
    expect(await run(good)).toEqual({ status: "accepted", files: 299 });
    const padding = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(good));
    expect(await run(good, " ".repeat(padding))).toEqual({
      status: "accepted",
      files: 299,
    });
    expect(await run(good, " ".repeat(padding + 1))).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/bounds/),
    });
    for (const value of [
      null,
      [],
      { playwright: "1.63.0", files: { length: 299 } },
      { ...good, files: files.slice(1) },
      { ...good, files: [...files, files[0]] },
      {
        ...good,
        files: files.map((file, i) =>
          i ? file : { ...file, path: "../escape" },
        ),
      },
      {
        ...good,
        files: files.map((file, i) =>
          i ? file : { ...file, path: "browser/FILE-1" },
        ),
      },
      {
        ...good,
        files: files.map((file, i) => (i ? file : { ...file, byteLength: -1 })),
      },
      {
        ...good,
        files: files.map((file, i) =>
          i ? file : { ...file, byteLength: 512 * 1024 * 1024 + 1 },
        ),
      },
      {
        ...good,
        files: files.map((file) => ({
          ...file,
          byteLength: 512 * 1024 * 1024,
        })),
      },
      {
        ...good,
        files: files.map((file, i) => (i ? file : { ...file, sha256: "bad" })),
      },
      { ...good, files: files.map((file, i) => (i ? file : null)) },
    ]) {
      expect(await run(value)).toMatchObject({ status: "rejected" });
    }
  });
});
