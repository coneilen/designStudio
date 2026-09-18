import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/prepare-ci-temp.mjs", import.meta.url),
);

it.runIf(process.platform === "win32")(
  "canonicalizes a runner temp alias for subsequent steps without changing its target",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ci-temp-")));
    const target = path.join(root, "real");
    const alias = path.join(root, "alias");
    const environmentFile = path.join(root, "environment");
    try {
      await mkdir(target);
      await symlink(target, alias, "junction");
      await writeFile(environmentFile, "");
      expect(await realpath(alias)).not.toBe(alias);
      await execute(process.execPath, [script], {
        env: {
          ...process.env,
          TEMP: alias,
          TMP: alias,
          GITHUB_ENV: environmentFile,
        },
      });
      const canonical = await realpath(target);
      expect(await readFile(environmentFile, "utf8")).toBe(
        `TEMP=${canonical}\nTMP=${canonical}\n`,
      );
      const { stdout } = await execute(
        process.execPath,
        ["-e", "console.log(require('node:os').tmpdir())"],
        { env: { ...process.env, TEMP: canonical, TMP: canonical } },
      );
      expect(stdout.trim()).toBe(canonical);
      expect(await realpath(alias)).toBe(canonical);
    } finally {
      await rm(alias, { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform === "win32")(
  "does not publish environment changes when the runner temp root is missing",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ci-temp-")));
    const environmentFile = path.join(root, "environment");
    const missing = path.join(root, "missing");
    try {
      await writeFile(environmentFile, "UNCHANGED=1\n");
      await expect(
        execute(process.execPath, [script], {
          env: {
            ...process.env,
            TEMP: missing,
            TMP: missing,
            GITHUB_ENV: environmentFile,
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(environmentFile, "utf8")).toBe("UNCHANGED=1\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
