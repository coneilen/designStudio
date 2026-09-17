import { fileURLToPath, pathToFileURL } from "node:url";
import { preflight } from "./preflight.mjs";

if (process.argv[2] !== "cli")
  throw new Error("The installed launcher accepts only the fixed cli role.");
const checked = await preflight();
checked.api.establishBootstrapOrigin(
  fileURLToPath(new URL("../", import.meta.url)),
);
const lease = await checked.api.verifyFixtureInstallation();
const guard = checked.api.registerFixtureInstallationGuards(lease);
checked.close();
// The outer guard and native pins are intentionally process-lifetime resources.
// Neither import completion nor beforeExit proves pending native jobs are quiescent.
// F08 owns explicit child/job teardown; process exit releases these final OS pins.
process.once("exit", () => guard.close());
process.argv = [
  lease.paths.node,
  lease.paths.cliEntry,
  ...process.argv.slice(3),
];
await import(pathToFileURL(lease.paths.cliEntry).href);
