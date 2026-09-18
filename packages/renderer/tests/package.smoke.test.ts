import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("built public API imports without native worker launch or browser acquisition", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m=await import('@design-studio/renderer'); for(const k of ['StaticRenderer','renderStaged','createWorker','installedBuildIdentity']) if(typeof m[k]!=='function') throw Error(k); console.log('renderer-import-only');",
    ],
    {
      cwd: path.resolve("packages/renderer"),
      env: {},
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe("renderer-import-only");
});
