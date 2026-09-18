import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGETS,
  type OperationContext,
} from "@design-studio/contracts";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { RendererWorkerHost } from "@design-studio/renderer-host";
import { expect, test } from "vitest";
import { loadNative, type ReadLease } from "../src/native.js";
import { allowPublicBrowserRead } from "./browser-acl-probe.js";
import { openAtTestRoot, ownedTest } from "./support.js";

const require = createRequire(import.meta.url);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const sqliteSource =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node";
const browserSource =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-urban-goggles\\.tools\\renderer-browser-1.63.0";
const nodeSource =
  "D:\\depot\\copilot-worktrees\\designStudio\\coneilen-microsoft-bookish-spork\\.tools\\node-v24.21.0-win-x64";

test.skipIf(process.env.FIXTURE_INSTALL_COMPATIBILITY !== "1")(
  "real READ-share pins permit Node addons and Job-contained Chromium while denying writes/deletes",
  async () => {
    await ownedTest(async (root, own) => {
      const runtime = path.join(root, "runtime");
      const browser = path.join(root, "browser");
      const native = await loadNative();
      await cp(nodeSource, runtime, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      const inventory: {
        files: { path: string; byteLength: number; sha256: string }[];
      } = JSON.parse(
        await readFile(
          path.join(
            workspace,
            "packages",
            "renderer",
            "docs",
            "browser-windows-x64.json",
          ),
          "utf8",
        ),
      );
      for (const item of inventory.files) {
        const relative = item.path.split("/").join(path.sep);
        const bytes = await readFile(path.join(browserSource, relative));
        expect(bytes.byteLength).toBe(item.byteLength);
        expect(sha(bytes)).toBe(item.sha256);
        await mkdir(path.dirname(path.join(browser, relative)), {
          recursive: true,
        });
        await writeFile(path.join(browser, relative), bytes, { flag: "wx" });
      }
      if (process.env.FIXTURE_INSTALL_PUBLIC_BROWSER_READ === "1")
        await allowPublicBrowserRead(
          root,
          browser,
          inventory.files.map((item) => item.path),
        );
      const sqlite = await readFile(sqliteSource);
      expect(sha(sqlite)).toBe(
        "194c049b8781c3ca39f7e12b4f4a47c79027502b366151404ae8847fe6e2a9a1",
      );
      await writeFile(path.join(root, "better_sqlite3.node"), sqlite, {
        flag: "wx",
      });
      for (const name of [
        "koffi",
        "@koromix/koffi-win32-x64",
        "playwright",
        "playwright-core",
      ]) {
        const from = await realpath(
          path.dirname(
            require.resolve(name, {
              paths: [
                path.dirname(require.resolve("koffi")),
                path.join(
                  workspace,
                  "packages",
                  name.startsWith("playwright") ? "renderer" : "project-host",
                ),
              ],
            }),
          ),
        );
        await cp(from, path.join(root, "node_modules", ...name.split("/")), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
      }
      const implementation = path.join(root, "compatibility-worker.mjs");
      await cp(
        new URL(
          "./installation-fixtures/compatibility-worker.mjs",
          import.meta.url,
        ),
        implementation,
      );
      await cp(
        new URL("../dist/installation-resolver.js", import.meta.url),
        path.join(root, "resolver.mjs"),
      );
      const leases: ReadLease[] = [];
      const pin = async (directory: string): Promise<void> => {
        leases.push(native.pinRead(directory, true));
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          if (entry.isSymbolicLink())
            throw new Error("Probe payload cannot contain resolution links.");
          if (entry.isDirectory()) await pin(filename);
          else leases.push(native.pinRead(filename, false));
        }
      };
      // Mutable browser/SQLite state stays outside this pinned payload tree.
      let temp = path.join(root, "work");
      if (process.env.FIXTURE_INSTALL_REGISTERED_TEMP === "1") {
        const scope = {
          projectId: "project_synthetic",
          artifactRootId: "foundation_artifacts",
          permissionScope: "foundation_fixture_owner_v1",
        };
        const catalogBytes = Buffer.from(
          "synthetic exact private role hierarchy",
        );
        const registry = own(
          await openAtTestRoot(
            {
              applicationId: "design-studio",
              catalogIdentity: sha(catalogBytes),
              catalogBytes,
              trustedImmutableInstallation: true,
              fixtures: [scope],
            },
            root,
          ),
        );
        temp = (await registry.createFixtureProject(scope)).paths.temp;
      } else await mkdir(temp);
      console.info(
        JSON.stringify({
          probeTempLength: temp.length,
          registeredTemp: process.env.FIXTURE_INSTALL_REGISTERED_TEMP === "1",
        }),
      );
      try {
        for (const directory of [
          runtime,
          ...(process.env.FIXTURE_INSTALL_BROWSER_BASELINE === "1"
            ? []
            : [browser]),
          path.join(root, "node_modules"),
        ])
          await pin(directory);
        leases.push(
          native.pinRead(implementation, false),
          native.pinRead(path.join(root, "better_sqlite3.node"), false),
          native.pinRead(path.join(root, "resolver.mjs"), false),
        );
        await writeFile(
          path.join(root, "allowed-files.json"),
          JSON.stringify(leases.map((lease) => lease.identity.path)),
          { flag: "wx" },
        );
        leases.push(
          native.pinRead(path.join(root, "allowed-files.json"), false),
        );
        await expect(writeFile(implementation, "tamper")).rejects.toThrow();
        await expect(
          rename(implementation, `${implementation}.moved`),
        ).rejects.toThrow();
        const clock = new SystemClock();
        const auth = new LocalSessionAuthenticator({
          clock,
          hosts: ["127.0.0.1:47119"],
          origins: ["http://127.0.0.1:47119"],
        });
        const session = auth.createSession(
          {
            schemaVersion: "1.0",
            projectId: "install_probe",
            actorId: "owned_probe",
            sessionId: "probe",
            expiresAt: new Date(clock.now() + 120000).toISOString(),
            grants: [
              {
                resourceKind: "provider",
                resourceId: "probe",
                operations: ["execute"],
              },
            ],
            egress: "deny",
          },
          "cli",
        );
        const context: OperationContext = {
          schemaVersion: "1.0",
          projectId: "install_probe",
          requestId: "probe",
          authorization: auth.authenticate({
            remoteAddress: "127.0.0.1",
            host: "127.0.0.1:47119",
            method: "POST",
            bearer: session.credential,
          }),
          clock,
          signal: new AbortController().signal,
          deadline: new Date(clock.now() + 30000).toISOString(),
          budget: { ...DEFAULT_BUDGETS },
        };
        const node = path.join(runtime, "node.exe");
        const host = new RendererWorkerHost({
          projectId: context.projectId,
          providerId: "probe",
          authority: auth.authority,
          node: {
            path: node,
            sha256: sha(await readFile(node)),
            maxBytes: 200000000,
          },
          implementation: {
            path: implementation,
            sha256: sha(await readFile(implementation)),
            maxBytes: 100000,
          },
          environment: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
          tempRoot: temp,
          trustedExclusiveAccess: true,
          limits: {
            startMs: 10000,
            idleMs: 10000,
            lifetimeMs: 30000,
            closeMs: 5000,
            maxFrameBytes: 1000000,
            maxInputBytes: 2000000,
            maxOutputBytes: 2000000,
            maxStdoutBytes: 16384,
            maxStderrBytes: 16384,
            maxRequests: 2,
          },
        });
        const opened = await host.open(context);
        expect(opened.status, JSON.stringify(opened)).toBe("complete");
        if (opened.status !== "complete")
          throw new Error("Contained compatibility worker did not start.");
        try {
          const result = await opened.value.exchange(Uint8Array.of(1), context);
          expect(result.status, JSON.stringify(result)).toBe("complete");
          if (result.status === "complete")
            expect(
              JSON.parse(Buffer.from(result.value).toString()),
              Buffer.from(result.value).toString(),
            ).toMatchObject({
              node: "v24.21.0",
              koffi: true,
              sqlite: true,
              png: "89504e470d0a1a0a",
              sandboxDisabled: false,
              pipe: true,
              debugPort: false,
            });
        } finally {
          expect(await opened.value.close()).toMatchObject({
            status: "complete",
            value: { workerExitObserved: true, jobEmptyObserved: true },
          });
        }
      } finally {
        for (const lease of leases.reverse()) lease.close();
      }
    });
  },
  120000,
);
