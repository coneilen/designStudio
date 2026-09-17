import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

it("collects owned unit tests without traversing workspace dependency links", async () => {
  const { stdout } = await execute(
    process.execPath,
    [cli, "list", "--project", "unit", "--json"],
    { cwd: root, timeout: 30_000, maxBuffer: 2_097_152 },
  );
  const collected: unknown = JSON.parse(stdout);
  if (!Array.isArray(collected))
    throw new Error("Expected the test collector to return an array.");
  const files = collected.map((entry: unknown) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("file" in entry) ||
      typeof entry.file !== "string"
    )
      throw new Error("Expected every collected test to identify its file.");
    return entry.file;
  });
  expect(files.length).toBeGreaterThan(0);
  const dependencyFiles = [
    ...new Set(files.filter((file) => /[/\\]node_modules[/\\]/.test(file))),
  ];
  expect(dependencyFiles).toEqual([]);
}, 35_000);
