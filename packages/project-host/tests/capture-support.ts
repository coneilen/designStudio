import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import {
  CAPTURE_POLICY_SHA256,
  CAPTURE_PROFILE,
  capturePolicyBytes,
} from "../src/capture-profile.js";
import {
  installCandidate,
  verifyCaptureInstalledRoot,
} from "../src/installation.js";
import {
  digest,
  encodeInventory,
  type InventoryFile,
} from "../src/installation-manifest.js";
import { type InstallationEntry, loadNative } from "../src/native.js";
import { ownedTest, weakenTestAcl } from "./support.js";

interface CaptureFixtureBytes {
  node?: Buffer;
  helper?: Buffer;
  sqlite?: Buffer;
}
let captureFixtureActive = false;
export async function captureCandidate(
  root: string,
  fixture: CaptureFixtureBytes = {},
) {
  const source = path.join(root, "capture-source");
  await mkdir(source);
  const write = async (area: string, records: Record<string, Buffer>) => {
    const files: InventoryFile[] = [];
    for (const [relative, bytes] of Object.entries(records)) {
      const filename = path.join(source, area, ...relative.split("/"));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes, { flag: "wx" });
      files.push({
        path: relative,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
    return encodeInventory(files);
  };
  const synthetic = Buffer.from("synthetic inert role bytes; NEVER execute");
  const manifest = await write("payload", {
    "packages/cli/dist/capture-main.js": synthetic,
    "packages/project-host/dist/pat-dialog-helper.js":
      fixture.helper ?? synthetic,
    "node_modules/@design-studio/project-host/dist/index.js": synthetic,
    "node_modules/@design-studio/figma-capture/dist/index.js": synthetic,
    "node_modules/@design-studio/figma-import/dist/index.js": synthetic,
    "native/better_sqlite3.node": fixture.sqlite ?? synthetic,
    "capture-policy.json": capturePolicyBytes(),
  });
  const bootstrap = await write("bootstrap", {
    "runtime/node.exe": fixture.node ?? synthetic,
    "launch.mjs": synthetic,
    "install.mjs": synthetic,
    "node_modules/@design-studio/project-host/dist/installation.js": synthetic,
    "release-policy.json": Buffer.from(
      JSON.stringify({
        version: 2,
        kind: CAPTURE_PROFILE,
        manifestSha256: digest(manifest),
        capturePolicySha256: CAPTURE_POLICY_SHA256,
      }),
    ),
  });
  await writeFile(path.join(source, "payload-inventory.json"), manifest);
  await writeFile(path.join(source, "bootstrap-inventory.json"), bootstrap);
  return { source, manifest: digest(manifest), bootstrap: digest(bootstrap) };
}
export async function withCaptureInstallation(
  work: (
    installation: Awaited<ReturnType<typeof verifyCaptureInstalledRoot>>,
    root: string,
  ) => Promise<void>,
  fixture: CaptureFixtureBytes = {},
) {
  if (captureFixtureActive)
    throw new Error(
      "Prior capture fixture still owns native overrides; refuse overlapping admission.",
    );
  captureFixtureActive = true;
  const pending = run();
  onTestFinished(() => pending);
  return pending;
  async function run() {
    let releaseOverrides: (() => void) | undefined;
    let quiesced = true;
    try {
      await ownedTest(async (root) => {
        const native = await loadNative();
        const folder = vi.spyOn(native, "localAppData").mockReturnValue(root);
        const entries: { entry: InstallationEntry; directory: boolean }[] = [];
        const create = native.createInstallationEntry.bind(native);
        const tracking = vi
          .spyOn(native, "createInstallationEntry")
          .mockImplementation((...args) => {
            const entry = create(...args);
            entries.push({ entry, directory: args[1] });
            return entry;
          });
        quiesced = false;
        releaseOverrides = () => {
          tracking.mockRestore();
          folder.mockRestore();
        };
        let installation:
          | Awaited<ReturnType<typeof verifyCaptureInstalledRoot>>
          | undefined;
        const errors: unknown[] = [];
        try {
          const candidate = await captureCandidate(root, fixture);
          const launch = await installCandidate(
            candidate.source,
            candidate.manifest,
            candidate.bootstrap,
          );
          installation = await verifyCaptureInstalledRoot(
            path.dirname(path.dirname(launch)),
          );
          await work(installation, root);
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            await installation?.close();
            for (const { entry } of entries) {
              entry.close();
              await weakenTestAcl(root, entry.identity.path, false, true);
            }
            quiesced = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            "Capture fixture operation/cleanup failed.",
            { cause: errors[0] },
          );
      });
    } finally {
      if (quiesced) {
        releaseOverrides?.();
        captureFixtureActive = false;
      }
    }
  }
}
