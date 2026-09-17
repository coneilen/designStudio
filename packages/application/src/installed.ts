import {
  registerFixtureInstallationGuards,
  verifyFixtureInstallation,
} from "@design-studio/project-host";

export async function openInstalledProject(create = false) {
  const installation = await verifyFixtureInstallation();
  const guard = registerFixtureInstallationGuards(installation);
  try {
    const module = await import("./installed-project.js");
    return await module.openProject(installation, guard, create);
  } catch (error) {
    guard.close();
    await installation.close();
    throw error;
  }
}
export async function acquireInstalledLauncher() {
  const installation = await verifyFixtureInstallation();
  const guard = registerFixtureInstallationGuards(installation);
  return {
    installation,
    async close() {
      guard.close();
      await installation.close();
    },
  };
}
