import { fileURLToPath, pathToFileURL } from "node:url";
import { preflight } from "./preflight.mjs";

const role = process.argv[2];
if (!["cli", "capture", "pat-helper"].includes(role))
  throw new Error("The installed launcher accepts only fixed reviewed roles.");
const checked = await preflight();
checked.api.establishBootstrapOrigin(
  fileURLToPath(new URL("../", import.meta.url)),
);
const lease =
  role === "cli"
    ? await checked.api.verifyFixtureInstallation()
    : await checked.api.verifyCaptureInstallation();
const guard =
  role === "cli"
    ? checked.api.registerFixtureInstallationGuards(lease)
    : checked.api.registerCaptureInstallationGuards(lease);
checked.close();
// The outer guard and native pins are intentionally process-lifetime resources.
// Neither import completion nor beforeExit proves pending native jobs are quiescent.
// F08 owns explicit child/job teardown; process exit releases these final OS pins.
process.once("exit", () => guard.close());
const entry =
  role === "pat-helper" ? lease.paths.dialogEntry : lease.paths.cliEntry;
process.argv = [lease.paths.node, entry, ...process.argv.slice(3)];
await import(pathToFileURL(entry).href);
