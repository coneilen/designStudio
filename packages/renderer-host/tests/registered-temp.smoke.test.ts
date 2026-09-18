import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import { openAtTestRoot, ownedTest } from "../../project-host/tests/support.js";
import { RendererWorkerHost } from "../src/index.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

it.runIf(
  process.platform === "win32" &&
    process.arch === "x64" &&
    process.env.F06_RENDER_SMOKE === "1",
)(
  "launches pinned sandboxed Chromium and returns in-memory PNG beneath a deep private registered temp root",
  async () => {
    const browserRoot = path.resolve(
      process.env.F06_BROWSER_ROOT ?? ".tools\\renderer-browser-1.63.0",
    );
    const manifest = JSON.parse(
      await readFile(
        path.resolve("packages\\renderer\\docs\\browser-windows-x64.json"),
        "utf8",
      ),
    );
    for (const file of manifest.files) {
      const filename = path.join(browserRoot, ...file.path.split("/"));
      const identity = await lstat(filename);
      expect(
        identity.isFile() && !identity.isSymbolicLink() && identity.nlink === 1,
      ).toBe(true);
      expect(await realpath(filename)).toBe(filename);
      expect(identity.size).toBe(file.byteLength);
      expect(hash(await readFile(filename))).toBe(file.sha256);
    }
    const executable = path.join(
      browserRoot,
      "chromium_headless_shell-1243",
      "chrome-headless-shell-win64",
      "chrome-headless-shell.exe",
    );
    const playwright = pathToFileURL(
      path.resolve("packages\\renderer\\node_modules\\playwright\\index.mjs"),
    ).href;
    await ownedTest(async (root, own) => {
      const catalogBytes = await readFile(
        path.resolve("tests\\fixtures\\foundation\\manifest.json"),
      );
      const scope = {
        projectId: "project_synthetic",
        artifactRootId: "foundation_artifacts",
        permissionScope: "foundation_fixture_owner_v1",
      };
      const registry = own(
        await openAtTestRoot(
          {
            applicationId: "design-studio",
            catalogBytes,
            catalogIdentity: hash(catalogBytes),
            trustedImmutableInstallation: true,
            fixtures: [scope],
          },
          root,
        ),
      );
      const binding = await registry.createFixtureProject(scope);
      const implementation = path.join(root, "registered-temp-worker.mjs");
      const source = `
        import { chromium } from ${JSON.stringify(playwright)};
        import { readdir } from "node:fs/promises";
        const atImport = { temp: process.env.TEMP, tmp: process.env.TMP, cwd: process.cwd() };
        let browser;
        export async function render() {
          try {
          browser = await chromium.launch({
            executablePath: ${JSON.stringify(executable)}, chromiumSandbox: true,
            headless: true, timeout: 15000,
            args: ["--force-color-profile=srgb", "--enable-automation"],
          });
          const cdp = await browser.newBrowserCDPSession();
          const command = await cdp.send("Browser.getBrowserCommandLine");
          await cdp.detach();
          const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
          const page = await context.newPage();
          await page.setContent("<html><body style='margin:0;background:rgb(20,80,120)'>Owned</body></html>");
          const png = await page.screenshot({type: "png"});
          const children = await readdir(process.env.TEMP);
          await context.close();
          return Buffer.from(JSON.stringify({ ok: true, atImport, command: command.arguments, children, png: png.toString("base64"), version: browser.version() }));
          } catch (error) {
            return Buffer.from(JSON.stringify({ok:false,error:String(error).slice(0,2048)}));
          }
        }
        export async function close() { if (browser) await browser.close(); }
      `;
      await writeFile(implementation, source, { flag: "wx" });
      const context = syntheticContext();
      context.authorization.grants.push({
        resourceKind: "provider",
        resourceId: "registered-temp-renderer",
        operations: ["execute"],
      });
      const host = new RendererWorkerHost({
        projectId: scope.projectId,
        providerId: "registered-temp-renderer",
        authority: (authorization) => authorization === context.authorization,
        node: {
          path: process.execPath,
          sha256: hash(await readFile(process.execPath)),
          maxBytes: 200000000,
        },
        implementation: {
          path: implementation,
          sha256: hash(Buffer.from(source)),
          maxBytes: 100000,
        },
        tempRoot: binding.paths.temp,
        trustedExclusiveAccess: true,
        environment: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
        limits: {
          startMs: 15000,
          idleMs: 10000,
          lifetimeMs: 30000,
          closeMs: 5000,
          maxFrameBytes: 1000000,
          maxInputBytes: 26214400,
          maxOutputBytes: 26214400,
          maxStdoutBytes: 16384,
          maxStderrBytes: 16384,
          maxRequests: 1,
        },
      });
      await binding.recheck();
      const opened = await host.open(context);
      expect(opened.status, JSON.stringify(opened)).toBe("complete");
      if (opened.status !== "complete") return;
      try {
        const result = await opened.value.exchange(new Uint8Array(), context);
        expect(result.status, JSON.stringify(result)).toBe("complete");
        if (result.status !== "complete") return;
        const response = JSON.parse(Buffer.from(result.value).toString());
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(path.dirname(response.atImport.cwd)).toBe(binding.paths.temp);
        expect(response.atImport.temp).toBe(`\\\\?\\${response.atImport.cwd}`);
        expect(response.atImport.tmp).toBe(response.atImport.temp);
        const profile = response.children.find((name: string) =>
          name.startsWith("playwright_chromiumdev_profile-"),
        );
        expect(profile).toBeDefined();
        expect(
          path.join(response.atImport.cwd, profile).length,
        ).toBeGreaterThan(260);
        expect(response.command).toContain(
          `--user-data-dir=${path.join(response.atImport.temp, profile)}`,
        );
        expect(response.command).toContain("--remote-debugging-pipe");
        expect(response.command).not.toContain("--no-sandbox");
        expect(response.command).not.toContain("--disable-setuid-sandbox");
        expect(response.version).toBe("153.0.8010.12");
        const png = Buffer.from(response.png, "base64");
        expect(png.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
      } finally {
        expect(await opened.value.close()).toMatchObject({
          status: "complete",
          value: {
            workerExitObserved: true,
            jobEmptyObserved: true,
            mode: "graceful",
            exitCode: 0,
          },
        });
      }
      expect(await readdir(binding.paths.temp)).toEqual([]);
      await binding.recheck();
    });
  },
  60000,
);
