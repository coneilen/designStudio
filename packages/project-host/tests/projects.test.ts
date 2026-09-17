import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { WindowsFixtureProjects } from "../src/index.js";
import { loadNative } from "../src/native.js";
import { openAtTestRoot, ownedTest } from "./support.js";

const scope = {
  projectId: "fixture-project",
  artifactRootId: "fixture-artifacts",
  permissionScope: "fixture-private",
};
const catalogBytes = Buffer.from("reviewed synthetic fixture catalog");
const options = {
  applicationId: "design-studio" as const,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true as const,
  fixtures: [scope],
};

describe.runIf(process.platform === "win32")(
  "real owned Windows fixture provisioning",
  () => {
    test("observes actual token and native KnownFolder without env trust", async () => {
      const native = await loadNative();
      const observed = native.principal();
      expect(observed).toMatch(/^S-1-/);
      expect(path.win32.isAbsolute(native.localAppData())).toBe(true);
      expect(native.principal()).toBe(observed);
    });

    test("private creation, registered reopen, SQLite mutation and scope denial", async () => {
      await ownedTest(async (root, own) => {
        const registry = own(await openAtTestRoot(options, root));
        const principal = registry.currentPrincipal();
        expect(principal.actorId).toMatch(/^windows-/);
        const binding = await registry.createFixtureProject(scope);
        expect(binding.paths.database).not.toContain(scope.projectId);
        expect(await readFile(binding.paths.database)).toHaveLength(0);
        await binding.attestLocalDatabase(binding.paths.database, scope);
        const sql = new DatabaseSync(binding.paths.database);
        sql.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES(42);",
        );
        sql.close();
        await binding.attestLocalDatabase(binding.paths.database, scope);
        await expect(
          binding.attestLocalDatabase(binding.paths.database, {
            ...scope,
            permissionScope: "foreign",
          }),
        ).rejects.toThrow();
        await expect(
          binding.attestLocalDatabase(path.join(root, "foreign.db"), scope),
        ).rejects.toThrow();
        await binding.close();
        await expect(binding.recheck()).rejects.toThrow();
        await registry.close();
        const reopened = own(await openAtTestRoot(options, root));
        const second = await reopened.openFixtureProject(scope.projectId);
        await second.recheck();
        await second.close();
        await reopened.close();
      });
    });

    test("same-ID no-replace and unknown registry refuse without adoption", async () => {
      await ownedTest(async (root, own) => {
        const first = own(await openAtTestRoot(options, root));
        const second = own(await openAtTestRoot(options, root));
        await expect(
          first.openFixtureProject(scope.projectId),
        ).rejects.toThrow();
        const results = await Promise.allSettled([
          first.createFixtureProject(scope),
          second.createFixtureProject(scope),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        for (const result of results)
          if (result.status === "fulfilled") await result.value.close();
        await expect(
          first.createFixtureProject({ ...scope, projectId: randomUUID() }),
        ).rejects.toThrow();
        await first.close();
        await second.close();
      });
    });

    test("refuses a preexisting foreign application directory, never repairs it", async () => {
      await ownedTest(async (root) => {
        await writeFile(path.join(root, "DesignStudio"), "foreign");
        await expect(openAtTestRoot(options, root)).rejects.toThrow();
        expect(await readFile(path.join(root, "DesignStudio"), "utf8")).toBe(
          "foreign",
        );
      });
    });
  },
);

test("trusted catalog bytes are checked before native or filesystem work", async () => {
  await expect(
    WindowsFixtureProjects.open({
      ...options,
      catalogBytes: Buffer.from("tampered"),
    }),
  ).rejects.toThrow();
});

test.skipIf(process.platform !== "win32")(
  "shared-memory catalog bytes are rejected before creating registry namespaces",
  async () => {
    await ownedTest(async (root, own) => {
      const shared = new Uint8Array(
        new SharedArrayBuffer(catalogBytes.byteLength),
      );
      shared.set(catalogBytes);
      await expect(
        openAtTestRoot({ ...options, catalogBytes: shared }, root).then(own),
      ).rejects.toThrow(/shared/i);
    });
  },
);
