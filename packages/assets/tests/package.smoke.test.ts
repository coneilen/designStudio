import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports built asset public exports in a fresh offline Node process", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { ASSET_PROFILE, AssetPipeline, decodeRaster, verifyFont, fetchRemote } from '@design-studio/assets'; if ([AssetPipeline, decodeRaster, verifyFont, fetchRemote].some(x => typeof x !== 'function')) throw Error('missing public API'); console.log(ASSET_PROFILE.adapterVersion);",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
    },
  );
  expect(output.trim()).toBe("assets-1.0.0");
});
