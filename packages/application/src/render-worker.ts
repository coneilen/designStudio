import {
  registerFixtureInstallationGuards,
  verifyFixtureInstallation,
} from "@design-studio/project-host";

const installation = await verifyFixtureInstallation();
const guard = registerFixtureInstallationGuards(installation);
let worker: Awaited<
  ReturnType<
    typeof import("./worker-implementation.js")["createInstalledWorker"]
  >
>;
try {
  const implementation = await import("./worker-implementation.js");
  worker = await implementation.createInstalledWorker(installation);
} catch (error) {
  guard.close();
  await installation.close();
  throw error;
}
export function render(
  bytes: Uint8Array,
  context: { signal: AbortSignal },
): Promise<Uint8Array> {
  return worker.render(bytes, context);
}
export async function close(): Promise<void> {
  if (!worker.close)
    throw new Error("Verified renderer has no shutdown operation.");
  await worker.close();
  guard.close();
  await installation.close();
}
