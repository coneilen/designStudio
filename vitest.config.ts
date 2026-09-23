import { configDefaults, defineConfig } from "vitest/config";
import { nativeUnitFiles } from "./tests/unit-partition.js";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "packages/**/*.smoke.test.ts",
            ...nativeUnitFiles,
          ],
          maxWorkers: 2,
        },
      },
      {
        test: {
          name: "native",
          environment: "node",
          include: nativeUnitFiles,
          exclude: [...configDefaults.exclude, "packages/**/*.smoke.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "smoke",
          environment: "node",
          include: ["tests/**/*.smoke.test.ts", "packages/**/*.smoke.test.ts"],
          testTimeout: 10_000,
        },
      },
    ],
  },
});
