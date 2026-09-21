import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("built native role metadata and helper import do not prompt, read clipboard, or access vault", () => {
  const entry = fileURLToPath(
    new URL("../dist/capture-main.js", import.meta.url),
  );
  const help = spawnSync(process.execPath, [entry, "--help"], {
    env: {},
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  });
  expect(help.error).toBeUndefined();
  expect(help.status, help.stderr).toBe(0);
  expect(JSON.parse(help.stdout)).toMatchObject({
    status: "complete",
    profile: "figma-capture-v1",
    usage: expect.arrayContaining([expect.stringContaining("figma recover")]),
    limitation: expect.stringContaining("installed recovery supplement"),
  });
  const helper = pathToFileURL(
    fileURLToPath(
      new URL("../../project-host/dist/pat-dialog-helper.js", import.meta.url),
    ),
  ).href;
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(helper)}); process.stdout.write("helper-import-no-effect");`,
    ],
    {
      env: {},
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  expect(imported.error).toBeUndefined();
  expect(imported.status, imported.stderr).toBe(0);
  expect(imported.stdout).toBe("helper-import-no-effect");
});
