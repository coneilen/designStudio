import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const consumer = fileURLToPath(
  new URL("./fixtures/consume-package.mjs", import.meta.url),
);

function runConsumer(directory: string, fixture: string) {
  return execute(process.execPath, [consumer, fixture], {
    cwd: directory,
    timeout: 5_000,
    maxBuffer: 16_384,
  });
}

it("imports the built package by its public name and fingerprints binary fixture bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-studio smoke "));
  try {
    const fixture = join(directory, "fixture & caf\u00e9.bin");
    await writeFile(fixture, Uint8Array.of(0, 255, 13, 10, 97, 98, 99));
    const result = await runConsumer(directory, fixture);

    expect(result.stdout).toBe(
      "6c054d2caf0b5ac869dac381d6995fba75212ea0532f3500bacac9a344378802",
    );
    expect(result.stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("propagates a missing fixture as a failed consumer process, not a success digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-studio smoke "));
  try {
    await expect(
      runConsumer(directory, join(directory, "missing.bin")),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ENOENT"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
