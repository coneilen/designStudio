import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts"],
          exclude: ["packages/**/*.smoke.test.ts"],
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
