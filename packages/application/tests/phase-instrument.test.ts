import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
    const installationPath = path.join(
      root,
      "packages",
      "project-host",
      "dist",
      "installation.js",
    );
    const installationBefore = await readFile(installationPath, "utf8");
    const captureWrappers = (text: string) => [
      text.match(
        /export async function verifyCaptureInstallation\(\) \{[\s\S]*?\n\}/,
      )?.[0],
      text.match(
        /export async function verifyCaptureInstalledRoot\(root\) \{[\s\S]*?\n\}/,
      )?.[0],
    ];
    expect(captureWrappers(installationBefore).every(Boolean)).toBe(true);
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
    const installation = await readFile(
      path.join(root, "packages", "project-host", "dist", "installation.js"),
      "utf8",
    );
    expect(installation).toContain('import "./f08-diagnostics.mjs";');
    expect(installation).toContain(
      "diagnosticVerifyInstalledRoot(root, trace)",
    );
    expect(installation).toContain(
      "verifyTree(native, root, allFiles(meta), sid, true, trace)",
    );
    expect(captureWrappers(installation)).toEqual(
      captureWrappers(installationBefore),
    );
    expect(installation).toContain(
      'const lease = await verifyProfileRoot(root, "fixture", trace);',
    );
    expect(installation).toContain(
      "async function verifyProfileRoot(root, profile, trace) {",
    );
    expect(
      installation.match(
        /export async function verifyFixtureInstallation\(\) \{[\s\S]*?\n\}/,
      )?.[0],
    ).toContain(
      "const result = await verifyInstalledRoot(await verifiedBootstrapRoot());",
    );
    expect(installation.match(/"verify-start"/g)).toHaveLength(1);
    expect(
      installation.match(/const trace = traceInstallation\(true\)/g),
    ).toHaveLength(1);
    const native = await readFile(
      path.join(root, "packages", "project-host", "dist", "native.js"),
      "utf8",
    );
    expect(native).toContain('nativeCapture.measure("open"');
    expect(native).toContain('nativeCapture.measure("acl"');
    expect(native).toContain('nativeCapture.measure("inspect"');
    expect(native).toContain('nativeCapture.measure("pin"');
    for (const filename of [
      "installation.js",
      "native.js",
      "f08-diagnostics.mjs",
      "f08-native-timing.mjs",
    ])
      await promisify(execFile)(process.execPath, [
        "--check",
        path.join(root, "packages", "project-host", "dist", filename),
      ]);
    await expect(instrumentCandidate(root, diagnostics)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});

import { execFile } from "node:child_process";
