import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  installCandidate,
  registerFixtureInstallationGuards,
  verifyFixtureInstallation,
  verifyInstalledRoot,
} from "../src/installation.js";
import {
  digest,
  encodeInventory,
  type InventoryFile,
} from "../src/installation-manifest.js";
import { type InstallationEntry, loadNative } from "../src/native.js";
import { ownedTest, weakenTestAcl } from "./support.js";

async function candidate(
  root: string,
): Promise<{ root: string; manifest: string; bootstrap: string }> {
  const source = path.join(root, "source");
  await mkdir(source);
  const catalog = Buffer.from("synthetic catalog: never a production release");
  const payload: Record<string, Buffer> = Object.fromEntries(
    [
      "packages/cli/dist/main.js",
      "packages/application/dist/render-worker.js",
      "node_modules/@design-studio/project-host/dist/index.js",
      "native/better_sqlite3.node",
      "browser/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
    ].map((filename) => [
      filename,
      Buffer.from("synthetic non-executable engine test bytes"),
    ]),
  );
  payload["fixtures/foundation/manifest.json"] = catalog;
  const write = async (area: string, records: Record<string, Buffer>) => {
    const files: InventoryFile[] = [];
    for (const [filename, bytes] of Object.entries(records)) {
      const target = path.join(source, area, ...filename.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      files.push({
        path: filename,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
    return encodeInventory(files);
  };
  const manifest = await write("payload", payload);
  const bootstrap = await write("bootstrap", {
    "runtime/node.exe": Buffer.from("synthetic not executed"),
    "launch.mjs": Buffer.from("synthetic not executed"),
    "install.mjs": Buffer.from("synthetic not executed"),
    "node_modules/@design-studio/project-host/dist/installation.js":
      Buffer.from("synthetic not executed"),
    "release-policy.json": Buffer.from(
      JSON.stringify({
        version: 1,
        manifestSha256: digest(manifest),
        catalogSha256: digest(catalog),
      }),
    ),
  });
  await writeFile(path.join(source, "payload-inventory.json"), manifest);
  await writeFile(path.join(source, "bootstrap-inventory.json"), bootstrap);
  return {
    root: source,
    manifest: digest(manifest),
    bootstrap: digest(bootstrap),
  };
}

async function ownedInstallation(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  await ownedTest(async (root) => {
    const native = await loadNative();
    const folder = vi.spyOn(native, "localAppData").mockReturnValue(root);
    const created: { entry: InstallationEntry; directory: boolean }[] = [];
    const create = native.createInstallationEntry.bind(native);
    const spy = vi
      .spyOn(native, "createInstallationEntry")
      .mockImplementation((...args) => {
        const entry = create(...args);
        created.push({ entry, directory: args[1] });
        return entry;
      });
    try {
      await operation(root);
    } finally {
      spy.mockRestore();
      folder.mockRestore();
      for (const { entry, directory } of created) {
        entry.close();
        const current = native.inspect(entry.identity.path, directory);
        try {
          expect(current.identity).toEqual(entry.identity);
          await weakenTestAcl(root, entry.identity.path, false, true);
        } finally {
          current.close();
        }
      }
    }
  });
}
const windows = test.skipIf(process.platform !== "win32");
test("production verifier without a selected installed bootstrap stays action-required", async () => {
  await expect(verifyFixtureInstallation()).rejects.toMatchObject({
    code:
      process.platform === "win32" && process.arch === "x64"
        ? "ACTION_REQUIRED"
        : "UNSUPPORTED_HOST",
  });
  expect(() =>
    registerFixtureInstallationGuards({
      paths: {},
      identity: "forged",
    } as never),
  ).toThrow(/live native/);
});
windows(
  "synthetic engine fixture privately installs/seals/reopens; guards and native lease lifetime are coupled",
  async () => {
    await ownedInstallation(async (root) => {
      const release = await candidate(root);
      const entry = await installCandidate(
        `${release.root}${path.sep}`,
        release.manifest,
        release.bootstrap,
      );
      const installed = path.dirname(path.dirname(entry));
      const lease = await verifyInstalledRoot(installed);
      try {
        await lease.recheck();
        expect(lease.paths.bootstrapEntry).toBe(entry);
        expect(lease.paths.browserRoot).toBe(
          path.join(installed, "payload", "browser"),
        );
        await expect(
          writeFile(lease.paths.cliEntry, "tamper"),
        ).rejects.toThrow();
        const guard = registerFixtureInstallationGuards(lease);
        try {
          await expect(lease.close()).rejects.toThrow(/quiescence/);
        } finally {
          guard.close();
        }
        await lease.close();
        await expect(lease.recheck()).rejects.toThrow(/closed/);
        await expect(
          installCandidate(release.root, release.manifest, release.bootstrap),
        ).rejects.toThrow(/Win32 183/);
      } finally {
        await lease.close();
      }
    });
  },
);
windows(
  "wrong approval, source tamper and extra entries never reach installation creation",
  async () => {
    await ownedInstallation(async (root) => {
      const release = await candidate(root);
      await expect(
        installCandidate(release.root, "0".repeat(64), release.bootstrap),
      ).rejects.toThrow(/identities/);
      await writeFile(path.join(release.root, "payload", "extra.js"), "extra");
      await expect(
        installCandidate(release.root, release.manifest, release.bootstrap),
      ).rejects.toThrow(/extra/);
      expect(
        await readFile(path.join(release.root, "payload", "extra.js"), "utf8"),
      ).toBe("extra");
    });
  },
);

windows(
  "injected destination creation failure releases source pins and retains an unadoptable reservation",
  async () => {
    await ownedInstallation(async (root) => {
      const release = await candidate(root);
      const native = await loadNative();
      const actualPin = native.pinRead.bind(native);
      const pins = new Set<ReturnType<typeof native.pinRead>>();
      const pinSpy = vi
        .spyOn(native, "pinRead")
        .mockImplementation((...args) => {
          const pin = actualPin(...args);
          const wrapped = {
            ...pin,
            close() {
              pin.close();
              pins.delete(wrapped);
            },
          };
          pins.add(wrapped);
          return wrapped;
        });
      const created = vi
        .mocked(native.createInstallationEntry)
        .getMockImplementation();
      if (!created) throw new Error("Expected owned-entry tracking seam.");
      vi.mocked(native.createInstallationEntry).mockImplementation(
        (filename, directory, sid) => {
          if (!directory)
            throw new Error("injected destination create failure");
          return created(filename, directory, sid);
        },
      );

      try {
        await expect(
          installCandidate(release.root, release.manifest, release.bootstrap),
        ).rejects.toThrow(/injected destination/);
        expect(pins.size).toBe(0);
        vi.mocked(native.createInstallationEntry).mockImplementation(created);
        await expect(
          installCandidate(release.root, release.manifest, release.bootstrap),
        ).rejects.toThrow(/Win32 183/);
      } finally {
        vi.mocked(native.createInstallationEntry).mockImplementation(created);
        for (const pin of pins) pin.close();
        pinSpy.mockRestore();
      }
    });
  },
);

windows(
  "installed registration edits and reader ACL outside browser fail without adoption or repair",
  async () => {
    await ownedInstallation(async (root) => {
      const release = await candidate(root);
      const entry = await installCandidate(
        release.root,
        release.manifest,
        release.bootstrap,
      );
      const installed = path.dirname(path.dirname(entry));
      const receipt = path.join(path.dirname(installed), "registration.json");
      const lease = await verifyInstalledRoot(installed);
      try {
        const bytes = await readFile(receipt);
        await writeFile(receipt, Buffer.concat([bytes, Buffer.of(32)]));
        await expect(lease.recheck()).rejects.toThrow(/registration changed/);
        await expect(verifyInstalledRoot(installed)).rejects.toThrow(
          /noncanonical/,
        );
        await writeFile(receipt, bytes);
        await weakenTestAcl(root, lease.paths.cliEntry);
        await expect(lease.recheck()).rejects.toThrow(/DACL|trustee/);
        await expect(verifyInstalledRoot(installed)).rejects.toThrow(
          /DACL|trustee/,
        );
      } finally {
        await lease.close();
      }
    });
  },
);

windows(
  "installation close failure drains other native pins, blocks reuse, and supports close-only retry",
  async () => {
    await ownedInstallation(async (root) => {
      const release = await candidate(root);
      const entry = await installCandidate(
        release.root,
        release.manifest,
        release.bootstrap,
      );
      const native = await loadNative();
      const real = native.pinInstallation.bind(native);
      let inject = false;
      const live = new Set<object>();
      const spy = vi
        .spyOn(native, "pinInstallation")
        .mockImplementation((...args) => {
          const pin = real(...args);
          const token = {};
          live.add(token);
          return {
            ...pin,
            close() {
              pin.close();
              live.delete(token);
              if (inject) {
                inject = false;
                throw new Error("injected close report after actual release");
              }
            },
          };
        });
      try {
        const lease = await verifyInstalledRoot(
          path.dirname(path.dirname(entry)),
        );
        inject = true;
        await expect(lease.close()).rejects.toThrow(/release failed/);
        expect(live.size).toBe(0);
        await expect(lease.recheck()).rejects.toThrow(/closed/);
        expect(() => registerFixtureInstallationGuards(lease)).toThrow(
          /live native/,
        );
        await lease.close();
      } finally {
        spy.mockRestore();
      }
    });
  },
);
