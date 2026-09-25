import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const commit = "9bcfbaadca45ac6f4ffb4fcd55e8abd5569fad9a";
const workspace = process.cwd();
const root = process.argv[2];
assert(root && path.isAbsolute(root) && /^ds-ph-/.test(path.basename(root)));
assert(
  !(await lstat(root)).isSymbolicLink() && (await realpath(root)) === root,
);
const target = path.join(root, "v7-source");
await mkdir(target);
const git = (...args) =>
  execFileSync("git", args, { cwd: workspace, maxBuffer: 64 * 1024 * 1024 });
assert.equal(
  git("rev-parse", `${commit}^{tree}`).toString().trim(),
  "cc9c03c45f3ce650322e2be39862420ab6e49675",
);
const listed = git("ls-tree", "-rz", commit)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((line) => {
    const match = /^([0-9]+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert(match);
    return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
  })
  .filter(
    (entry) =>
      entry &&
      (/^packages\/[^/]+\/(?:src|tests|schemas|generated|bootstrap)\//.test(
        entry.name,
      ) ||
        /^packages\/[^/]+\/package\.json$/.test(entry.name) ||
        /^tests\/(?:fixtures|unit-partition)/.test(entry.name)),
  );
for (const entry of listed) {
  assert.equal(
    entry.mode,
    "100644",
    "Pinned source must not be a symlink or executable alias",
  );
  assert.equal(entry.type, "blob");
}
assert(listed.length > 100 && listed.length <= 1200);
const objects = execFileSync("git", ["cat-file", "--batch"], {
  cwd: workspace,
  input: `${listed.map((entry) => entry.oid).join("\n")}\n`,
  maxBuffer: 64 * 1024 * 1024,
});
let offset = 0,
  sourceBytes = 0,
  physicalFiles = 0,
  physicalBytes = 0;
