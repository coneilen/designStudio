import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps masked input internal and Figma enrollment out of the built public CLI", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const cli = await import("@design-studio/cli");
    if (typeof cli.parseArguments !== "function" || typeof cli.launchLocalSession !== "function") throw new Error("Public API missing");
    if ("readMaskedSecret" in cli || "readMaskedSecretFromTerminal" in cli) throw new Error("Secret input leaked into public API");
    for (const name of ["@design-studio/cli/masked-secret", "@design-studio/cli/dist/masked-secret-input.js"]) {
      try { await import(name); throw new Error("Internal entry became public"); }
      catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }
    }
    let rejected = false;
    try { cli.parseArguments(["figma", "credential", "setup"]); }
    catch { rejected = true; }
    if (!rejected) throw new Error("Unapproved enrollment command");
    process.stdout.write("cli-public-boundary-ok");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {},
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("cli-public-boundary-ok");
});
