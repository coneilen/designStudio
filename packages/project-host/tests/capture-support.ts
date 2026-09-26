import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import {
  CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  captureDiagnosticPolicyBytes,
} from "../src/capture-diagnostic-profile.js";
import {
  CAPTURE_POLICY_SHA256,
  CAPTURE_PROFILE,
  capturePolicyBytes,
} from "../src/capture-profile.js";
import {
  CAPTURE_RECOVERY_POLICY_SHA256,
  captureRecoveryPolicyBytes,
} from "../src/capture-recovery-profile.js";
import {
  CAPTURE_REFERENCE_POLICY_SHA256,
  captureReferencePolicyBytes,
} from "../src/capture-reference-profile.js";
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
import {
  REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
  referenceConversionInspectionPolicyBytes,
} from "../src/reference-conversion-inspection-profile.js";
import {
  REFERENCE_OFFLINE_POLICY_SHA256,
  referenceOfflinePolicyBytes,
} from "../src/reference-offline-profile.js";
import {
  REFERENCE_VALIDATION_POLICY_SHA256,
  referenceValidationPolicyBytes,
} from "../src/reference-validation-profile.js";
import { ownedTest, weakenTestAcl } from "./support.js";

interface CaptureFixtureBytes {
  node?: Buffer;
  helper?: Buffer;
  sqlite?: Buffer;
  releaseVersion?: 7 | 8;
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
    ...(fixture.releaseVersion
      ? {
          "capture-recovery-policy.json": captureRecoveryPolicyBytes(),
          "capture-reference-policy.json": captureReferencePolicyBytes(),
          "capture-diagnostic-policy.json": captureDiagnosticPolicyBytes(),
          "reference-validation-policy.json": referenceValidationPolicyBytes(),
          "reference-offline-policy.json": referenceOfflinePolicyBytes(),
          ...(fixture.releaseVersion === 8
            ? {
                "reference-conversion-inspection-policy.json":
                  referenceConversionInspectionPolicyBytes(),
              }
            : {}),
        }
      : {}),
  });
  const bootstrap = await write("bootstrap", {
    "runtime/node.exe": fixture.node ?? synthetic,
    "launch.mjs": synthetic,
    "install.mjs": synthetic,
    "node_modules/@design-studio/project-host/dist/installation.js": synthetic,
    "release-policy.json": Buffer.from(
      JSON.stringify({
        version: fixture.releaseVersion ?? 2,
        kind: CAPTURE_PROFILE,
        manifestSha256: digest(manifest),
        capturePolicySha256: CAPTURE_POLICY_SHA256,
        ...(fixture.releaseVersion
          ? {
              captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
              captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
              captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
              referenceValidationPolicySha256:
                REFERENCE_VALIDATION_POLICY_SHA256,
              referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
              ...(fixture.releaseVersion === 8
                ? {
                    referenceConversionInspectionPolicySha256:
                      REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
                  }
                : {}),
            }
          : {}),
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
  const pending = runCaptureInstallation(work, fixture);
  onTestFinished(() => pending);
  return pending;
}

type CaptureInstallation = Awaited<
  ReturnType<typeof verifyCaptureInstalledRoot>
>;
type CaptureWork<T> = (
  installation: CaptureInstallation,
  root: string,
) => Promise<T>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Suite asset lifetime is separate from per-test work; neither may outlive its native overrides. */
export function captureInstallationSuite() {
  const ready = deferred<{ installation: CaptureInstallation; root: string }>();
  const stop = deferred<void>();
  const setup = new AbortController();
  let lifetime: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let closing = false;
  const operate = (work: CaptureWork<void>): Promise<void> => {
    if (!lifetime || closing || active)
      return Promise.reject(
        new Error("Capture suite fixture is unavailable or still owns work."),
      );
    const result = ready.promise.then(({ installation, root }) => {
      if (closing) throw new Error("Capture suite fixture closed before work.");
      return work(installation, root);
    });
    // The original result goes to the caller/test-finish hook; this promise only joins ownership.
    const joined = result.then(
      () => undefined,
      () => undefined,
    );
    active = joined;
    void joined.then(() => {
      if (active === joined) active = undefined;
    });
    return result;
  };
  return {
    start() {
      if (lifetime || closing)
        return Promise.reject(
          new Error("Capture suite fixture cannot be restarted."),
        );
      try {
        lifetime = runCaptureInstallation(
          async (installation, root) => {
            if (closing)
              throw new Error("Capture suite fixture closed during setup.");
            ready.resolve({ installation, root });
            await stop.promise;
            await active;
          },
          {},
          setup.signal,
        );
      } catch (error) {
        lifetime = Promise.reject(error);
      }
      void lifetime.catch((error: unknown) => ready.reject(error));
      return ready.promise;
    },
    prepare: operate,
    run(work: CaptureWork<void>): Promise<void> {
      const pending = operate(work);
      onTestFinished(() => pending);
      return pending;
    },
    async join() {
      await active;
    },
    async close() {
      closing = true;
      setup.abort();
      stop.resolve();
      await lifetime;
    },
  };
}

function runCaptureInstallation(
  work: CaptureWork<void>,
  fixture: CaptureFixtureBytes = {},
  setupSignal?: AbortSignal,
) {
  if (captureFixtureActive)
    throw new Error(
      "Prior capture fixture still owns native overrides; refuse overlapping admission.",
    );
  captureFixtureActive = true;
  return run();
  async function run() {
    let releaseOverrides: (() => void) | undefined;
    let quiesced = true;
    try {
      await ownedTest(async (root) => {
        setupSignal?.throwIfAborted();
        const native = await loadNative();
        setupSignal?.throwIfAborted();
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
          setupSignal?.throwIfAborted();
          const launch = await installCandidate(
            candidate.source,
            candidate.manifest,
            candidate.bootstrap,
          );
          setupSignal?.throwIfAborted();
          installation = await verifyCaptureInstalledRoot(
            path.dirname(path.dirname(launch)),
          );
          setupSignal?.throwIfAborted();
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
