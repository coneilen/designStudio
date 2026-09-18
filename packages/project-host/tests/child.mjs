import { createHash } from "node:crypto";
import path from "node:path";
import { WindowsFixtureProjects } from "../dist/index.js";
import { loadNative } from "../dist/native.js";

const [root, mode] = process.argv.slice(2);
if (!root || !path.basename(root).startsWith("ds-ph-"))
  throw new Error("Child test requires an exact generated test namespace.");
const catalogBytes = Buffer.from("synthetic child fixture");
const scope = {
  projectId: "child-fixture",
  artifactRootId: "blobs",
  permissionScope: "private",
};
const native = await loadNative();
// Test-only folder seam; the independent child still queries its real token/ACLs/identities.
native.localAppData = () => root;
const registry = await WindowsFixtureProjects.open({
  applicationId: "design-studio",
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true,
  fixtures: [scope],
});
try {
  const binding =
    mode === "create"
      ? await registry.createFixtureProject(scope)
      : await registry.openFixtureProject(scope.projectId);
  await binding.attestLocalDatabase(binding.paths.database, scope);
  process.stdout.write(
    JSON.stringify({
      actorId: registry.currentPrincipal().actorId,
      paths: binding.paths,
    }),
  );
  await binding.close();
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message : "Child fixture failure",
  );
  process.exitCode = 2;
} finally {
  await registry.close();
}
