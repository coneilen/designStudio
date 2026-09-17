import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { openAtTestRoot, ownedTest } from "./support.js";

const run = promisify(execFile);
const scope = {
  projectId: "child-fixture",
  artifactRootId: "blobs",
  permissionScope: "private",
};
const catalogBytes = Buffer.from("synthetic child fixture");
const options = {
  applicationId: "design-studio" as const,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true as const,
  fixtures: [scope],
};
test.skipIf(process.platform !== "win32")(
  "real competing processes reserve one project; child independently reattests by ID",
  async () => {
    await ownedTest(async (root, own) => {
      const registry = own(await openAtTestRoot(options, root));
      const script = fileURLToPath(new URL("./child.mjs", import.meta.url));
      const results = await Promise.allSettled([
        run(process.execPath, [script, root, "create"], {
          timeout: 10000,
          maxBuffer: 16384,
        }),
        run(process.execPath, [script, root, "create"], {
          timeout: 10000,
          maxBuffer: 16384,
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const binding = await registry.openFixtureProject(scope.projectId);
      await binding.attestLocalDatabase(binding.paths.database, scope);
      const before = await readFile(binding.paths.database);
      const opened = await run(process.execPath, [script, root, "open"], {
        timeout: 10000,
        maxBuffer: 16384,
      });
      expect(JSON.parse(opened.stdout)).toEqual({
        actorId: registry.currentPrincipal().actorId,
        paths: binding.paths,
      });
      expect(await readFile(binding.paths.database)).toEqual(before);
      await binding.close();
    });
  },
  20000,
);
