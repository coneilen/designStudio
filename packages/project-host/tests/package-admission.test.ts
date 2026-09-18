import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ownedTest } from "./support.js";

const execute = promisify(execFile);
const probe = fileURLToPath(
  new URL("./installation-fixtures/admission-probe.mjs", import.meta.url),
);
async function manifest(directory: string, value: object): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(value));
}
async function admission(
  workspace: string,
  destination: string,
): Promise<{ status: string; blocked: number; message?: string }> {
  const result = await execute(
    process.execPath,
    [probe, workspace, destination],
    { timeout: 10000, maxBuffer: 16384 },
  );
  return JSON.parse(result.stdout);
}

test("untrusted package names are rejected before any candidate allocation can escape", async () => {
  await ownedTest(async (root) => {
    const workspace = path.join(root, "workspace");
    const destination = path.join(root, "candidate", "payload", "node_modules");
    await mkdir(destination, { recursive: true });
    const sentinel = path.join(root, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    for (const name of [
      "../../../escaped-package",
      "..\\escaped-package",
      path.join(root, "absolute"),
      "/absolute",
      "@scope/../../escaped-package",
      "@scope\\escaped",
      "Uppercase",
      "@Scope/name",
      ".",
      "..",
      "@scope/name/extra",
      "con",
      "@scope/nul.txt",
      "trailing.",
      "percent%2fescape",
    ]) {
      await manifest(path.join(workspace, "packages", "root"), {
        name,
        version: "1.0.0",
      });
      const result = await admission(workspace, destination);
      expect(result, name).toMatchObject({ status: "rejected", blocked: 0 });
      expect(result.message, name).toMatch(/package name/i);
      expect(await readdir(destination)).toEqual([]);
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
    }
  });
});

test("dependency keys, duplicate workspace names and resolved-name mismatches fail admission", async () => {
  await ownedTest(async (root) => {
    const destination = path.join(root, "candidate", "node_modules");
    await mkdir(destination, { recursive: true });
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(workspace, "packages", "root");
    await manifest(packageRoot, {
      name: "safe-root",
      version: "1.0.0",
      dependencies: { "../../escape": "1" },
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/package name/i),
    });
    await manifest(packageRoot, {
      name: "safe-root",
      version: "1.0.0",
      optionalDependencies: { "../linux-escape": "1" },
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/package name/i),
    });
    await manifest(packageRoot, {
      name: "safe-root",
      version: "1.0.0",
      dependencies: { wanted: "1" },
    });
    await manifest(path.join(packageRoot, "node_modules", "wanted"), {
      name: "different",
      version: "1.0.0",
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/requested.*name/i),
    });
    for (const name of [
      "../../dependency-escape",
      "@scope/../escape",
      "bad\\name",
      "UPPERCASE",
    ]) {
      await manifest(path.join(packageRoot, "node_modules", "wanted"), {
        name,
        version: "1.0.0",
      });
      expect(await admission(workspace, destination)).toMatchObject({
        status: "rejected",
        blocked: 0,
        message: expect.stringMatching(/package name/i),
      });
    }
    await manifest(path.join(packageRoot, "node_modules", "wanted"), {
      name: "wanted",
      version: "1.0.0",
      dependencies: { "@scope/../../escape": "1" },
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/package name/i),
    });
    await manifest(packageRoot, { name: "safe-root", version: "1.0.0" });
    await manifest(path.join(workspace, "packages", "other"), {
      name: "safe-root",
      version: "1.0.0",
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/duplicate/i),
    });
    await manifest(path.join(workspace, "packages", "other"), {
      name: "SAFE-ROOT",
      version: "1.0.0",
    });
    expect(await admission(workspace, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/package name/i),
    });
    expect(await readdir(destination)).toEqual([]);
  });
});

test("canonical scoped dependencies materialize only inside the exact candidate node_modules", async () => {
  await ownedTest(async (root) => {
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(workspace, "packages", "root");
    const destination = path.join(root, "candidate", "node_modules");
    await mkdir(destination, { recursive: true });
    await manifest(packageRoot, {
      name: "safe-root",
      version: "1.0.0",
      files: [],
      dependencies: { "@scope/safe.name": "1" },
    });
    await manifest(
      path.join(packageRoot, "node_modules", "@scope", "safe.name"),
      { name: "@scope/safe.name", version: "1.0.0" },
    );
    expect(await admission(workspace, destination)).toEqual({
      status: "copied",
      blocked: 0,
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(destination, "@scope", "safe.name", "package.json"),
          "utf8",
        ),
      ).name,
    ).toBe("@scope/safe.name");
  });
});
