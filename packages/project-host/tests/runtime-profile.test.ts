import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { exactTree } from "../src/installation-manifest.js";
import { ownedTest } from "./support.js";

const execute = promisify(execFile);
const probe = fileURLToPath(
  new URL("./installation-fixtures/runtime-profile-probe.mjs", import.meta.url),
);
const expected = [
  {
    path: "LICENSE",
    bytes: 160555,
    sha256: "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9",
  },
  {
    path: "node.exe",
    bytes: 93580104,
    sha256: "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
  },
];
async function runtime(root: string) {
  const source = path.join(root, "runtime");
  await mkdir(source);
  for (const file of expected)
    await copyFile(
      path.join(path.dirname(process.execPath), file.path),
      path.join(source, file.path),
    );
  return source;
}
async function run(mode: string, source: string, destination: string) {
  const result = await execute(
    process.execPath,
    [probe, mode, source, destination],
    {
      timeout: 15000,
      maxBuffer: 16384,
    },
  );
  return JSON.parse(result.stdout);
}

test("missing or wrong pinned executable and notice fail before any candidate output allocation", async () => {
  await ownedTest(async (root) => {
    const source = await runtime(root);
    const destination = path.join(root, "candidate");
    expect(await run("admission", source, destination)).toMatchObject({
      status: "rejected",
      blocked: 1,
      message: "TEST_BLOCKED_CANDIDATE_ALLOCATION",
    });
    for (const file of expected) {
      const filename = path.join(source, file.path);
      const backup = path.join(source, `${file.path}.saved`);
      await rename(filename, backup);
      try {
        for (const wrong of ["missing", "length", "hash"]) {
          if (wrong === "length")
            await writeFile(filename, "unapproved test bytes");
          if (wrong === "hash") {
            await copyFile(backup, filename);
            const handle = await open(filename, "r+");
            try {
              const byte = Buffer.alloc(1);
              expect((await handle.read(byte, 0, 1, 0)).bytesRead).toBe(1);
              byte.writeUInt8(byte.readUInt8(0) ^ 1);
              await handle.write(byte, 0, 1, 0);
            } finally {
              await handle.close();
            }
          }
          const result = await run("admission", source, destination);
          expect(result, `${file.path}: wrong=${wrong}`).toMatchObject({
            status: "rejected",
            blocked: 0,
          });
          await expect(lstat(destination)).rejects.toMatchObject({
            code: "ENOENT",
          });
          if (wrong !== "missing") await unlink(filename);
        }
      } finally {
        await rm(filename, { force: true });
        await rename(backup, filename);
      }
    }
  });
}, 30000);

test("runtime source junctions, path aliases, case aliases and hard links fail before allocation", async () => {
  await ownedTest(async (root) => {
    const source = await runtime(root);
    const destination = path.join(root, "candidate");
    const junction = path.join(root, "junction");
    await symlink(source, junction, "junction");
    for (const alias of [junction, `${source}${path.sep}.`])
      expect(await run("admission", alias, destination)).toMatchObject({
        status: "rejected",
        blocked: 0,
      });
    const notice = path.join(source, "LICENSE");
    const duplicate = path.join(root, "notice-link");
    await link(notice, duplicate);
    expect(await run("admission", source, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
    });
    await unlink(duplicate);
    await rename(notice, path.join(source, "notice-temporary"));
    await rename(
      path.join(source, "notice-temporary"),
      path.join(source, "license"),
    );
    expect(await run("admission", source, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
}, 30000);

test("fixed runtime copies only exact node.exe and LICENSE as single-link files and rejects reinjected extras", async () => {
  await ownedTest(async (root) => {
    const source = await runtime(root);
    await writeFile(path.join(source, "npm.cmd"), "unused offline tooling");
    await mkdir(path.join(source, "node_modules", "npm"), { recursive: true });
    await writeFile(
      path.join(source, "node_modules", "npm", "index.js"),
      "unused",
    );
    const destination = path.join(root, "selected-runtime");
    expect(await run("copy", source, destination)).toEqual({
      status: "copied",
      blocked: 0,
    });
    expect((await readdir(destination)).sort()).toEqual([
      "LICENSE",
      "node.exe",
    ]);
    for (const file of expected) {
      const filename = path.join(destination, file.path);
      const info = await lstat(filename);
      expect(info.isFile() && !info.isSymbolicLink()).toBe(true);
      expect(info.nlink).toBe(1);
      expect(info.size).toBe(file.bytes);
      expect(
        createHash("sha256")
          .update(await readFile(filename))
          .digest("hex"),
      ).toBe(file.sha256);
    }
    await exactTree(destination, expected);
    await writeFile(path.join(destination, "npm.cmd"), "reinjected");
    await expect(exactTree(destination, expected)).rejects.toThrow(/extra/);
  });
}, 30000);

test("source changes after admission cannot produce a successful runtime selection", async () => {
  await ownedTest(async (root) => {
    const source = await runtime(root);
    const destination = path.join(root, "selected-runtime");
    expect(await run("copy-tamper", source, destination)).toMatchObject({
      status: "rejected",
      blocked: 0,
      message: expect.stringMatching(/unapproved/i),
    });
    expect((await lstat(destination)).isDirectory()).toBe(true);
  });
}, 30000);

test("candidate CLI has no runtime-selection flag", async () => {
  await ownedTest(async (root) => {
    const script = fileURLToPath(
      new URL("../scripts/package-candidate.mjs", import.meta.url),
    );
    const destination = path.join(root, "candidate");
    await expect(
      execute(
        process.execPath,
        [
          script,
          "--workspace",
          process.cwd(),
          "--node-root",
          path.dirname(process.execPath),
          "--browser-root",
          root,
          "--sqlite-binding",
          path.join(root, "unused.node"),
          "--output",
          destination,
          "--runtime-files",
          "npm.cmd",
        ],
        { timeout: 10000, maxBuffer: 16384 },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Usage:") });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
