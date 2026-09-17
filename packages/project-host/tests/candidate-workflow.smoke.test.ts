import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { installCandidate, verifyInstalledRoot } from "../src/installation.js";
import { digest } from "../src/installation-manifest.js";
import { type InstallationEntry, loadNative } from "../src/native.js";
import {
  offlineRestorePaths,
  withOfflineRestoreDiagnostics,
} from "./offline-restore.js";
import { ownedTest, weakenTestAcl } from "./support.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const pnpm =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\npm-cache\\_npx\\89115c3eb7dd1e36\\node_modules\\pnpm\\bin\\pnpm.mjs";
const nodeRoot =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-bookish-spork\\.tools\\node-v24.21.0-win-x64";
const browserRoot =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\renderer-browser-1.63.0";
const sqliteBinding =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node";
const execute = promisify(execFile);

test.skipIf(process.env.FIXTURE_INSTALL_CANDIDATE_GATE !== "1")(
  "complete offline candidate with synthetic F08 entries installs and child independently verifies real native closure",
  async () => {
    const restore = offlineRestorePaths(workspace, process.env);
    await ownedTest(async (root) => {
      const stage = path.join(root, "workspace");
      await mkdir(path.join(stage, "packages"), { recursive: true });
      const names = [
        "contracts",
        "design-ir",
        "assets",
        "host",
        "storage",
        "jobs",
        "renderer",
        "renderer-host",
        "project-host",
      ];
      for (const name of names)
        await cp(
          path.join(workspace, "packages", name),
          path.join(stage, "packages", name),
          {
            recursive: true,
            filter: (filename) =>
              !filename
                .split(path.sep)
                .some((part) => ["node_modules", "tests"].includes(part)),
          },
        );
      for (const name of ["application", "cli"]) {
        const target = path.join(stage, "packages", name);
        await mkdir(path.join(target, "dist"), { recursive: true });
        await writeFile(
          path.join(target, "package.json"),
          JSON.stringify({
            name: `@design-studio/${name}`,
            version: "0.0.0-test-only",
            type: "module",
            exports: { ".": "./dist/index.js" },
            files: ["dist"],
            dependencies: { "@design-studio/project-host": "workspace:*" },
          }),
        );
        await writeFile(
          path.join(target, "dist", "index.js"),
          "export const syntheticOnly = true;",
        );
      }
      await writeFile(
        path.join(stage, "packages", "cli", "dist", "main.js"),
        `import {verifyFixtureInstallation,registerFixtureInstallationGuards} from '@design-studio/project-host';
       import {loadNative} from '../../../node_modules/@design-studio/project-host/dist/native.js';
       (await loadNative()).localAppData=()=>${JSON.stringify(root)};
       const lease=await verifyFixtureInstallation();const guard=registerFixtureInstallationGuards(lease);
       try {await lease.recheck();process.stdout.write(JSON.stringify({synthetic:true,node:process.version,identity:lease.identity}));}
       finally {guard.close();await lease.close();}`,
      );
      await writeFile(
        path.join(stage, "packages", "application", "dist", "render-worker.js"),
        "export const syntheticOnly = true;",
      );
      await mkdir(path.join(stage, "tests", "fixtures"), { recursive: true });
      await cp(
        path.join(workspace, "tests", "fixtures", "foundation"),
        path.join(stage, "tests", "fixtures", "foundation"),
        { recursive: true },
      );
      await writeFile(
        path.join(stage, "package.json"),
        JSON.stringify({ private: true, packageManager: "pnpm@11.26.0" }),
      );
      await writeFile(
        path.join(stage, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      await cp(
        path.join(workspace, "pnpm-lock.yaml"),
        path.join(stage, "pnpm-lock.yaml"),
      );
      await withOfflineRestoreDiagnostics(() =>
        execute(
          process.execPath,
          [
            pnpm,
            "--dir",
            stage,
            "install",
            "--offline",
            "--ignore-scripts",
            "--cache-dir",
            restore.cache,
            "--store-dir",
            restore.store,
            "--registry",
            "https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/",
          ],
          {
            timeout: 120000,
            maxBuffer: 65536,
            env: { ...process.env, PATH: `${nodeRoot};${process.env.PATH}` },
          },
        ),
      );
      const output = path.join(root, "candidate");
      await execute(
        process.execPath,
        [
          path.join(
            workspace,
            "packages",
            "project-host",
            "scripts",
            "package-candidate.mjs",
          ),
          "--workspace",
          stage,
          "--node-root",
          nodeRoot,
          "--browser-root",
          browserRoot,
          "--sqlite-binding",
          sqliteBinding,
          "--output",
          output,
        ],
        { timeout: 180000, maxBuffer: 65536 },
      );
      // This synthetic candidate's only native seam is the exact owned KnownFolder return.
      // It is applied BEFORE computing the test bootstrap identity; no real release is approved.
      const launch = path.join(output, "bootstrap", "launch.mjs");
      await writeFile(
        launch,
        (await readFile(launch, "utf8")).replace(
          "checked.api.establishBootstrapOrigin",
          `const {loadNative}=await import('./node_modules/@design-studio/project-host/dist/native.js');\n(await loadNative()).localAppData=()=>${JSON.stringify(root)};\nchecked.api.establishBootstrapOrigin`,
        ),
      );
      const inventoryScript = path.join(root, "inventory.mjs");
      await writeFile(
        inventoryScript,
        `import {inventory} from ${JSON.stringify(new URL("../scripts/package-candidate.mjs", import.meta.url).href)};import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(path.join(output, "bootstrap-inventory.json"))},await inventory(${JSON.stringify(path.join(output, "bootstrap"))}));`,
      );
      await execute(process.execPath, [inventoryScript], { timeout: 120000 });
      const native = await loadNative();
      const seam = vi.spyOn(native, "localAppData").mockReturnValue(root);
      const entries: { entry: InstallationEntry; directory: boolean }[] = [];
      const create = native.createInstallationEntry.bind(native);
      const tracking = vi
        .spyOn(native, "createInstallationEntry")
        .mockImplementation((filename, directory, sid) => {
          const entry = create(filename, directory, sid);
          entries.push({ entry, directory });
          return entry;
        });
      try {
        const entry = await installCandidate(
          output,
          digest(await readFile(path.join(output, "payload-inventory.json"))),
          digest(await readFile(path.join(output, "bootstrap-inventory.json"))),
        );
        const installed = path.dirname(path.dirname(entry));
        const parent = await verifyInstalledRoot(installed);
        try {
          const result = await execute(parent.paths.node, [entry, "cli"], {
            timeout: 120000,
            maxBuffer: 65536,
            env: { SystemRoot: process.env.SystemRoot, TZ: "UTC" },
          });
          expect(JSON.parse(result.stdout)).toEqual({
            synthetic: true,
            node: "v24.21.0",
            identity: parent.identity,
          });
        } finally {
          await parent.close();
        }
      } finally {
        tracking.mockRestore();
        seam.mockRestore();
        for (const { entry, directory } of entries) {
          entry.close();
          const check = native.inspect(entry.identity.path, directory);
          try {
            expect(check.identity).toEqual(entry.identity);
            await weakenTestAcl(root, entry.identity.path, false, true);
          } finally {
            check.close();
          }
        }
      }
    });
  },
  600000,
);
