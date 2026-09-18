import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { instrumentCandidate } from "./phase-instrument.js";

it("patches only expected copied functions exactly once before inventory and leaves real entrypoints unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f08-hook-test-"));
  const diagnostics = path.join(root, "diagnostics");
  await mkdir(diagnostics);
  try {
    for (const name of ["application", "project-host"]) {
      await mkdir(path.join(root, "packages", name), { recursive: true });
      await cp(
        path.resolve("packages", name, "dist"),
        path.join(root, "packages", name, "dist"),
        { recursive: true },
      );
    }
    const entry = path.join(
      root,
      "packages",
      "application",
      "dist",
      "render-worker.js",
    );
    const before = await readFile(entry);
    await instrumentCandidate(root, diagnostics);
    expect(await readFile(entry)).toEqual(before);
    const changed = await readFile(
      path.join(
        root,
        "packages",
        "application",
        "dist",
        "installed-project.js",
      ),
      "utf8",
    );
    expect(changed).toContain('"worker-open"');
    expect(changed).toContain('"claimed"');
    expect(changed).toContain("await worker.open(context)");
    await expect(instrumentCandidate(root, diagnostics)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});
