import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { WindowsFixtureProjects } from "../src/index.js";
import { loadNative } from "../src/native.js";
import { openAtTestRoot, ownedTest } from "./support.js";

const scope = {
  projectId: "fixture",
  artifactRootId: "blobs",
  permissionScope: "private",
};
const catalogBytes = Buffer.from("synthetic policy fixture");
const options = {
  applicationId: "design-studio" as const,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true as const,
  fixtures: [scope],
};
const windows = test.skipIf(process.platform !== "win32");

windows(
  "constructor owns catalog and scope snapshots before its first await",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const seam = vi.spyOn(native, "localAppData").mockReturnValue(root);
      const bytes = Buffer.from(catalogBytes);
      const mutableScope = { ...scope };
      const fixtures = [mutableScope];
      try {
        const opening = WindowsFixtureProjects.open({
          ...options,
          catalogBytes: bytes,
          fixtures,
        });
        bytes.fill(0);
        mutableScope.projectId = "changed";
        fixtures.length = 0;
        const registry = own(await opening);
        const binding = await registry.createFixtureProject(scope);
        expect(binding.scope).toEqual(scope);
        expect(binding.catalogIdentity).toBe(options.catalogIdentity);
        expect(Object.isFrozen(registry)).toBe(true);
        expect(Object.keys(registry).sort()).toEqual([
          "close",
          "createFixtureProject",
          "currentPrincipal",
          "openFixtureProject",
        ]);
      } finally {
        seam.mockRestore();
      }
    });
  },
);

windows(
  "exact catalog/scope/identifier maxima are accepted and excess is rejected",
  async () => {
    await ownedTest(async (root, own) => {
      const bytes = Buffer.alloc(1024 * 1024, 1);
      const fixtures = Array.from({ length: 64 }, (_, index) => ({
        projectId: "p".repeat(125) + String(index).padStart(3, "0"),
        artifactRootId: "a".repeat(128),
        permissionScope: "s".repeat(128),
      }));
      const maximum = {
        ...options,
        catalogBytes: bytes,
        catalogIdentity: createHash("sha256").update(bytes).digest("hex"),
        fixtures,
      };
      own(await openAtTestRoot(maximum, root));
      await expect(
        openAtTestRoot(
          { ...maximum, catalogBytes: Buffer.alloc(bytes.length + 1) },
          root,
        ),
      ).rejects.toThrow(/bounded/);
      await expect(
        openAtTestRoot({ ...maximum, fixtures: [...fixtures, scope] }, root),
      ).rejects.toThrow(/1..64/);
      await expect(
        openAtTestRoot(
          { ...options, fixtures: [{ ...scope, projectId: "a".repeat(129) }] },
          root,
        ),
      ).rejects.toThrow(/identifier/);
    });
  },
);

windows(
  "path bounds refuse before filesystem mutation and live bindings are capped at 64",
  async () => {
    const native = await loadNative();
    const inspecting = vi.spyOn(native, "inspect");
    try {
      await expect(
        openAtTestRoot(options, `C:\\${"a".repeat(200)}`),
      ).rejects.toThrow(/240/);
      expect(inspecting).not.toHaveBeenCalled();
    } finally {
      inspecting.mockRestore();
    }
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const first = await registry.createFixtureProject(scope);
      for (let index = 1; index < 64; index++)
        await registry.openFixtureProject(scope.projectId);
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/64 live/);
      await first.close();
      await (await registry.openFixtureProject(scope.projectId)).close();
    });
  },
);
