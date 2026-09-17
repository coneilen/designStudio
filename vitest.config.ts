import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "packages/**/*.smoke.test.ts"],
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
