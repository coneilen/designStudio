import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { installCandidate, verifyInstalledRoot } from "../src/installation.js";
import {
  digest,
  encodeInventory,
  type InventoryFile,
} from "../src/installation-manifest.js";
import { type InstallationEntry, loadNative } from "../src/native.js";
import { ownedTest, weakenTestAcl } from "./support.js";

interface Message {
  kind: string;
  [key: string]: unknown;
}
function child(
  root: string,
  installed: string,
  pinsets: number,
): {
  next(): Promise<Message>;
  send(value: string): void;
  close(): Promise<void>;
} {
  const process: ChildProcess = spawn(
    globalThis.process.execPath,
    [
      fileURLToPath(
        new URL(
          "./installation-fixtures/metadata-probe-child.mjs",
          import.meta.url,
        ),
      ),
      root,
      installed,
      String(pinsets),
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
      env: {
        SystemRoot: globalThis.process.env.SystemRoot,
        TZ: "UTC",
        VITEST: "true",
      },
    },
  );
  const queue: Message[] = [];
  let waiter: ((message: Message) => void) | undefined;
  let stderr = "";
  process.stderr?.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(0, 16384);
  });
  process.on("message", (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      typeof value.kind !== "string"
    )
      throw new Error("Invalid diagnostic child message.");
    const message: Message = { ...value, kind: value.kind };
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(message);
    } else queue.push(message);
  });
  const exited = new Promise<void>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (waiter) {
        const resolveWaiting = waiter;
        waiter = undefined;
        resolveWaiting({
          kind: "error",
          message: `Diagnostic exit ${code}/${signal}: ${stderr}`,
        });
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(`Diagnostic child failed ${code}/${signal}: ${stderr}`),
        );
    });
  });
  // A rejection remains observable at close even if the child fails before its next command.
  void exited.catch(() => undefined);
  const next = async (): Promise<Message> => {
    const message = queue.shift();
    if (message) return message;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = undefined;
        process.kill();
        reject(
          new Error(
            "Diagnostic child exceeded 120 second command bound; owned child terminated.",
          ),
        );
      }, 120000);
      waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  };
  return {
    next,
    send(value) {
      process.send?.(value);
    },
    async close() {
      if (process.exitCode === null && process.signalCode === null) {
        process.send?.("close");
        const message = await next();
        expect(message.kind, JSON.stringify(message)).toBe("closed");
      }
      await exited;
    },
  };
}

