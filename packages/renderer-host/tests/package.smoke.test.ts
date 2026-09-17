import { spawnSync } from "node:child_process";
import path from "node:path";
import type {
  RendererWorkerLease,
  RendererWorkerOptions,
  TrustedRendererImplementation,
} from "@design-studio/renderer-host";
import { expect, it } from "vitest";

type PublicPort = Pick<RendererWorkerLease, "exchange" | "close" | "closed">;
const publicTypes: [
  keyof PublicPort,
  keyof RendererWorkerOptions,
  keyof TrustedRendererImplementation,
] = ["closed", "implementation", "render"];
it("built public package imports in a fresh Node process without opening native capability", () => {
  expect(publicTypes).toEqual(["closed", "implementation", "render"]);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import('@design-studio/renderer-host'); if (typeof m.RendererWorkerHost !== 'function') process.exit(2); console.log('import-only');",
    ],
    {
      cwd: path.resolve("packages/renderer-host"),
      env: {},
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe("import-only");
});
