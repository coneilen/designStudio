import { createHash } from "node:crypto";
import { link, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadNative } from "../src/native.js";
import { openAtTestRoot, ownedTest, weakenTestAcl } from "./support.js";

const scope = {
  projectId: "fixture",
  artifactRootId: "blobs",
  permissionScope: "private",
};
const catalogBytes = Buffer.from("synthetic deny fixtures");
const options = {
  applicationId: "design-studio" as const,
  catalogBytes,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  trustedImmutableInstallation: true as const,
  fixtures: [scope],
};
const windows = test.skipIf(process.platform !== "win32");

windows(
  "real registry tamper is denied both live and after reopen",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const record = path.join(
        path.dirname(path.dirname(binding.paths.database)),
        "registration.json",
      );
      const original = await readFile(record);
      await writeFile(
        record,
        original.toString().replace('"private"', '"foreign"'),
      );
      await expect(binding.recheck()).rejects.toThrow(/registration changed/);
      await binding.close();
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/scope/);
      await writeFile(record, "{");
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/Torn/);
      await writeFile(record, Buffer.alloc(65537));
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/64 KiB/);
      await writeFile(record, Buffer.concat([original, Buffer.from(" ")]));
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/canonical/);
    });
  },
);

windows(
  "real replacement DB with identical bytes and valid ACL is not adopted",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const filename = binding.paths.database;
      await binding.close();
      await rename(filename, `${filename}.original`);
      native.createFile(filename, native.principal(), Buffer.alloc(0));
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/identity changed/);
    });
  },
);

windows(
  "real hard-linked DB and missing registered DB are refused",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const filename = binding.paths.database;
      await binding.close();
      await link(filename, `${filename}.alias`);
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/multiply-linked/);
      await rename(filename, `${filename}.moved`);
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/CreateFileW/);
    });
  },
);

windows(
  "real junction at registered role and permissive ACL are refused without repair",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const artifacts = binding.paths.artifacts;
      const outputs = binding.paths.outputs;
      await binding.close();
      await rename(artifacts, `${artifacts}.original`);
      await symlink(outputs, artifacts, "junction");
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/Reparse/);
    });
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      await weakenTestAcl(root, binding.paths.artifacts);
      await expect(binding.recheck()).rejects.toThrow(/DACL|trustee/);
      await binding.close();
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/DACL|trustee/);
    });
  },
);

windows(
  "real native CREATE_NEW and no-replace rename never overwrite existing bytes",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const destination = path.join(binding.paths.temp, "committed.json");
      const source = path.join(binding.paths.temp, "pending.json");
      native.createFile(destination, native.principal(), Buffer.from("winner"));
      expect(() =>
        native.createFile(
          destination,
          native.principal(),
          Buffer.from("loser"),
        ),
      ).toThrow(/Win32 (80|183)/);
      expect(() =>
        native.createFile(
          source,
          native.principal(),
          Buffer.from("pending"),
          destination,
        ),
      ).toThrow(/no replace/);
      expect(await readFile(destination, "utf8")).toBe("winner");
      expect(await readFile(source, "utf8")).toBe("pending");
    });
  },
);

windows(
  "real null DACL cannot become a private fixture attestation",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      await weakenTestAcl(root, binding.paths.artifacts, true);
      await expect(binding.recheck()).rejects.toThrow(/non-null/);
      await binding.close();
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/non-null/);
    });
  },
);

windows(
  "labeled injected creation fault leaves an action-required reservation, never guessed cleanup",
  async () => {
    await ownedTest(async (root, own) => {
      const native = await loadNative();
      const registry = own(await openAtTestRoot(options, root));
      const fault = new Error("injected before registration publication");
      const real = native.createFile.bind(native);
      const spy = vi
        .spyOn(native, "createFile")
        .mockImplementation((filename, sid, bytes, destination) => {
          if (destination) throw fault;
          real(filename, sid, bytes);
        });
      try {
        await expect(registry.createFixtureProject(scope)).rejects.toBe(fault);
      } finally {
        spy.mockRestore();
      }
      await expect(registry.createFixtureProject(scope)).rejects.toThrow(
        /Win32 183/,
      );
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/CreateFileW/);
    });
  },
);

windows(
  "binding close races and registry close invalidate attestations, without deleting data",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const binding = await registry.createFixtureProject(scope);
      const checking = binding.recheck();
      await binding.close();
      await expect(checking).rejects.toThrow(/closed/);
      expect(await readFile(binding.paths.database)).toHaveLength(0);
      await registry.close();
      expect(() => registry.currentPrincipal()).toThrow(/closed/);
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/closed/);
    });
  },
);

windows(
  "changed private registry ancestor ACL blocks reopen and creation before mutation",
  async () => {
    await ownedTest(async (root, own) => {
      const other = { ...scope, projectId: "second" };
      const registry = own(
        await openAtTestRoot({ ...options, fixtures: [scope, other] }, root),
      );
      const binding = await registry.createFixtureProject(scope);
      const catalog = path.dirname(
        path.dirname(path.dirname(binding.paths.database)),
      );
      await binding.close();
      await weakenTestAcl(root, catalog);
      await expect(
        registry.openFixtureProject(scope.projectId),
      ).rejects.toThrow(/DACL|trustee/);
      await expect(registry.createFixtureProject(other)).rejects.toThrow(
        /DACL|trustee/,
      );
    });
  },
);