test.skipIf(process.env.FIXTURE_INSTALL_METADATA_PROBE !== "1")(
  "bounded count-matched metadata phase and idle-pin topology diagnostic",
  async () => {
    const output = process.env.FIXTURE_INSTALL_METADATA_OUTPUT;
    if (!output || !path.isAbsolute(output))
      throw new Error(
        "Diagnostic requires an explicit session-artifact output path.",
      );
    await ownedTest(async (root) => {
      const native = await loadNative();
      const sid = native.principal();
      const folder = vi.spyOn(native, "localAppData").mockReturnValue(root);
      const created: { entry: InstallationEntry; directory: boolean }[] = [];
      const real = native.createInstallationEntry.bind(native);
      const tracking = vi
        .spyOn(native, "createInstallationEntry")
        .mockImplementation((filename, directory, principal) => {
          const entry = real(filename, directory, principal);
          created.push({ entry, directory });
          return entry;
        });
      const children: ReturnType<typeof child>[] = [];
      let parentLease:
        | Awaited<ReturnType<typeof verifyInstalledRoot>>
        | undefined;
      const source = path.join(root, "source");
      const sourceDirs = new Set<string>();
      const contents = Buffer.from("synthetic-metadata-only");
      const write = async (area: string, names: string[]): Promise<Buffer> => {
        const files: InventoryFile[] = [];
        for (const name of names) {
          const destination = path.join(source, area, ...name.split("/"));
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, contents, { flag: "wx" });
          files.push({
            path: name,
            bytes: contents.length,
            sha256: digest(contents),
          });
          sourceDirs.add(path.dirname(destination));
        }
        return encodeInventory(files);
      };
      try {
        const payload = [
          "packages/cli/dist/main.js",
          "packages/application/dist/render-worker.js",
          "node_modules/@design-studio/project-host/dist/index.js",
          "native/better_sqlite3.node",
          "browser/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
          "fixtures/foundation/manifest.json",
        ];
        for (let i = 0; i < 298; i++)
          payload.push(`browser/public-data/group-${i % 12}/entry-${i}.dat`);
        for (let i = 0; i < 3500; i++)
          payload.push(
            `node_modules/synthetic-${i % 80}/lib/depth-${i % 4}/entry-${i}.js`,
          );
        const bootstrap = [
          "runtime/node.exe",
          "launch.mjs",
          "install.mjs",
          "node_modules/@design-studio/project-host/dist/installation.js",
        ];
        // 5,318 combined files includes two outer inventories and the release policy.
        const remaining = 5318 - payload.length - bootstrap.length - 3;
        for (let i = 0; i < remaining; i++)
          bootstrap.push(
            `runtime/node_modules/synthetic-${i % 50}/lib/entry-${i}.js`,
          );
        const manifest = await write("payload", payload);
        await write("bootstrap", bootstrap);
        const policy = Buffer.from(
          JSON.stringify({
            version: 1,
            manifestSha256: digest(manifest),
            catalogSha256: digest(contents),
          }),
        );
        await writeFile(
          path.join(source, "bootstrap", "release-policy.json"),
          policy,
        );
        const bootstrapInventory = encodeInventory([
          ...bootstrap.map((name) => ({
            path: name,
            bytes: contents.length,
            sha256: digest(contents),
          })),
          {
            path: "release-policy.json",
            bytes: policy.length,
            sha256: digest(policy),
          },
        ]);
        await writeFile(path.join(source, "payload-inventory.json"), manifest);
        await writeFile(
          path.join(source, "bootstrap-inventory.json"),
          bootstrapInventory,
        );
        const entry = await installCandidate(
          source,
          digest(manifest),
          digest(bootstrapInventory),
        );
        const installed = path.dirname(path.dirname(entry));
        const counts = {
          files: 5318,
          directories: created.filter((item) => item.directory).length,
          bytes:
            (payload.length + bootstrap.length) * contents.length +
            policy.length +
            manifest.length +
            bootstrapInventory.length,
          browserFiles: 299,
          rootLength: installed.length,
          leafDirectories: sourceDirs.size,
        };
        const service = child(root, installed, 2);
        children.push(service);
        const serviceReady = await service.next();
        expect(serviceReady.kind, JSON.stringify(serviceReady)).toBe("ready");
        const results: { case: string; result: Message }[] = [];
        for (const [name, command] of [
          ["serial-service", "serial"],
          ["pair-service", "pair"],
        ]) {
          service.send(command ?? "");
          const result = await service.next();
          expect(result.kind, JSON.stringify(result)).toBe("result");
          results.push({ case: name ?? "", result });
        }
        parentLease = await verifyInstalledRoot(installed);
        const outer = child(root, installed, 2);
        children.push(outer);
        const outerReady = await outer.next();
        expect(outerReady.kind, JSON.stringify(outerReady)).toBe("ready");
        const client = child(root, installed, 1);
        children.push(client);
        const clientReady = await client.next();
        expect(clientReady.kind, JSON.stringify(clientReady)).toBe("ready");
        service.send("pair");
        const result = await service.next();
        expect(result.kind, JSON.stringify(result)).toBe("result");
        results.push({
          case: "pair-service-with-idle-parent-outer-client",
          result,
        });
        const report = {
          profile:
            "synthetic-file-count-matched-only-not-exact-directory-histogram-or-content",
          actualReportedFiles: 5318,
          actualReportedBytes: 445944566,
          counts,
          iterationsPerCase: 1,
          expectedTotalPermanentPinsets: 6,
          expectedServiceGuards: 2,
          serviceReady,
          outerReady,
          clientReady,
          parentPinsets: 1,
          results,
        };
        await writeFile(output, JSON.stringify(report, null, 2), {
          flag: "wx",
        });
        console.info(
          JSON.stringify({
            profile: report.profile,
            counts,
            results: results.map((item) => ({
              case: item.case,
              wallMs: item.result.wallMs,
              durationsMs: item.result.durationsMs,
              maxHeartbeatGapMs: item.result.maxHeartbeatGapMs,
            })),
          }),
        );
      } finally {
        for (const worker of children.reverse()) await worker.close();
        await parentLease?.close();
        tracking.mockRestore();
        folder.mockRestore();
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
        expect(native.principal()).toBe(sid);
      }
    });
  },
  600000,
);
