import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  installCandidate,
  registerFixtureInstallationGuards,
  verifyInstalledRoot,
} from "../../project-host/dist/installation.js";
import {
  decodeInventory,
  digest,
} from "../../project-host/dist/installation-manifest.js";
import {
  type InstallationEntry,
  loadNative,
} from "../../project-host/dist/native.js";
import {
  offlineRestorePaths,
  withOfflineRestoreDiagnostics,
} from "../../project-host/tests/offline-restore.js";
import { ownedTest, weakenTestAcl } from "../../project-host/tests/support.js";
import { installedFailure } from "./installed-result.js";
import { persistDiagnostic } from "./persist-diagnostic.js";
import { waitForReportedExit } from "./phase-exit.mjs";
import { instrumentCandidate } from "./phase-instrument.js";
import { phaseReport } from "./phase-report.js";

const execute = promisify(execFile);
const workspace = path.resolve(".");
const nodeRoot =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-bookish-spork\\.tools\\node-v24.21.0-win-x64";
const pnpm =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\npm-cache\\_npx\\89115c3eb7dd1e36\\node_modules\\pnpm\\bin\\pnpm.mjs";

it.skipIf(process.env.F08_INSTALL_GATE !== "1")(
  "actual F08 candidate installs only in an owned native test namespace and drives the shipped CLI/launcher/render flow",
  async () => {
    const artifactPath = process.env.F08_DIAGNOSTIC_ARTIFACT;
    if (!artifactPath || !path.isAbsolute(artifactPath))
      throw new Error("Explicit test-run diagnostic artifact path required.");
    const restore = offlineRestorePaths(workspace, process.env);
    await ownedTest(async (root) => {
      const diagnosticDirectory = path.join(root, "numeric-diagnostics");
      await mkdir(diagnosticDirectory);
      const diagnosticIdentity = await lstat(diagnosticDirectory, {
        bigint: true,
      });
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
        "application",
        "cli",
      ];
      for (const name of names)
        await cp(
          path.join(workspace, "packages", name),
          path.join(stage, "packages", name),
          {
            recursive: true,
            filter: (file) =>
              !file
                .split(path.sep)
                .some((part) => part === "node_modules" || part === "tests"),
          },
        );
      // Exact owned KnownFolder seam, sealed into this test-only candidate BEFORE inventory.
      // Real F08 entries and all other native authority/ACL/identity logic remain unchanged.
      const nativePath = path.join(
        stage,
        "packages",
        "project-host",
        "dist",
        "native.js",
      );
      const original = await readFile(nativePath, "utf8");
      expect(original.split("localAppData() {")).toHaveLength(2);
      await writeFile(
        nativePath,
        original.replace(
          "localAppData() {",
          `localAppData() { return ${JSON.stringify(root)};`,
        ),
      );
      await instrumentCandidate(stage, diagnosticDirectory);
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
      const candidate = path.join(root, "candidate");
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
          path.join(workspace, ".tools", "renderer-browser-1.63.0"),
          "--sqlite-binding",
          path.join(
            workspace,
            ".tools",
            "sqlite-prebuild",
            "build",
            "Release",
            "better_sqlite3.node",
          ),
          "--output",
          candidate,
        ],
        { timeout: 180000, maxBuffer: 65536 },
      );
      const selectedRuntime = decodeInventory(
        await readFile(path.join(candidate, "bootstrap-inventory.json")),
      ).filter((file) => file.path.startsWith("runtime/"));
      expect(selectedRuntime).toEqual([
        {
          path: "runtime/LICENSE",
          bytes: 160555,
          sha256:
            "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9",
        },
        {
          path: "runtime/node.exe",
          bytes: 93580104,
          sha256:
            "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
        },
      ]);
      const native = await loadNative();
      const seam = vi.spyOn(native, "localAppData").mockReturnValue(root);
      const created: { entry: InstallationEntry; directory: boolean }[] = [];
      const allocate = native.createInstallationEntry.bind(native);
      const track = vi
        .spyOn(native, "createInstallationEntry")
        .mockImplementation((file, directory, sid) => {
          const entry = allocate(file, directory, sid);
          created.push({ entry, directory });
          return entry;
        });
      try {
        const bootstrap = await installCandidate(
          candidate,
          digest(
            await readFile(path.join(candidate, "payload-inventory.json")),
          ),
          digest(
            await readFile(path.join(candidate, "bootstrap-inventory.json")),
          ),
        );
        const startupStarted = performance.now();
        const lease = await verifyInstalledRoot(
          path.dirname(path.dirname(bootstrap)),
        );
        let primaryFailure: unknown;
        let retainedMeasurement: unknown;
        const retainedReports: unknown[] = [];
        try {
          const startupMs = Math.round(performance.now() - startupStarted);
          const guard = registerFixtureInstallationGuards(lease);
          let recheckMs = 0;
          const serial: number[] = [];
          let concurrent: number[] = [];
          let batchMs = 0;
          try {
            const recheckStarted = performance.now();
            await lease.recheck();
            recheckMs = Math.round(performance.now() - recheckStarted);
            for (let count = 0; count < 3; count++) {
              const started = performance.now();
              await lease.checkCurrent();
              serial.push(Math.round(performance.now() - started));
            }
            const batchStarted = performance.now();
            concurrent = await Promise.all(
              Array.from({ length: 9 }, async () => {
                const started = performance.now();
                await lease.checkCurrent();
                return Math.round(performance.now() - started);
              }),
            );
            batchMs = Math.round(performance.now() - batchStarted);
          } finally {
            guard.close();
          }
          const inventory = [
            ...decodeInventory(
              await readFile(path.join(candidate, "payload-inventory.json")),
            ),
            ...decodeInventory(
              await readFile(path.join(candidate, "bootstrap-inventory.json")),
            ),
          ];
          const measurement = {
            startupMs,
            recheckMs,
            serial,
            concurrent,
            batchMs,
            files: inventory.length,
            bytes: inventory.reduce((total, file) => total + file.bytes, 0),
          };
          retainedMeasurement = measurement;
          console.info(
            `Owned installation measurement: ${JSON.stringify(measurement)}`,
          );
          const cli = async (args: string[]) => {
            const result = await execute(
              lease.paths.node,
              [bootstrap, "cli", ...args, "--json"],
              {
                timeout: 180000,
                maxBuffer: 2 * 1024 * 1024,
                env: { SystemRoot: process.env.SystemRoot, TZ: "UTC" },
              },
            ).catch((error: unknown) => {
              if (error && typeof error === "object" && "stdout" in error)
                throw new Error(
                  `Owned installed ${args[0]} failed; ${JSON.stringify(measurement)}; ${installedFailure(error.stdout, "stderr" in error ? error.stderr : undefined)}`,
                  { cause: error },
                );
              throw error;
            });
            expect(result.stderr).not.toContain("Bearer");
            return JSON.parse(result.stdout);
          };
          expect(
            (await cli(["fixtures", "init", "--project", "project_synthetic"]))
              .success,
          ).toBe(true);
          const accepted = await cli([
            "with-session",
            "--project",
            "project_synthetic",
            "--",
            "fixtures",
            "accept",
            "settings-screen",
            "--new",
            "--request-id",
            "installed_accept",
          ]);
          expect(accepted.data.kind).toBe("revision");
          expect(accepted.data.design.resources.snapshotId).toBe(
            "resources_synthetic",
          );
          const rendered = await cli([
            "with-session",
            "--project",
            "project_synthetic",
            "--",
            "render",
            "design_settings-screen",
            "--request-id",
            "installed_render",
          ]);
          expect(rendered.data.kind).toBe("job");
          expect(rendered.data.job.status).toBe("completed");
          expect(rendered.data.job.receipt.outputs).toHaveLength(6);
          const preview = await cli(["preview", rendered.data.job.id]);
          expect(preview.data.artifact.mediaType).toBe(
            "application/octet-stream",
          );
          expect(
            preview.data.warnings.some(
              (warning: { code: string }) =>
                warning.code === "APPROVAL_REQUIRED",
            ),
          ).toBe(true);
        } catch (error) {
          primaryFailure = error;
        }
        {
          let diagnosticFailure: unknown;
          try {
            const currentDirectory = await lstat(diagnosticDirectory, {
              bigint: true,
            });
            if (
              currentDirectory.dev !== diagnosticIdentity.dev ||
              currentDirectory.ino !== diagnosticIdentity.ino ||
              !currentDirectory.isDirectory() ||
              currentDirectory.isSymbolicLink() ||
              (await realpath(diagnosticDirectory)) !== diagnosticDirectory
            )
              throw new Error("Diagnostic directory identity changed.");
            const names = await readdir(diagnosticDirectory);
            if (names.length > 64)
              throw new Error("Diagnostic file count exceeded.");
            const starts = names.filter((name) =>
              /^[1-9][0-9]*-[12]\.start\.json$/.test(name),
            );
            if (!starts.length)
              throw new Error("Diagnostic process registrations missing.");
            const outcomes = await Promise.allSettled(
              starts.map(async (name) => {
                const file = path.join(diagnosticDirectory, name);
                const info = await lstat(file);
                if (
                  !info.isFile() ||
                  info.isSymbolicLink() ||
                  info.nlink !== 1 ||
                  info.size > 512
                )
                  throw new Error("Invalid process registration.");
                const value: unknown = JSON.parse(await readFile(file, "utf8"));
                if (
                  !value ||
                  typeof value !== "object" ||
                  Array.isArray(value) ||
                  !("pid" in value) ||
                  !("timeOrigin" in value) ||
                  !("instance" in value) ||
                  Object.keys(value).length !== 3 ||
                  typeof value.pid !== "number" ||
                  typeof value.timeOrigin !== "number" ||
                  ![1, 2].includes(Number(value.instance)) ||
                  name !== `${value.pid}-${value.instance}.start.json`
                )
                  throw new Error("Invalid process registration fields.");
                await waitForReportedExit(value.pid, value.timeOrigin);
                return name.replace(".start.json", ".json");
              }),
            );
            const failures = outcomes.filter(
              (outcome) => outcome.status === "rejected",
            );
            if (failures.length)
              throw new AggregateError(
                failures.map((outcome) => outcome.reason),
                "Owned process exit observation failed.",
              );
            const laterNames = await readdir(diagnosticDirectory);
            const laterStarts = laterNames.filter(
              (name) =>
                /^[1-9][0-9]*-[12]\.start\.json$/.test(name) &&
                !starts.includes(name),
            );
            if (laterStarts.length)
              throw new Error(
                "Additional child registrations appeared during exit observation; diagnostic quiescence is incomplete.",
              );
            const captureErrors: unknown[] = [];
            for (const outcome of outcomes) {
              if (outcome.status !== "fulfilled")
                throw new Error("Process observation incomplete.");
              const file = path.join(diagnosticDirectory, outcome.value);
              const info = await lstat(file);
              if (
                !info.isFile() ||
                info.isSymbolicLink() ||
                info.nlink !== 1 ||
                info.size > 16384
              )
                throw new Error("Invalid phase capture file.");
              const report = phaseReport(await readFile(file), outcome.value);
              retainedReports.push(report);
              console.info(
                `Owned process phase capture: ${JSON.stringify(report)}`,
              );
              if (report.incomplete !== 0)
                captureErrors.push(
                  new Error("Explicit incomplete diagnostic capture."),
                );
            }
            if (captureErrors.length)
              throw new AggregateError(
                captureErrors,
                "Diagnostic capture incomplete.",
              );
          } catch (error) {
            diagnosticFailure = error;
          }
          // Passing-test console output may be suppressed. Persist only validated, bounded numeric evidence.
          try {
            await persistDiagnostic(artifactPath, {
              version: 1,
              testOnly: true,
              functionalPassed: primaryFailure === undefined,
              captureComplete: diagnosticFailure === undefined,
              measurement: retainedMeasurement,
              reports: retainedReports,
            });
          } catch (error) {
            diagnosticFailure = diagnosticFailure
              ? new AggregateError(
                  [diagnosticFailure, error],
                  "Capture and persistence failed.",
                  { cause: diagnosticFailure },
                )
              : error;
          }
          await lease.close();
          if (diagnosticFailure)
            throw new AggregateError(
              primaryFailure
                ? [primaryFailure, diagnosticFailure]
                : [diagnosticFailure],
              "Actual result or owned phase capture failed.",
              { cause: primaryFailure ?? diagnosticFailure },
            );
          if (primaryFailure) throw primaryFailure;
        }
      } finally {
        track.mockRestore();
        seam.mockRestore();
        for (const { entry, directory } of created) {
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
  900000,
);
