import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadNative } from "../src/native.js";
import { openAtTestRoot, ownedTest } from "./support.js";

const catalogBytes = Buffer.from("synthetic lifetime fixture");
const scope = {
  projectId: "lifetime",
  artifactRootId: "blobs",
  permissionScope: "private",
};
const options = {
  applicationId: "design-studio" as const,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true as const,
  fixtures: [scope],
};
const windows = test.skipIf(process.platform !== "win32");

windows(
  "labeled close fault drains every binding and ancestor and denies reuse until close retry",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const real = native.inspect.bind(native);
      const active = new Set<object>();
      let inject = false;
      const spy = vi
        .spyOn(native, "inspect")
        .mockImplementation((filename, directory, sid) => {
          const lease = real(filename, directory, sid);
          const token = {};
          active.add(token);
          return {
            ...lease,
            close() {
              lease.close();
              active.delete(token);
              if (inject && filename.endsWith("\\database.sqlite")) {
                inject = false;
                throw new Error("injected close failure after actual release");
              }
            },
          };
        });
      try {
        const registry = own(await openAtTestRoot(options, root));
        await registry.createFixtureProject(scope);
        await registry.openFixtureProject(scope.projectId);
        inject = true;
        await expect(registry.close()).rejects.toThrow();
        expect(active.size).toBe(0);
        expect(() => registry.currentPrincipal()).toThrow(/closed/);
        await registry.close();
      } finally {
        spy.mockRestore();
      }
    });
  },
);

windows(
  "real native process HANDLE count returns to baseline after repeated token/reopen/failure/close",
  async () => {
    const native = await loadNative();
    const koffi = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const processHandle: () => number | bigint = kernel.func(
      "uintptr_t __stdcall GetCurrentProcess()",
    );
    const query: (handle: number | bigint, count: Buffer) => number =
      kernel.func(
        "int __stdcall GetProcessHandleCount(uintptr_t, _Out_ void *)",
      );
    const count = () => {
      const output = Buffer.alloc(4);
      if (!query(processHandle(), output))
        throw new Error("Test HANDLE observation failed.");
      return output.readUInt32LE();
    };
    const cold = count();
    await ownedTest(async (root, own) => {
      // Warm up Koffi and fixture filesystem before the actual native resource observation.
      const warm = own(await openAtTestRoot(options, root));
      await (await warm.createFixtureProject(scope)).close();
      await warm.close();
      native.principal();
      native.localAppData();
      const before = count();
      for (let index = 0; index < 20; index++) {
        native.principal();
        native.localAppData();
        const registry = own(await openAtTestRoot(options, root));
        const binding = await registry.openFixtureProject(scope.projectId);
        await binding.recheck();
        await expect(registry.createFixtureProject(scope)).rejects.toThrow();
        await registry.close();
      }
      const after = count();
      console.info(
        `Native HANDLE observation: cold=${cold}, warmed=${before}, after20=${after}, tolerance=2`,
      );
      expect(after).toBeLessThanOrEqual(before + 2);
    });
  },
);

windows(
  "labeled injected inspect plus release faults preserve the original failure and release every handle",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const registry = own(await openAtTestRoot(options, root));
      await (await registry.createFixtureProject(scope)).close();
      const real = native.inspect.bind(native);
      const original = new Error("injected original verification failure");
      let count = 0;
      const spy = vi
        .spyOn(native, "inspect")
        .mockImplementation((filename, directory, sid) => {
          if (filename.endsWith("\\outputs")) throw original;
          const lease = real(filename, directory, sid);
          if (filename.endsWith("\\artifacts")) {
            return {
              ...lease,
              close() {
                lease.close();
                count++;
                throw new Error("injected close result after actual release");
              },
            };
          }
          return lease;
        });
      try {
        await expect(
          registry.openFixtureProject(scope.projectId),
        ).rejects.toMatchObject({ cause: original });
        expect(count).toBe(1);
      } finally {
        spy.mockRestore();
      }
      await (await registry.openFixtureProject(scope.projectId)).close();
    });
  },
);