const hashes = [];
const physical = new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function put(name, bytes) {
  assert(
    !name.includes("\\") &&
      !name.split("/").some((part) => part === ".." || part === "." || !part),
  );
  physicalFiles++;
  physicalBytes += bytes.length;
  assert(physicalFiles <= 6500 && physicalBytes <= 256 * 1024 * 1024);
  const filename = path.join(target, ...name.split("/"));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes, { flag: "wx" });
  physical.set(name, {
    path: name,
    byteLength: bytes.length,
    sha256: hash(bytes),
  });
}
for (const entry of listed) {
  const end = objects.indexOf(10, offset);
  assert(end > offset);
  const header = objects.subarray(offset, end).toString();
  const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
  assert(match && match[1] === entry.oid);
  const length = Number(match[2]);
  const bytes = objects.subarray(end + 1, end + 1 + length);
  offset = end + 1 + length + 1;
  assert.equal(bytes.length, length);
  assert.equal(
    createHash("sha1").update(`blob ${length}\0`).update(bytes).digest("hex"),
    entry.oid,
  );
  sourceBytes += length;
  assert(sourceBytes <= 40 * 1024 * 1024);
  await put(entry.name, bytes);
  hashes.push({ path: entry.name, oid: entry.oid, sha256: hash(bytes) });
  const compiled = /^(packages\/[^/]+)\/src\/(.+)\.ts$/.exec(entry.name);
  if (compiled && !entry.name.endsWith(".d.ts")) {
    const output = stripTypeScriptTypes(bytes.toString(), {
      mode: "transform",
      sourceUrl: entry.name,
    });
    await put(`${compiled[1]}/dist/${compiled[2]}.js`, Buffer.from(output));
  }
}
assert.equal(offset, objects.length);
await put("package.json", Buffer.from('{"type":"module","private":true}'));
const sqlite = ".tools/sqlite-prebuild/build/Release/better_sqlite3.node";
const sqliteBytes = await readFile(path.join(workspace, ...sqlite.split("/")));
assert.equal(
  hash(sqliteBytes),
  "194c049b8781c3ca39f7e12b4f4a47c79027502b366151404ae8847fe6e2a9a1",
);
await put(sqlite, sqliteBytes);
const workspaces = new Map();
for (const entry of listed.filter((e) =>
  /^packages\/[^/]+\/package.json$/.test(e.name),
)) {
  const directory = path.dirname(entry.name);
  const manifest = JSON.parse(
    await readFile(path.join(target, directory, "package.json")),
  );
  workspaces.set(manifest.name, { directory, manifest });
}
async function copyPhysical(source, destination) {
  const stat = await lstat(source);
  assert(!stat.isSymbolicLink());
  if (stat.isDirectory()) {
    for (const name of await readdir(source))
      if (name !== "node_modules")
        await copyPhysical(path.join(source, name), `${destination}/${name}`);
  } else {
    assert(stat.isFile());
    const bytes = await readFile(source);
    await put(destination, bytes);
    assert.equal(
      hash(await readFile(path.join(target, ...destination.split("/")))),
      hash(bytes),
    );
  }
}
const dependencies = new Map();
async function dependency(name, from) {
  assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name));
  if (dependencies.has(name)) return;
  if (workspaces.has(name)) {
    const info = workspaces.get(name);
    dependencies.set(name, { source: info.directory, workspace: true });
    await copyPhysical(
      path.join(target, info.directory, "dist"),
      `node_modules/${name}/dist`,
    );
    await put(
      `node_modules/${name}/package.json`,
      await readFile(path.join(target, info.directory, "package.json")),
    );
    for (const [child] of Object.entries(info.manifest.dependencies ?? {}))
      await dependency(child, path.join(workspace, info.directory));
    for (const child of Object.keys(info.manifest.optionalDependencies ?? {})) {
      if (
        /(?:darwin|linux|android|freebsd|openbsd|win32-arm64|win32-ia32)/.test(
          child,
        )
      )
        continue;
      await dependency(child, path.join(workspace, info.directory));
    }
    return;
  }
  let current = from,
    resolved;
  while (
    current === workspace ||
    current.startsWith(`${workspace}${path.sep}`)
  ) {
    try {
      resolved = await realpath(
        path.join(current, "node_modules", ...name.split("/")),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  assert(
    resolved?.startsWith(`${workspace}${path.sep}`),
    `Missing offline test dependency ${name}`,
  );
  const manifest = JSON.parse(
    await readFile(path.join(resolved, "package.json")),
  );
  assert.equal(manifest.name, name);
  if (manifest.os && !manifest.os.includes("win32")) return;
  if (manifest.cpu && !manifest.cpu.includes("x64")) return;
  dependencies.set(name, { source: resolved, version: manifest.version });
  await copyPhysical(resolved, `node_modules/${name}`);
  for (const child of Object.keys(manifest.dependencies ?? {}))
    await dependency(child, resolved);
  for (const child of Object.keys(manifest.optionalDependencies ?? {})) {
    if (
      /(?:darwin|linux|android|freebsd|openbsd|win32-arm64|win32-ia32)/.test(
        child,
      )
    )
      continue;
    await dependency(child, resolved);
  }
}
for (const name of [
  "application",
  "project-host",
  "contracts",
  "design-ir",
  "figma-capture",
  "figma-import",
  "host",
  "storage",
  "jobs",
  "assets",
])
  await dependency(`@design-studio/${name}`, workspace);
const originalTest = path.join(
  target,
  "packages",
  "application",
  "tests",
  "reference-acquisition.test.ts",
);
let code = await readFile(originalTest, "utf8");
const cleanup = "await rm(root, { recursive: true, force: true });";
assert.equal(code.split(cleanup).length, 2);
code =
  `vi.mock("node:https", async (original) => ({ ...(await original()), request: () => { throw new Error("Synthetic old writer forbids network"); } }));
vi.mock("node:dns/promises", async (original) => ({ ...(await original()), lookup: () => { throw new Error("Synthetic old writer forbids DNS"); } }));
let crossReleaseRetainedRoot: string | undefined;\n` +
  code.replace(cleanup, `if (root !== crossReleaseRetainedRoot) ${cleanup}`);
const captureStart = "  const capture = await initial.execute(";
assert.equal(code.split(captureStart).length, 2);
code = code.replace(
  captureStart,
  `
  const runtimeTransport = await import("@design-studio/figma-capture");
  const fixtureService = await import("../../figma-capture/dist/index.js");
  expect(runtimeTransport.createFigmaCaptureJobs).toBe(fixtureService.createFigmaCaptureJobs);
  expect(vi.isMockFunction(FigmaHttpsTransport.prototype.api)).toBe(true);
  expect(vi.isMockFunction(FigmaHttpsTransport.prototype.image)).toBe(true);
${captureStart}`,
);
code = code.replace(
  "  vaultAllowed = false;",
  "  expect(api).toHaveBeenCalled();\n  vaultAllowed = false;",
);
code += `
it("authentic pinned v7 crossrelease writer", async () => {
  expect(Reflect.get(globalThis, Symbol.for("design-studio.synthetic-crossrelease-egress"))).toMatchObject({ denialControlPassed: true });
  const { f, command, plan } = await offlineStageFixture(true);
  const recovered = await f.runOffline({ ...command, operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256), confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE" });
  expect(recovered.status, JSON.stringify(recovered)).toBe("complete");
  const committed = LocalStore.prototype.commitReferenceConversion;
  if (process.env.DESIGN_STUDIO_V7_DEADLINE === "partial-stage") {
    const stage = LocalStore.prototype.stageReferenceConversion;
    vi.spyOn(LocalStore.prototype, "stageReferenceConversion").mockImplementation(async function(this: LocalStore, ...args) {
      const result = await stage.apply(this, args);
      expect(result.status).toBe("complete");
      writeFileSync(process.env.DESIGN_STUDIO_V7_HANDOFF!, JSON.stringify({
        root: f.project.paths.temp, expectedJob: command.expectedJob, expectedRecovery: recovered.receiptSha256,
        writerCommit: "${commit}", writerPolicy: REFERENCE_OFFLINE_POLICY_SHA256,
        writerOutcome: "abrupt-after-stage", stageObserved: true, pid: process.pid,
      }), { flag: "wx" });
      process.kill(process.pid, "SIGKILL");
      throw new Error("Synthetic writer was not terminated.");
    });
  }
  if (process.env.DESIGN_STUDIO_V7_DEADLINE === "1")
    vi.spyOn(LocalStore.prototype, "commitReferenceConversion").mockImplementation(async function(this: LocalStore, ...args) {
      const result = await committed.apply(this, args);
      if (result.status === "complete") f.advanceClock(30001);
      return result;
    });
  const converted = await f.runOffline({ ...command, operation: "convert-reference",
    expectedRecovery: required(recovered.receiptSha256), confirmation: "CONVERT-WITH-RECOVERED-REFERENCE" });
  expect(converted.status).toBe(process.env.DESIGN_STUDIO_V7_DEADLINE === "1" ? "failed" : "complete");
  if (converted.status === "failed") expect(converted.error?.code).toBe("DEADLINE_EXCEEDED");
  const observed = await f.observeOffline();
  expect(observed.schema).toBe(5);
  expect(observed.events).toHaveLength(10);
  expect(f.readPins).toBe(0);
  crossReleaseRetainedRoot = f.project.paths.temp;
  await writeFile(process.env.DESIGN_STUDIO_V7_HANDOFF!, JSON.stringify({
    root: crossReleaseRetainedRoot, expectedJob: command.expectedJob, expectedRecovery: recovered.receiptSha256,
    writerCommit: "${commit}", writerPolicy: REFERENCE_OFFLINE_POLICY_SHA256,
    writerOutcome: converted.status, events: 10,
  }), { flag: "wx" });
});
`;
await writeFile(originalTest, code);
physical.set("packages/application/tests/reference-acquisition.test.ts", {
  path: "packages/application/tests/reference-acquisition.test.ts",
  byteLength: Buffer.byteLength(code),
  sha256: hash(Buffer.from(code)),
});
const vitestConfig = pathToFileURL(
  path.join(workspace, "node_modules", "vitest", "dist", "config.js"),
).href;
const vitestEntry = path.join(
  workspace,
  "node_modules",
  "vitest",
  "dist",
  "index.js",
);
await put(
  "crossrelease-egress-deny.mjs",
  await readFile(
    path.join(
      workspace,
      "packages/project-host/tests/crossrelease-egress-deny.mjs",
    ),
  ),
);
const aliases = [{ find: "vitest", replacement: vitestEntry }];
for (const [name, info] of workspaces) {
  for (const [subpath, exported] of Object.entries(
    info.manifest.exports ?? {},
  )) {
    if (subpath.includes("*")) continue;
    const relative = typeof exported === "string" ? exported : exported.import;
    if (typeof relative !== "string") continue;
    aliases.push({
      find: subpath === "." ? name : `${name}/${subpath.slice(2)}`,
      replacement: path.join(target, info.directory, relative),
    });
  }
}
aliases.sort((a, b) => b.find.length - a.find.length);
const config = `
import {defineConfig} from ${JSON.stringify(vitestConfig)};
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
const physical = new Map(JSON.parse(readFileSync(${JSON.stringify(path.join(root, "v7-source-inventory.json"))}, "utf8")).physical.map(f=>[f.path,f]));
const loaded=new Set();
export default defineConfig({root:${JSON.stringify(target)},cacheDir:${JSON.stringify(path.join(root, "vite-cache"))},resolve:{alias:${JSON.stringify(aliases)}},
plugins:[{name:"pin-old-module-resolution",transform(code,id){
  const normalized=id.replaceAll("\\\\\\\\","/");
  if(normalized.includes("/packages/")||normalized.includes("/@design-studio/")){
    if(!normalized.startsWith(${JSON.stringify(target.replaceAll("\\", "/"))}))throw new Error("Oldwriter resolved current workspace module");
    const filename=id.split("?")[0],relative=path.relative(${JSON.stringify(target)},filename).split(path.sep).join("/");
    const expected=physical.get(relative),bytes=readFileSync(filename);
    if(!expected||bytes.length!==expected.byteLength||createHash("sha256").update(bytes).digest("hex")!==expected.sha256)throw new Error("Pinned old module bytes changed");
    loaded.add(id);writeFileSync(process.env.DESIGN_STUDIO_V7_LOADED,JSON.stringify([...loaded].sort()));
  }
}}],test:{maxWorkers:2,setupFiles:[${JSON.stringify(path.join(target, "crossrelease-egress-deny.mjs"))}],include:["packages/application/tests/reference-acquisition.test.ts"]}});
`;
await writeFile(path.join(target, "crossrelease.config.mjs"), config, {
  flag: "wx",
});
await writeFile(
  path.join(root, "reader.config.mjs"),
  `
import {defineConfig} from ${JSON.stringify(vitestConfig)};
export default defineConfig({root:${JSON.stringify(workspace)},test:{maxWorkers:2,projects:[{test:{
name:"unit",environment:"node",maxWorkers:2,include:["packages/application/tests/reference-acquisition.test.ts"],
setupFiles:[${JSON.stringify(path.join(workspace, "packages/project-host/tests/crossrelease-egress-deny.mjs"))}]
}}]}});
`,
  { flag: "wx" },
);
physical.set("crossrelease.config.mjs", {
  path: "crossrelease.config.mjs",
  byteLength: Buffer.byteLength(config),
  sha256: hash(Buffer.from(config)),
});
await writeFile(
  path.join(root, "v7-source-inventory.json"),
  JSON.stringify({
    commit,
    tree: "cc9c03c45f3ce650322e2be39862420ab6e49675",
    sourceFiles: listed.length,
    sourceBytes,
    physicalFiles: physical.size,
    physicalBytes: [...physical.values()].reduce(
      (sum, file) => sum + file.byteLength,
      0,
    ),
    moduleSources: hashes,
    physical: [...physical.values()],
    dependencies: [...dependencies],
    testOnlyDelta:
      "append generated writer case and retain exact root after actual cleanup; all production modules from pinned Git blobs",
  }),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    inventorySha256: hash(
      await readFile(path.join(root, "v7-source-inventory.json")),
    ),
    sourceFiles: listed.length,
    sourceBytes,
    physicalFiles: physical.size,
    physicalBytes: [...physical.values()].reduce(
      (sum, file) => sum + file.byteLength,
      0,
    ),
  }),
);
