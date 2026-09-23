import assert from "node:assert/strict";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";
import { createVitest } from "vitest/node";
import { assertUnitPartition } from "../tests/unit-partition.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const normalize = (filename) => filename.split(path.sep).join("/");
// This is the original default-unit discovery, independently of the new phase exclusions.
const original = globSync("packages/**/*.test.ts", {
  cwd: root,
  exclude: [...configDefaults.exclude, "packages/**/*.smoke.test.ts"],
}).map(normalize);
const runner = await createVitest("test", {
  root,
  project: ["unit", "native"],
  watch: false,
});
try {
  // Resolve configured file globs only: never import/collect/execute test modules here.
  const specs = await runner.globTestSpecifications();
  const byProject = (name) =>
    specs
      .filter((spec) => spec.project.name === name)
      .map((spec) => normalize(path.relative(root, spec.moduleId)));
  const counts = assertUnitPartition(
    original,
    byProject("unit"),
    byProject("native"),
  );
  const portable = runner.projects.find((project) => project.name === "unit");
  const native = runner.projects.find((project) => project.name === "native");
  assert.equal(portable?.config.maxWorkers, 2);
  assert.equal(native?.config.maxWorkers, 1);
  assert.equal(native?.config.fileParallelism, false);
  console.log(
    JSON.stringify(
      {
        status: "exact-disjoint-unit-partition",
        ...counts,
        portableWorkers: 2,
        nativeWorkers: 1,
        testModulesExecuted: false,
        portableFiles: byProject("unit").sort(),
        nativeFiles: byProject("native").sort(),
      },
      null,
      2,
    ),
  );
} finally {
  await runner.close();
}
