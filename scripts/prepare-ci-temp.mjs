import { appendFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile)
  throw new Error("CI temporary-directory setup requires GITHUB_ENV.");

const directory = await realpath(tmpdir());
if (!(await stat(directory)).isDirectory() || /[\r\n]/.test(directory))
  throw new Error(
    "CI temporary directory must be a real single-line directory.",
  );

// Resolve runner aliases before tests create roots; production alias checks stay strict.
await appendFile(
  environmentFile,
  `TEMP=${directory}\nTMP=${directory}\n`,
  "utf8",
);
