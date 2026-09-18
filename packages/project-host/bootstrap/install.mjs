import { fileURLToPath } from "node:url";
import { preflight } from "./preflight.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [manifestFlag, manifest, bootstrapFlag, bootstrap] =
  process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  manifestFlag !== "--approve-manifest" ||
  bootstrapFlag !== "--approve-bootstrap"
)
  throw new Error(
    "After independently reviewing this release, run install.mjs --approve-manifest <exact SHA256> --approve-bootstrap <exact SHA256>. Self-checks do not establish provenance.",
  );
const checked = await preflight();
try {
  checked.api.establishBootstrapOrigin(root);
  const entry = await checked.api.installCandidate(root, manifest, bootstrap);
  process.stdout.write(
    `Installed selected offline release. Launch with its bootstrap runtime and ${entry}\n`,
  );
} finally {
  checked.close();
}
