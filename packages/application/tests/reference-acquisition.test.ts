import { writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import type {
  NativeReferenceEnvelope,
  OperationContext,
  StagedArtifact,
} from "@design-studio/contracts";
import { parseContract } from "@design-studio/contracts";
import { fakeComplete } from "@design-studio/contracts/testing";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import {
  authorizeOperation,
  HostBoundaryError,
  ProjectFileSystem,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { JobService } from "@design-studio/jobs";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import {
  afterEach,
  aroundEach,
  beforeEach,
  describe,
  expect,
  vi,
  it as vitestIt,
} from "vitest";
import {
  image as authoredPng,
  chunk,
  srgb,
} from "../../assets/tests/png-fixtures.js";
import * as referenceDecoder from "../../figma-capture/dist/decode.js";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { png } from "../../figma-capture/tests/support.js";
import { WindowsNtfsPublisher } from "../../host/dist/windows-publication.js";
import { deferred } from "../../host/tests/deferred.js";
import {
  closePortablePins,
  type PortablePinOwner,
  portableRetainedPin,
} from "../../host/tests/portable-retained-pin.js";
import { Execution } from "../../jobs/dist/execution.js";
import {
  observeSelectedTest,
  type TestObservation,
} from "../../jobs/tests/test-observation.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "../../project-host/src/capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "../../project-host/src/capture-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../../project-host/src/capture-reference-profile.js";
import { loadNative, type ReadLease } from "../../project-host/src/native.js";
import {
  pinReferenceBackupFile,
  publishReferenceBackupFile,
} from "../../project-host/src/reference-backup.js";
import { REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256 } from "../../project-host/src/reference-conversion-inspection-profile.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "../../project-host/src/reference-offline-profile.js";
import { pinImmutableReferenceDatabase } from "../../project-host/src/reference-validation-database.js";
import { pinRetainedReferenceEntry } from "../../project-host/src/reference-validation-entry.js";
import { REFERENCE_VALIDATION_POLICY_SHA256 } from "../../project-host/src/reference-validation-profile.js";
import { createRetainedOwnerFixture } from "../../project-host/tests/retained-owner-fixture.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import { rewriteSyntheticRetainedEvidence } from "../../storage/tests/capture-recovery-corruption.js";
import {
  closeSettledStores,
  joinSettledStores,
} from "../../storage/tests/lifetime.js";
import {
  backupSyntheticOffline,
  observeSyntheticDatabasePreimage,
  observeSyntheticReference,
} from "../../storage/tests/reference-recovery-observer.js";
import {
  syntheticBackupPin,
  syntheticImmutableSnapshot,
} from "../../storage/tests/support.js";
import {
  assembleNativeCapture,
  NativeCaptureCleanupRequired,
  type NativeCaptureRuntime,
} from "../src/capture-runtime-internal.js";
import { ReferenceInput } from "../src/reference-input.js";
import {
  type NativeReferenceOfflineInput,
  openNativeReferenceConversionInspection,
  openNativeReferenceOffline,
  REFERENCE_CONVERSION_CONFIRMATION,
} from "../src/reference-offline.js";
import { ReferenceReader } from "../src/reference-proof.js";
import {
  DIAGNOSTIC_APPROVAL_CONFIRMATION,
  DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
  REFERENCE_APPROVAL_CONFIRMATION,
  REFERENCE_DOWNLOAD_CONFIRMATION,
} from "../src/reference-runtime.js";
import { openNativeReferenceValidation } from "../src/reference-validation.js";
import {
  AsyncTestScope,
  captureTestScope,
  inCaptureTest,
  ownCaptureTests,
  ownCaptureWork,
  type ReferencePhaseEvent,
  referenceTelemetry,
} from "./capture-test-scope.js";
import {
  consumeTransferredForkFixture,
  runTransferredForkFixture,
} from "./reference-fork-fixture.js";

const seam = vi.hoisted(() => ({
  work: undefined as CaptureWork | undefined,
  forkWorks: new Map<CaptureProject, CaptureWork>(),
  physicalReads: 0,
  measureReads: false,
  afterRead: undefined as ((file: unknown) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read;
      Object.defineProperty(handle, "read", {
        value: async (...input: unknown[]) => {
          const result: unknown = await Reflect.apply(read, handle, input);
          await seam.afterRead?.(args[0]);
          if (
            seam.measureReads &&
            result &&
            typeof result === "object" &&
            "bytesRead" in result &&
            typeof result.bytesRead === "number"
          )
            seam.physicalReads += result.bytesRead;
          return result;
        },
      });
      return handle;
    },
  };
});
vi.mock("@design-studio/project-host", async (original) => ({
  ...(await original<typeof import("@design-studio/project-host")>()),
  acquireCaptureWork: (project: CaptureProject) => {
    const fork = seam.forkWorks.get(project);
    if (fork) return fork;
    if (!seam.work) throw new Error("No synthetic owner");
    return seam.work;
  },
}));
vi.mock("../../project-host/dist/capture-work.js", () => ({
  assertCaptureWork: (work: CaptureWork) => {
    if (work !== seam.work && ![...seam.forkWorks.values()].includes(work))
      throw new Error("Synthetic owner changed");
  },
}));
const cleanups: (() => Promise<void>)[] = [];
const runnerSignals = new WeakMap<AsyncTestScope, AbortSignal>();
const observations = new WeakMap<AsyncTestScope, TestObservation>();
const diagnosticTelemetry = new WeakMap<
  AsyncTestScope,
  ReturnType<typeof referenceTelemetry>
>();
const it = ownCaptureTests(vitestIt);
vi.setConfig({ testTimeout: 60000 });
aroundEach((run, context) => {
  if (cleanups.length)
    throw new Error("Previous reference fixture has not quiesced.");
  const scope = new AsyncTestScope(context.signal);
  observations.set(
    scope,
    observeSelectedTest(context.task.name, context.signal),
  );
  runnerSignals.set(scope, context.signal);
  if (
    context.task.name.startsWith(
      "read-only conversion diagnostics preserve denial and read ownership:",
    )
  ) {
    const telemetry = referenceTelemetry("closed-diagnostic", context.signal);
    telemetry.arm();
    diagnosticTelemetry.set(scope, telemetry);
  }
  return inCaptureTest(scope, run);
});
afterEach(async () => {
  const observed = observations.get(captureTestScope());
  let settled = false;
  try {
    observed?.phase("scope-join");
    await captureTestScope().close();
    const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
        cleanups.splice(cleanups.indexOf(cleanup), 1);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Reference fixture cleanup did not settle.",
      );
    observed?.phase("mock-reset");
    vi.restoreAllMocks();
    seam.work = undefined;
    seam.forkWorks.clear();
    seam.measureReads = false;
    seam.physicalReads = 0;
    seam.afterRead = undefined;
    diagnosticTelemetry.get(captureTestScope())?.close();
    settled = true;
  } finally {
    if (settled) observed?.closed();
    else observed?.unresolved();
  }
});
const origin = "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
const nativeRetainedMode =
  process.env.DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE === "1";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic evidence");
  return value;
}
function fixture(...args: Parameters<typeof createFixture>) {
  return ownCaptureWork(createFixture)(...args);
}
async function createFixture(
  options: {
    large?: boolean;
    nodeBytes?: number;
    url?: string;
    dimensions?: number;
    frameSize?: number;
    durabilityReads?: boolean;
    nodeVersion?: string;
    renderNode?: string;
    diagnostic?: boolean;
    fixedClock?: boolean;
    offline?: boolean;
    longDatabase?: boolean;
    telemetry?: "conversion-provenance" | "converted-archive";
  } = {},
) {
  const scope = captureTestScope();
  scope.signal.throwIfAborted();
  const telemetry =
    diagnosticTelemetry.get(scope) ??
    referenceTelemetry(options.telemetry, runnerSignals.get(scope));
  const observed = observations.get(scope);
  const measure = <T>(phase: string, action: () => Promise<T>) => {
    observed?.phase(
      phase === "fixture-open"
        ? "fixture-open"
        : phase === "capture"
          ? "capture"
          : phase === "cleanup"
            ? "cleanup"
            : "reference-operation",
    );
    return telemetry.measure(phase, action);
  };
  const stores: LocalStore[] = [];
  const backupReaders = new Set<{ close(): void }>();
  const fileSystems: ProjectFileSystem[] = [];
  let queueSequence = 0;
  const observedQueues = new WeakSet<Promise<unknown>>();
  observed?.counters(() => {
    const pending: unknown = Reflect.get(scope, "pending");
    let activeValid = true,
      queueValid = true;
    const activeStoreOperations = stores.reduce((sum, store) => {
      const queue: unknown = Reflect.get(store, "queue");
      if (queue instanceof Promise && !observedQueues.has(queue)) {
        observedQueues.add(queue);
        queueSequence++;
      }
      if (!(queue instanceof Promise)) queueValid = false;
      const active: unknown = Reflect.get(store, "active");
      if (typeof active !== "number") activeValid = false;
      return sum + (typeof active === "number" ? active : 0);
    }, 0);
    return {
      pendingBodies: pending instanceof Set ? pending.size : null,
      stores: stores.length,
      queueSequence: queueValid ? queueSequence : null,
      activeStoreOperations: activeValid ? activeStoreOperations : null,
    };
  });
  const runtimes: NativeCaptureRuntime[] = [];
  const validations: Awaited<
    ReturnType<typeof openNativeReferenceValidation>
  >[] = [];
  const offlines: Awaited<ReturnType<typeof openNativeReferenceOffline>>[] = [];
  const nativeMode = nativeRetainedMode;
  const native = nativeMode ? await loadNative() : undefined;
  const sid = native?.principal();
  const retainedPins = new Set<ReadLease>();
  const portablePins = new Set<PortablePinOwner>();
  let nativeAdmissions = 0;
  let strictDenials = 0;
  initializeImmutableSqlite(
    path.resolve(
      ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
    ),
  );
  let rootPrefix = nativeMode ? "ds-ph-reference-" : "reference-synthetic-";
  if (options.longDatabase) {
    if (!nativeMode || !options.offline)
      throw new Error("Long database fixture requires native offline mode.");
    const padding = 224 - path.join(tmpdir(), rootPrefix).length - 6;
    if (padding < 0)
      throw new Error("Synthetic temp root exceeds the admitted DB bound.");
    rootPrefix += "d".repeat(padding);
  }
  observed?.phase("root-open");
  const root = await mkdtemp(path.join(tmpdir(), rootPrefix));
  let ownerFixture:
    | Awaited<ReturnType<typeof createRetainedOwnerFixture>>
    | undefined;
  cleanups.push(() =>
    measure("cleanup", async () => {
      observed?.phase("scope-join");
      await scope.close();
      observed?.phase("queue-join");
      await joinSettledStores(stores);
      observed?.phase("runtime-close");
      const errors: unknown[] = [];
      for (const current of [
        ...offlines,
        ...validations,
        ...runtimes,
      ].reverse()) {
        try {
          await current.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Reference runtime ownership did not close.",
        );
      observed?.phase("store-close");
      await closeSettledStores(stores);
      for (const reader of backupReaders) {
        try {
          reader.close();
          backupReaders.delete(reader);
        } catch (error) {
          errors.push(error);
        }
      }
      observed?.phase("filesystem-close");
      for (const files of fileSystems) {
        try {
          await files.closePreservingStages();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Reference filesystem ownership did not close.",
        );
      expect(retainedPins.size).toBe(0);
      expect(backupReaders.size).toBe(0);
      closePortablePins(portablePins);
      expect(portablePins.size).toBe(0);
      ownerFixture?.close();
      observed?.phase("root-delete");
      await rm(root, { recursive: true, force: true });
      telemetry.close();
    }),
  );
  telemetry.arm();
  ownerFixture = nativeMode
    ? await createRetainedOwnerFixture(root)
    : undefined;
  await ownerFixture?.declareTree("artifacts");
  await ownerFixture?.declareTree("outputs");
  let ownerPreparation:
    | { entries: number; naturalOwnerDenials: number; normalized: number }
    | undefined;
  for (const name of ["artifacts", "outputs"]) {
    if (native && sid) native.createDirectory(path.join(root, name), sid);
    else await mkdir(path.join(root, name));
  }
  if (native && sid && options.offline) {
    native.createDirectory(path.join(root, "db"), sid);
    native.createFile(
      path.join(root, "db", "state.sqlite"),
      sid,
      Buffer.alloc(0),
    );
  }
  const project = {
    projectId: "project_synthetic",
    artifactRootId: "artifacts_synthetic",
    paths: {
      database: path.join(
        root,
        ...(native && options.offline ? ["db"] : []),
        "state.sqlite",
      ),
      artifacts: path.join(root, "artifacts"),
      outputs: path.join(root, "outputs"),
      inputs: root,
      temp: root,
    },
    principal: { actorId: "actor_synthetic" },
    reference: {
      id: "credential_synthetic",
      providerId: "figma_rest",
      store: "windows-credential-manager",
    },
    recheck: async () => {},
    close: async () => {},
  } as CaptureProject;
  let runtime: NativeCaptureRuntime;
  let validation:
    | Awaited<ReturnType<typeof openNativeReferenceValidation>>
    | undefined;
  let validationMode = false;
  let offlineMode = false;
  let conversionInspectionMode = false;
  let offline:
    | Awaited<ReturnType<typeof openNativeReferenceOffline>>
    | undefined;
  let failInventoryPinClose = false;
  let firstInventoryRoot = true;
  let admitted = true;
  let vaultAllowed = true;
  let fault: string | undefined;
  const faultHits: string[] = [];
  let clockOffset = 0;
  const fixedNow = options.fixedClock ? Date.now() : undefined;
  let diagnosticPolicy = CAPTURE_DIAGNOSTIC_POLICY_SHA256;
  const vault = vi.fn();
  const ready = vi.fn(async () => undefined);
  const reads: { bytes: number; allowed: boolean }[] = [];
  const ledger: { phase: string; bytes: number }[] = [];
  const backupPublications: {
    pendingUnits: number;
    finalUnits: number;
    byteLength: number;
    sha256: string;
  }[] = [];
  if (options.offline) {
    const reserve = ReferenceInput.prototype.reserveRead;
    vi.spyOn(ReferenceInput.prototype, "reserveRead").mockImplementation(
      function (this: ReferenceInput, bytes) {
        ledger.push({ phase: this.phase, bytes });
        reserve.call(this, bytes);
      },
    );
  }
  const create = ProjectFileSystem.create.bind(ProjectFileSystem);
  vi.spyOn(ProjectFileSystem, "create").mockImplementation(async (o) => {
    const files = await create({
      ...o,
      publicationProfile: nativeMode
        ? WINDOWS_PUBLICATION_PROFILE
        : "portable-atomic",
      reserveRead: (bytes, context) => {
        const event: (typeof reads)[number] = { bytes, allowed: false };
        reads.push(event);
        o.reserveRead?.(bytes, context);
        event.allowed = true;
      },
    });
    fileSystems.push(files);
    return files;
  });
  const nativeDurability = ProjectFileSystem.prototype.ensurePublicationDurable;
  vi.spyOn(
    ProjectFileSystem.prototype,
    "ensurePublicationDurable",
  ).mockImplementation(async function (
    this: ProjectFileSystem,
    root,
    artifacts,
    context,
  ) {
    if (nativeMode && options.offline && offlineMode)
      return nativeDurability.call(this, root, artifacts, context);
    // Portable synthetic publication still exercises the native barrier's body reread.
    if (options.durabilityReads)
      for (const artifact of artifacts) {
        const result = await this.read(
          { artifactRootId: root, path: artifact.path },
          context,
        );
        if (result.status !== "complete")
          throw new HostBoundaryError(
            result.error.code,
            "Synthetic durability body read failed.",
          );
        expect(hashBytes(result.value)).toBe(artifact.sha256);
        result.value.fill(0);
      }
    return fakeComplete(context, { durable: true });
  });
  const openStore = LocalStore.open.bind(LocalStore);
  let currentStore: LocalStore | undefined;
  vi.spyOn(LocalStore, "open").mockImplementation(async (o) => {
    observed?.phase("store-open");
    currentStore = await openStore({
      ...o,
      fault: (point) => {
        if (point === fault) {
          faultHits.push(point);
          if (
            nativeRetainedMode &&
            options.offline &&
            process.env.DESIGN_STUDIO_SYNTHETIC_OFFLINE_CRASH === point
          ) {
            if (!isMainThread)
              throw new Error(
                "Crash fixture requires an owned forked process, not a worker thread.",
              );
            writeFileSync(
              path.join(root, "offline-crash-witness.json"),
              JSON.stringify({
                point,
                pid: process.pid,
                parentPid: process.ppid,
                execution: "forked-process",
              }),
              { flag: "wx" },
            );
            process.kill(process.pid, "SIGKILL");
            throw new Error(
              "Synthetic crash termination did not stop execution.",
            );
          }
          throw new Error("Synthetic publication fault");
        }
      },
    });
    stores.push(currentStore);
    observed?.phase("fixture-open");
    return currentStore;
  });
  const originalProject = project;
  const open = async (selectedProject: CaptureProject = originalProject) => {
    scope.signal.throwIfAborted();
    const project = selectedProject;
    let current = true;
    let policy: ReturnType<typeof nativeCapturePolicy>;
    const work: CaptureWork = {
      project,
      actorId: project.principal.actorId,
      permissionScope: "synthetic",
      sqliteBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      policyId: "figma-capture-v1",
      policySha256: CAPTURE_POLICY_SHA256,
      imageOrigins: [],
      apiOrigins: ["https://api.figma.com"],
      get policy() {
        return policy;
      },
      current: async () => {
        if (!current)
          throw new HostBoundaryError("FORBIDDEN", "Closed synthetic owner");
      },
      isCurrent: () => current,
      ...(options.diagnostic
        ? {
            referenceValidationAuthority: async () => {
              if (!admitted)
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic validation revoked.",
                );
              return REFERENCE_VALIDATION_POLICY_SHA256;
            },
            pinReferenceValidationDatabase: () =>
              syntheticImmutableSnapshot(project.paths.database),
            referenceOfflineAuthority: async () => {
              if (!admitted || !current)
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic offline authority revoked.",
                );
              return REFERENCE_OFFLINE_POLICY_SHA256;
            },
            referenceConversionInspectionAuthority: async () => {
              await work.current();
              if (!admitted)
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic readonly authority revoked.",
                );
              return REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256;
            },
            pinReferenceConversionInspectionDatabase: async () => {
              if (!work.pinReferenceOfflineDatabase)
                throw new Error("Missing synthetic pin.");
              return work.pinReferenceOfflineDatabase();
            },
            pinReferenceOfflineDatabase: async () => {
              if (native && sid && options.offline)
                return pinImmutableReferenceDatabase({
                  filename: project.paths.database,
                  sid,
                  retainedPins,
                  authoritySha256: REFERENCE_OFFLINE_POLICY_SHA256,
                  authorize: async () => {
                    if (!admitted || !current)
                      throw new HostBoundaryError(
                        "FORBIDDEN",
                        "Native synthetic authority changed.",
                      );
                  },
                });
              const pin = await syntheticImmutableSnapshot(
                project.paths.database,
              );
              const before = await lstat(project.paths.database);
              let closed = false;
              return {
                ...pin,
                close: () => {
                  pin.close();
                  closed = true;
                },
                checkReleased: async () => {
                  expect(closed).toBe(true);
                  expect(portablePins.size).toBe(0);
                  const after = await lstat(project.paths.database);
                  expect([
                    after.dev,
                    after.ino,
                    after.size,
                    after.mtimeMs,
                  ]).toEqual([
                    before.dev,
                    before.ino,
                    before.size,
                    before.mtimeMs,
                  ]);
                },
              };
            },
            prepareReferenceBackup: async (filename: string) => {
              expect(filename.startsWith("\\\\?\\")).toBe(false);
              expect(
                filename.startsWith(`${project.paths.database}.migration-v4-`),
              ).toBe(true);
              if (native && sid && options.offline)
                native.createFile(filename, sid, Buffer.alloc(0));
              else await writeFile(filename, new Uint8Array(), { flag: "wx" });
            },
            pinReferenceBackup: async (filename) => {
              expect(filename.startsWith("\\\\?\\")).toBe(false);
              return native && sid && options.offline
                ? pinReferenceBackupFile(filename, {
                    owner: work,
                    sid,
                    retainedPins,
                    current: work.current,
                  })
                : syntheticBackupPin(filename);
            },
            publishReferenceBackup: async (
              source: string,
              destination: string,
              context: import("@design-studio/contracts").OperationContext,
              proof,
            ) => {
              expect(source.startsWith("\\\\?\\")).toBe(false);
              expect(destination.startsWith("\\\\?\\")).toBe(false);
              expect(source).toBe(`${destination}.pending`);
              if (native && sid && options.offline) {
                const published = await publishReferenceBackupFile({
                  source,
                  destination,
                  proof,
                  context,
                  scope: {
                    owner: work,
                    sid,
                    retainedPins,
                    current: work.current,
                  },
                  authority: policy.verify,
                });
                expect(published.sha256).toBe(proof.sha256);
                expect(published.byteLength).toBe(proof.byteLength);
                backupPublications.push({
                  pendingUnits: source.length,
                  finalUnits: destination.length,
                  byteLength: published.byteLength,
                  sha256: published.sha256,
                });
                return published;
              }
              await proof.check();
              proof.close();
              await rename(source, destination);
              return syntheticBackupPin(destination);
            },
            pinReferenceValidationEntry: async (
              rootId: string,
              relative: string,
              directory: boolean,
            ) => {
              const rootPath =
                rootId === project.artifactRootId
                  ? project.paths.artifacts
                  : project.paths.outputs;
              if (native && sid) {
                if (
                  rootId !== project.artifactRootId &&
                  rootId !== `outputs_${project.projectId}`
                )
                  throw new Error(
                    "Synthetic native root is outside the fixture.",
                  );
                if (relative !== "") {
                  expect(() =>
                    native.pinRead(
                      path.join(rootPath, ...relative.split("/")),
                      directory,
                      sid,
                    ),
                  ).toThrow(/protected/);
                  strictDenials++;
                }
                const pin = await pinRetainedReferenceEntry({
                  root: rootPath,
                  relative,
                  directory,
                  sid,
                  retainedPins,
                  authorize: async () => {
                    if (!current || !admitted)
                      throw new HostBoundaryError(
                        "FORBIDDEN",
                        "Synthetic native authority revoked.",
                      );
                    const strictRoot = native.inspect(rootPath, true, sid);
                    strictRoot.close();
                  },
                });
                nativeAdmissions++;
                return pin;
              }
              const filename = path.join(rootPath, ...relative.split("/"));
              const pin = portableRetainedPin(
                filename,
                directory,
                portablePins,
              );
              const inventoryRoot = relative === "" && firstInventoryRoot;
              if (inventoryRoot) firstInventoryRoot = false;
              return {
                ...pin,
                close: () => {
                  if (failInventoryPinClose && inventoryRoot) {
                    failInventoryPinClose = false;
                    throw new HostBoundaryError(
                      "INTERRUPTED",
                      "Synthetic pin close failed",
                    );
                  }
                  pin.close();
                },
              };
            },
            diagnosticAuthority: async () => {
              if (!admitted)
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic diagnostic authority revoked.",
                );
              return diagnosticPolicy;
            },
          }
        : {}),
      readyCredential: ready,
      recoveryAuthority: async () => {
        throw new Error("Reference must not read recovery/credential state");
      },
      referenceAuthority: async () => {
        if (!admitted)
          throw new HostBoundaryError("FORBIDDEN", "Old synthetic lease");
        return CAPTURE_REFERENCE_POLICY_SHA256;
      },
      attestDatabase: async () => {},
      credentials: () => ({
        use: async (_ref, context, consume) => {
          vault();
          if (!vaultAllowed)
            throw new Error("Reference must not read credentials");
          return fakeComplete(
            context,
            await consume(Buffer.from("synthetic-pat")),
          );
        },
      }),
      close: () => {
        current = false;
      },
    };
    seam.work = work;
    policy = nativeCapturePolicy(work);
    const originalNow = policy.clock.now.bind(policy.clock);
    vi.spyOn(policy.clock, "now").mockImplementation(
      () => (fixedNow ?? originalNow()) + clockOffset,
    );
    if (offlineMode) {
      const current = conversionInspectionMode
        ? await openNativeReferenceConversionInspection(project)
        : await openNativeReferenceOffline(project);
      offlines.push(current);
      offline = {
        ...current,
        execute: ownCaptureWork((input, signal) =>
          measure(input.operation, () =>
            current.execute(input, AbortSignal.any([signal, scope.signal])),
          ),
        ),
      };
    } else if (validationMode) {
      const current = await openNativeReferenceValidation(project);
      validations.push(current);
      validation = {
        ...current,
        execute: ownCaptureWork((input, signal) =>
          current.execute(input, AbortSignal.any([signal, scope.signal])),
        ),
      };
    } else {
      const current = await assembleNativeCapture(project);
      runtimes.push(current);
      runtime = {
        execute: ownCaptureWork((input, signal) =>
          measure(input.operation, () =>
            current.execute(input, AbortSignal.any([signal, scope.signal])),
          ),
        ),
        recover: ownCaptureWork((input, signal) =>
          current.recover(input, AbortSignal.any([signal, scope.signal])),
        ),
        ...(current.reference
          ? {
              reference: ownCaptureWork((input, signal) =>
                measure(input.operation, () =>
                  required(current.reference).call(
                    current,
                    input,
                    AbortSignal.any([signal, scope.signal]),
                  ),
                ),
              ),
            }
          : {}),
        close: current.close.bind(current),
      };
    }
    return runtime;
  };
  const api = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockImplementation(async (operation, _v, _secret, budget) => {
      const value =
        operation === "metadata"
          ? { file: { version: "v1" } }
          : operation === "nodes"
            ? {
                version: options.nodeVersion ?? "v1",
                nodes: {
                  "1:2": {
                    document: {
                      id: "1:2",
                      type: "FRAME",
                      children: [],
                      absoluteBoundingBox: {
                        x: 10,
                        y: 20,
                        width: options.frameSize ?? 2,
                        height: options.frameSize ?? 2,
                      },
                      ...(options.large || options.nodeBytes
                        ? {
                            description: "x".repeat(
                              options.nodeBytes ?? 300000,
                            ),
                          }
                        : {}),
                    },
                  },
                },
              }
            : {
                images: {
                  [options.renderNode ?? "1:2"]:
                    options.url ??
                    `${origin}/synthetic.png?private=synthetic-only`,
                },
              };
      const bytes = Buffer.from(JSON.stringify(value));
      budget.decoded(bytes.length);
      return { status: 200, mediaType: "application/json", bytes };
    });
  const image = vi
    .spyOn(FigmaHttpsTransport.prototype, "image")
    .mockImplementation(async (_url, budget) => {
      budget.check();
      budget.dnsQuery();
      const bytes = png(true, options.dimensions ?? 2, 2);
      budget.receive(bytes.length);
      budget.decoded(bytes.length);
      return { status: 200, mediaType: "image/png", bytes };
    });
  const initial = await measure("fixture-open", () => open());
  if (nativeMode && options.offline) {
    const stage = ProjectFileSystem.prototype.stage;
    vi.spyOn(ProjectFileSystem.prototype, "stage").mockImplementation(
      async function (this: ProjectFileSystem, ...args) {
        const result = await stage.apply(this, args);
        if (offlineMode) await ownerFixture?.prepare();
        return result;
      },
    );
  }
  const capture = await initial.execute(
    {
      operation: "capture",
      requestId: "original",
      url: "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
    },
    new AbortController().signal,
  );
  expect(capture.status, JSON.stringify(capture)).toBe("partial");
  expect(capture.value?.capture?.referenceStatus).toBe("unavailable");
  expect(image).not.toHaveBeenCalled();
  vaultAllowed = false;
  api.mockClear();
  vault.mockClear();
  ready.mockClear();
  reads.length = 0;
  ledger.length = 0;
  seam.physicalReads = 0;
  seam.measureReads = true;
  const run = (
    input: Parameters<NonNullable<NativeCaptureRuntime["reference"]>>[0],
    signal = new AbortController().signal,
  ) => required(runtime.reference).call(runtime, input, signal);
  const plan = () =>
    run({ operation: "reference-plan", requestId: "original" });
  const approve = async () => {
    const proposal = await plan();
    expect(proposal.status, JSON.stringify(proposal)).toBe("complete");
    const result = await run({
      operation: "reference-approve",
      requestId: "original",
      origin,
      expectedProof: required(proposal.value?.proposal?.proofSha256),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    });
    expect(result.status, JSON.stringify(result)).toBe("complete");
    return result;
  };
  const download = (approval: NativeReferenceEnvelope, signal?: AbortSignal) =>
    run(
      {
        operation: "reference-download",
        requestId: "original",
        expectedApproval: required(approval.value?.approval?.sha256),
        confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
      },
      signal,
    );
  const diagnosticPlan = () =>
    run({ operation: "reference-diagnostic-plan", requestId: "original" });
  const diagnosticApprove = async () => {
    const plan = await diagnosticPlan();
    expect(plan.status, JSON.stringify(plan)).toBe("complete");
    const approved = await run({
      operation: "reference-diagnostic-approve",
      requestId: "original",
      origin,
      expectedProof: required(plan.value?.proposal?.proofSha256),
      confirmation: DIAGNOSTIC_APPROVAL_CONFIRMATION,
    });
    expect(approved.status, JSON.stringify(approved)).toBe("complete");
    return approved;
  };
  const diagnosticDownload = (approval: NativeReferenceEnvelope) =>
    run({
      operation: "reference-diagnostic-download",
      requestId: "original",
      expectedApproval: required(approval.value?.approval?.sha256),
      confirmation: DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
    });
  const blobs = async () => {
    const dir = path.join(root, "artifacts", "blobs");
    return Promise.all(
      (await readdir(dir))
        .sort()
        .map(
          async (name) => [name, await readFile(path.join(dir, name))] as const,
        ),
    );
  };
  const openValidation = async () => {
    await runtime.close();
    await validation?.close();
    if (ownerFixture && sid) {
      const natural = await ownerFixture.inspect();
      let naturalOwnerDenials = 0;
      for (const entry of natural) {
        if (entry.owner === sid) continue;
        const [tree, ...parts] = entry.relative.split("/");
        if (tree !== "artifacts" && tree !== "outputs")
          throw new Error("Synthetic owner fixture escaped declared trees.");
        await expect(
          pinRetainedReferenceEntry({
            root: project.paths[tree],
            relative: parts.join("/"),
            directory: entry.directory,
            sid,
            retainedPins,
            authorize: async () => {},
          }),
        ).rejects.toThrow(/owner/);
        naturalOwnerDenials++;
      }
      expect(retainedPins.size).toBe(0);
      const prepared = await ownerFixture.prepare();
      expect(prepared).toEqual(natural);
      ownerPreparation = {
        entries: natural.length,
        naturalOwnerDenials,
        normalized: natural.filter((entry) => entry.owner !== sid).length,
      };
    }
    validationMode = true;
    firstInventoryRoot = true;
    await open();
    reads.length = 0;
    ledger.length = 0;
    seam.physicalReads = 0;
    return required(validation);
  };
  return {
    project,
    openValidation,
    runOffline: async (
      command: NativeReferenceOfflineInput,
      signal = new AbortController().signal,
    ) => {
      await runtime.close();
      await validation?.close();
      await offline?.close();
      if (ownerFixture) await ownerFixture.prepare();
      offlineMode = true;
      conversionInspectionMode =
        command.operation === "reference-conversion-inspect";
      firstInventoryRoot = true;
      await open();
      reads.length = 0;
      ledger.length = 0;
      seam.physicalReads = 0;
      return required(offline).execute(command, signal);
    },
    observeOffline: () =>
      measure("verification", async () => {
        await runtime.close();
        await validation?.close();
        await offline?.close();
        return observeSyntheticReference(root, project.paths.database);
      }),
    observeDatabasePreimage: (migrationBackup = false) =>
      ownCaptureWork(() =>
        observeSyntheticDatabasePreimage(
          root,
          project.paths.database,
          backupReaders,
          migrationBackup,
        ),
      )(),
    backupPublications,
    backupOffline: ownCaptureWork(() =>
      measure("backup-archive", () =>
        backupSyntheticOffline(root, project.paths.database, scope.signal),
      ),
    ),
    runArchivedOffline: async (command: NativeReferenceOfflineInput) => {
      await offline?.close();
      offlineMode = true;
      conversionInspectionMode =
        command.operation === "reference-conversion-inspect";
      await open({
        ...project,
        paths: {
          ...project.paths,
          database: path.join(root, "restored.sqlite"),
          artifacts: path.join(root, "restored"),
        },
      });
      return required(offline).execute(command, new AbortController().signal);
    },
    get ledger() {
      return ledger;
    },
    failInventoryClose: () => {
      failInventoryPinClose = true;
    },
    get readPins() {
      return nativeMode ? retainedPins.size : portablePins.size;
    },
    get nativeAdmissions() {
      return nativeAdmissions;
    },
    get strictDenials() {
      return strictDenials;
    },
    get ownerPreparation() {
      return ownerPreparation;
    },
    validateRetained: async (
      expectedJob: string,
      signal = new AbortController().signal,
    ) => {
      const current = await openValidation();
      try {
        return await current.execute(
          {
            operation: "reference-recovery-plan",
            requestId: "original",
            expectedJob,
          },
          signal,
        );
      } finally {
        await validation?.close();
      }
    },
    plan,
    approve,
    download,
    diagnosticPlan,
    diagnosticApprove,
    diagnosticDownload,
    changeDiagnosticPolicy: () => {
      diagnosticPolicy = "d".repeat(64);
    },
    corruptReferenceRead: (kind: "receipt" | "unknown" | "reserved") => {
      const jobs = required(currentStore).jobs;
      const get = jobs.get.bind(jobs);
      vi.spyOn(jobs, "get").mockImplementation(async (jobId, context) => {
        const result = await get(jobId, context);
        if (
          result.status === "complete" &&
          result.value.handlerId === "figma-reference-download-v1"
        ) {
          if (kind === "receipt" && result.value.job.receipt)
            result.value.job.receipt.id = "wrong_receipt";
          else if (result.value.effects[0])
            result.value.effects[0].state =
              kind === "unknown" ? "unknown" : "reserved";
        }
        return result;
      });
    },
    retainSyntheticStage: async () => {
      const ctx = await required(seam.work).policy.issue({
        jobId: "synthetic_pending",
        requestId: "synthetic_pending",
        signal: new AbortController().signal,
      });
      expect(
        (
          await required(currentStore).stage(
            Buffer.from("synthetic uncommitted publication"),
            ctx,
          )
        ).status,
      ).toBe("complete");
    },
    seedCooldown: async (predecessor: NativeReferenceEnvelope) => {
      const work = required(seam.work);
      const db = required(currentStore);
      const jobId = required(predecessor.value?.job?.id);
      const ctx = await work.policy.issue({
        jobId: "synthetic_cooldown",
        requestId: "synthetic_cooldown",
        jobReads: [jobId],
        signal: new AbortController().signal,
      });
      const evidence = {
        ...required(predecessor.value?.evidence),
        statusCode: 429,
        errorCode: "RATE_LIMITED",
        nextEligibleAt: new Date(work.policy.clock.now() + 60000).toISOString(),
        retry: "explicit-action-required",
      };
      const staged = await db.stage(canonicalBytes(evidence), ctx);
      if (staged.status !== "complete")
        throw new Error("Synthetic cooldown stage failed");
      const receipt = await db.commit([staged.value], ctx);
      if (receipt.status !== "complete")
        throw new Error("Synthetic cooldown receipt failed");
      const history = await db.jobs.discoverOwned({ jobId, limit: 1 }, ctx);
      if (history.status !== "complete")
        throw new Error("Synthetic history unavailable");
      const descriptor = required(history.value.descriptors[0]);
      const discover = db.jobs.discoverOwned.bind(db.jobs);
      // Only discovery is synthetic; the cooldown artifact/receipt and physical reads use SQLite.
      vi.spyOn(db.jobs, "discoverOwned").mockImplementation(
        async (query, context) => {
          const result = await discover(query, context);
          if (!query.jobId && result.status === "complete")
            result.value.descriptors.push({
              ...descriptor,
              jobId: "synthetic_cooldown",
              outputs: receipt.value.outputs,
            });
          return result;
        },
      );
    },
    run,
    image,
    api,
    vault,
    ready,
    reads,
    get runtime() {
      return runtime;
    },
    blobs,
    faultHits,
    observeDiagnosticCommit: (expireLease = false) => {
      const db = required(currentStore);
      const commit = db.jobs.commitJob.bind(db.jobs);
      const observed: {
        staged: StagedArtifact;
        filename: string;
        dev: number;
        ino: number;
      }[] = [];
      const spy = vi
        .spyOn(db.jobs, "commitJob")
        .mockImplementationOnce(async (...args) => {
          for (const staged of args[2].outputs) {
            const names = (await readdir(project.paths.artifacts)).filter(
              (name) => name.startsWith(".host-"),
            );
            const matches: string[] = [];
            for (const name of names) {
              if (
                (
                  await readdir(path.join(project.paths.artifacts, name))
                ).includes(staged.stagingId)
              )
                matches.push(
                  path.join(project.paths.artifacts, name, staged.stagingId),
                );
            }
            expect(matches).toHaveLength(1);
            const filename = required(matches[0]);
            const stat = await lstat(filename);
            expect(stat.nlink).toBe(1);
            observed.push({ staged, filename, dev: stat.dev, ino: stat.ino });
          }
          if (expireLease) clockOffset += 5001;
          return commit(...args);
        });
      return {
        spy,
        observed,
        async physical() {
          return Promise.all(
            observed.map(async ({ staged, filename, dev, ino }) => {
              const stageExists = (
                await readdir(path.dirname(filename))
              ).includes(path.basename(filename));
              const target = path.join(
                project.paths.artifacts,
                ...staged.artifact.path.split("/"),
              );
              const blobExists = (await readdir(path.dirname(target))).includes(
                path.basename(target),
              );
              const actual = blobExists ? target : filename;
              const stat = await lstat(actual);
              const bytes = await readFile(actual);
              expect(hashBytes(bytes)).toBe(staged.artifact.sha256);
              expect(bytes.length).toBe(staged.artifact.byteLength);
              expect([stat.dev, stat.ino, stat.nlink]).toEqual([dev, ino, 1]);
              return {
                stageExists,
                blobExists,
                sha256: staged.artifact.sha256,
              };
            }),
          );
        },
      };
    },
    advanceClock: (milliseconds: number) => {
      clockOffset += milliseconds;
    },
    corruptNodes: async (
      kind:
        | "truncate"
        | "grow"
        | "replace"
        | "hardlink"
        | "swap"
        | "replace-after-proof"
        | "junction" = "truncate",
    ) => {
      const artifact = required(
        capture.value?.artifacts.find((a) => a.role === "nodes"),
      ).artifact;
      const target = path.join(root, "artifacts", "blobs", artifact.sha256);
      if (kind === "hardlink") {
        await link(target, path.join(root, "extra-link"));
      } else if (kind === "replace-after-proof") {
        const bytes = await readFile(target);
        await rename(target, path.join(root, "old-node"));
        await writeFile(target, bytes);
      } else if (kind === "swap") {
        seam.afterRead = async (file) => {
          if (file !== target) return;
          seam.afterRead = undefined;
          const bytes = await readFile(target);
          await rename(target, path.join(root, "old-node"));
          await writeFile(target, bytes);
        };
      } else if (kind === "junction") {
        const previous = path.join(root, "old-blobs");
        await rename(path.dirname(target), previous);
        await symlink(previous, path.dirname(target), "junction");
      } else {
        const original = await readFile(target);
        await writeFile(
          target,
          kind === "grow"
            ? Buffer.concat([original, Buffer.of(0)])
            : kind === "replace"
              ? Buffer.alloc(original.length, 120)
              : Buffer.from("tampered synthetic nodes"),
        );
      }
    },
    deny: () => {
      admitted = false;
    },
    setFault: (value?: string) => {
      fault = value;
    },
    reopen: async () => {
      await validation?.close();
      await offline?.close();
      await runtime.close();
      validationMode = false;
      offlineMode = false;
      await open();
    },
  };
}
it("reports original runner abort during the gated phase before cleanup", async () => {
  const original = new AbortController();
  const events: ReferencePhaseEvent[] = [];
  const telemetry = referenceTelemetry(
    "conversion-provenance",
    original.signal,
    (event) => {
      events.push(event);
    },
  );
  const gate = deferred<void>();
  telemetry.arm();
  telemetry.arm();
  let settled = false;
  const work = telemetry.measure("convert-reference", async () => {
    await gate.promise;
    settled = true;
    return { status: "cancelled" };
  });
  try {
    original.abort();
    expect(settled).toBe(false);
    expect(events.filter((e) => e.event === "runner-abort")).toMatchObject([
      { phase: "convert-reference", runnerAborted: true },
    ]);
    expect(events.some((e) => e.phase === "cleanup")).toBe(false);
    original.signal.dispatchEvent(new Event("abort"));
    expect(events.filter((e) => e.event === "runner-abort")).toHaveLength(1);
  } finally {
    gate.resolve();
    await work;
    telemetry.close();
  }
  expect(events.at(-1)).toMatchObject({
    event: "settled",
    phase: "convert-reference",
    outcome: "cancelled",
  });
});

it("detaches telemetry on confirmed cleanup and handles pre-aborted owners once", async () => {
  const original = new AbortController();
  const events: ReferencePhaseEvent[] = [];
  const telemetry = referenceTelemetry(
    "converted-archive",
    original.signal,
    (event) => {
      events.push(event);
    },
  );
  telemetry.arm();
  await telemetry.measure("cleanup", async () => {
    telemetry.close();
  });
  const count = events.length;
  original.abort();
  expect(events).toHaveLength(count);
  expect(events.some((e) => e.event === "runner-abort")).toBe(false);
  const already = referenceTelemetry(
    "converted-archive",
    original.signal,
    (event) => {
      events.push(event);
    },
  );
  already.arm();
  already.arm();
  already.close();
  expect(events.filter((e) => e.event === "runner-abort")).toMatchObject([
    { phase: null, runnerAborted: true },
  ]);
});

it("retains handed-off fixture reads until original body abort joins before cleanup", async () => {
  const runner = new AbortController();
  const scope = new AsyncTestScope(runner.signal);
  const f = await inCaptureTest(scope, () => fixture({ diagnostic: true }));
  const cleanup = required(cleanups.at(-1));
  const gate = deferred<void>();
  const entered = deferred<void>();
  captureTestScope().releaseOnEnd(() => gate.resolve());
  let settled = false;
  let cleaned = false;
  seam.afterRead = async () => {
    seam.afterRead = undefined;
    entered.resolve();
    await gate.promise;
  };
  const work = inCaptureTest(scope, () =>
    f.run({ operation: "reference-plan", requestId: "original" }, scope.signal),
  ).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const close = LocalStore.prototype.close;
  const closeOrder: boolean[] = [];
  const closed = vi
    .spyOn(LocalStore.prototype, "close")
    .mockImplementation(function (this: LocalStore) {
      closeOrder.push(settled);
      return close.call(this);
    });
  let closing: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      work.then(() => {
        throw new Error("Body did not enter gated read");
      }),
    ]);
    runner.abort();
    closing = cleanup().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);
    expect(closeOrder).toEqual([]);
    expect((await lstat(f.project.paths.temp)).isDirectory()).toBe(true);
    await expect(
      inCaptureTest(scope, () =>
        f.run(
          { operation: "reference-plan", requestId: "original" },
          scope.signal,
        ),
      ),
    ).rejects.toThrow();
  } finally {
    runner.abort();
    gate.resolve();
    await work;
    await (closing ?? cleanup());
    closed.mockRestore();
    cleanups.splice(cleanups.indexOf(cleanup), 1);
  }
  expect(closeOrder.length).toBeGreaterThan(0);
  expect(closeOrder.every(Boolean)).toBe(true);
  expect(f.readPins).toBe(0);
  await expect(lstat(f.project.paths.temp)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports a native capture deadline as a closed setup failure without exposing error text", async () => {
  const runner = new AbortController();
  const events: ReferencePhaseEvent[] = [];
  const telemetry = referenceTelemetry(
    "closed-diagnostic",
    runner.signal,
    (event) => events.push(event),
  );
  telemetry.arm();
  const result = await telemetry.measure("setup", () =>
    telemetry.measure("capture", async () => ({
      status: "interrupted",
      error: { code: "DEADLINE_EXCEEDED", message: "synthetic-private-path" },
    })),
  );
  expect(result.status).toBe("interrupted");
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "settled",
      phase: "capture",
      outcome: "interrupted",
      errorCode: "DEADLINE_EXCEEDED",
    }),
  );
  expect(JSON.stringify(events)).not.toContain("synthetic-private-path");
  expect(events.some((event) => event.phase === "body")).toBe(false);
  telemetry.close();
});

it("requires exact explicit offline approval and attaches once without modifying a large committed capture", async () => {
  const f = await fixture({ large: true });
  const old = await f.blobs();
  const plan = await f.plan();
  expect(plan.status, JSON.stringify(plan)).toBe("complete");
  expect(JSON.stringify(plan)).not.toContain("synthetic-only");
  expect(
    await f.run({
      operation: "reference-download",
      requestId: "original",
      expectedApproval: "0".repeat(64),
      confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  expect(
    await f.run({
      operation: "reference-approve",
      requestId: "original",
      origin: `${origin}/`,
      expectedProof: required(plan.value?.proposal?.proofSha256),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  const approved = await f.approve();
  expect(f.image).not.toHaveBeenCalled();
  const result = await f.download(approved);
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.value?.evidence).toMatchObject({
    referenceStatus: "complete",
    readiness: "not-evaluated",
    reference: {
      bounds: { x: 10, y: 20 },
      pixelWidth: 2,
      pixelHeight: 2,
      colorSpace: "srgb",
    },
    usage: { externalCalls: 1, dnsQueries: 1 },
  });

  expect(f.image).toHaveBeenCalledTimes(1);
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
  await f.reopen();
  expect((await f.download(approved)).value?.receipt).toEqual(
    result.value?.receipt,
  );
  expect(f.image).toHaveBeenCalledTimes(1);
  const after = new Map(await f.blobs());
  for (const [name, bytes] of old) expect(after.get(name)).toEqual(bytes);
});

it.each([
  ["image/png", "png", true],
  ["application/octet-stream", "generic-binary", true],
  ["binary/octet-stream", "generic-binary", true],
  [undefined, "missing", false],
  ["text/html", "other", false],
  ["application/json", "other", false],
] as const)(
  "persists safe MIME %s evidence and original bytes without renewing consumed authority",
  async (mediaType, mimeClass, accepted) => {
    const f = await fixture();
    const approval = await f.approve();
    const before = await f.blobs();
    const original = authoredPng(
      6,
      8,
      Buffer.from([
        0, 10, 20, 30, 255, 10, 20, 30, 255, 0, 10, 20, 30, 255, 10, 20, 30,
        255,
      ]),
      [
        srgb(),
        chunk("tEXt", Buffer.from("Synthetic\0diagnostic-private-marker")),
      ],
      [],
      2,
      2,
    );
    f.image.mockImplementation(async (_url, budget) => {
      budget.dnsQuery();
      budget.receive(original.length + 100);
      budget.decoded(original.length);
      return {
        status: 200,
        bytes: Buffer.from(original),
        ...(mediaType ? { mediaType } : {}),
      };
    });
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe(
      accepted ? "complete" : "unavailable",
    );
    expect(result.value?.evidence).toMatchObject({
      statusCode: 200,
      referenceDiagnostic: {
        stage: accepted ? "png" : "mime",
        reason: accepted
          ? "validated"
          : mediaType
            ? "mime-rejected"
            : "mime-missing",
        mimeClass,
      },
    });
    expect(JSON.stringify(result)).not.toContain("diagnostic-private-marker");
    const after = new Map(await f.blobs());
    for (const [hash, bytes] of before) expect(after.get(hash)).toEqual(bytes);
    if (accepted)
      expect(
        after.get(required(result.value?.evidence?.reference?.artifact.sha256)),
      ).toEqual(original);
    else {
      expect(result.value?.receipt?.outputs).toHaveLength(1);
      expect(result.value?.evidence?.errorCode).toBe("UNSUPPORTED_FEATURE");
    }
    await f.reopen();
    expect((await f.download(approval)).value?.receipt).toEqual(
      result.value?.receipt,
    );
    expect(f.image).toHaveBeenCalledTimes(1);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);
it("returns terminal raster diagnostic without claiming a durable receipt or replaying", async () => {
  const f = await fixture();
  const approval = await f.approve();
  const bytes = png(true, 1, 1);
  const { header, signature } = await import(
    "../../assets/tests/png-fixtures.js"
  );
  const oversized = Buffer.concat([
    signature,
    header(6, 8, 6553601),
    bytes.subarray(33),
  ]);
  f.image.mockResolvedValue({
    status: 200,
    bytes: oversized,
    mediaType: "image/png",
  });
  const result = await f.download(approval);
  expect(result).toMatchObject({
    status: "failed",
    error: {
      code: "RASTER_LIMIT",
      referenceDiagnostic: {
        stage: "png",
        reason: "raster-limit",
        mimeClass: "png",
      },
    },
  });
  expect(result.value?.receipt).toBeUndefined();
  await f.download(approval);
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("reads legacy unknown HTTP200 decoder failure without rewriting its evidence or consumed slot", async () => {
  const f = await fixture();
  const approval = await f.approve();
  const legacy = vi
    .spyOn(referenceDecoder, "decodeReference")
    .mockRejectedValue(
      new HostBoundaryError(
        "INVALID_INPUT",
        "Synthetic legacy decoder collision.",
      ),
    );
  const result = await f.download(approval);
  legacy.mockRestore();
  expect(result.status, JSON.stringify(result)).toBe("unavailable");
  expect(result.value?.evidence).toMatchObject({
    statusCode: 200,
    errorCode: "INVALID_INPUT",
    referenceStatus: "unavailable",
  });
  expect(result.value?.evidence?.referenceDiagnostic).toBeUndefined();
  expect(result.referenceDiagnostic).toEqual({
    stage: "legacy",
    reason: "legacy-unknown",
    mimeClass: "not-observed",
  });
  const before = await f.blobs();
  await f.reopen();
  const inspected = await f.download(approval);
  expect(inspected.value?.receipt).toEqual(result.value?.receipt);
  expect(inspected.value?.evidence).toEqual(result.value?.evidence);
  expect(await f.blobs()).toEqual(before);
  expect(f.image).toHaveBeenCalledTimes(1);
});

async function legacyReferenceFailure(f: Awaited<ReturnType<typeof fixture>>) {
  const approval = await f.approve();
  const legacy = vi
    .spyOn(referenceDecoder, "decodeReference")
    .mockRejectedValue(
      new HostBoundaryError(
        "INVALID_INPUT",
        "Synthetic legacy rejection, phase unknown.",
      ),
    );
  try {
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe("unavailable");
    expect(result.value?.evidence?.statusCode).toBe(200);
    expect(result.value?.evidence?.referenceDiagnostic).toBeUndefined();
    return result;
  } finally {
    legacy.mockRestore();
  }
}

function realisticReferencePng() {
  const raw = Buffer.alloc((460 * 4 + 1) * 460);
  let seed = 42;
  for (let y = 0; y < 460; y++)
    for (let x = 1; x <= 460 * 4; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw[y * (460 * 4 + 1) + x] = seed & 255;
    }
  return authoredPng(6, 8, raw, [srgb()], [], 460, 460);
}

it("fixed-clock budget setup still rejects an explicitly expired capture execution lease", async () => {
  const original = Execution.prototype.check;
  let expired = false;
  let guardCode: string | undefined;
  const check = vi
    .spyOn(Execution.prototype, "check")
    .mockImplementation(function (this: Execution) {
      const signal = this.context.signal;
      if (!expired && this.record.job.operation === "capture") {
        expired = true;
        vi.spyOn(this.context.clock, "now").mockReturnValue(
          Date.parse(required(this.record.job.lease).expiresAt),
        );
      }
      try {
        return original.call(this);
      } catch (error) {
        if (expired && error instanceof HostBoundaryError)
          guardCode ??= error.code;
        throw error;
      } finally {
        expect(this.context.signal).toBe(signal);
      }
    });
  try {
    await expect(fixture({ fixedClock: true })).rejects.toThrow(
      /capture-not-committed/,
    );
    expect(expired).toBe(true);
    expect(guardCode).toBe("LEASE_LOST");
  } finally {
    check.mockRestore();
  }
});

it("completes a diagnostic with realistic synthetic source bytes within the invocation input budget", async () => {
  const f = await fixture({
    fixedClock: true,
    diagnostic: true,
    nodeBytes: 2400000,
    frameSize: 460,
    durabilityReads: true,
  });
  const predecessor = await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const before = await f.blobs();
  f.reads.length = 0;
  seam.physicalReads = 0;
  const pngBytes = realisticReferencePng();
  f.image.mockImplementation(async (_url, budget) => {
    budget.check();
    budget.dnsQuery();
    budget.receive(pngBytes.length);
    budget.decoded(pngBytes.length);
    return { status: 200, mediaType: "image/png", bytes: pngBytes };
  });
  const result = await f.diagnosticDownload(approved);
  const allowed = f.reads.filter((read) => read.allowed);
  const measurement = JSON.stringify({
    status: result.status,
    error: result.error?.code,
    job: result.value?.job?.status,
    jobError: result.value?.job?.error?.code,
    charged: allowed.reduce((sum, read) => sum + read.bytes, 0),
    physical: seam.physicalReads,
    pngBytes: pngBytes.length,
    largeReads: allowed.filter((read) => read.bytes >= 2000000).length,
    denied: f.reads.filter((read) => !read.allowed),
    networkCalls: f.image.mock.calls.length,
  });
  expect(result.status, measurement).toBe("complete");
  expect(result.value?.receipt).toBeDefined();
  const charged = allowed.reduce((sum, read) => sum + read.bytes, 0);
  expect(result.inputAccounting, measurement).toEqual({
    limitBytes: 26214400,
    privateBytes: charged,
    networkBytes: pngBytes.length,
    phase: "inspection",
  });
  expect(result.inputAccounting).toMatchInlineSnapshot(`
    {
      "limitBytes": 26214400,
      "networkBytes": 847196,
      "phase": "inspection",
      "privateBytes": 18048077,
    }
  `);
  expect(allowed.filter((read) => read.bytes >= 2400000)).toHaveLength(5);
  expect({
    physicalBytes: seam.physicalReads,
    eofReservations: allowed.filter((read) => read.bytes === 1).length,
    privateBytes: charged,
    networkBytes: pngBytes.length,
    totalBytes: charged + pngBytes.length,
  }).toMatchInlineSnapshot(`
    {
      "eofReservations": 73,
      "networkBytes": 847196,
      "physicalBytes": 18048004,
      "privateBytes": 18048077,
      "totalBytes": 18895273,
    }
  `);
  expect(charged + pngBytes.length).toBeLessThanOrEqual(26214400);
  expect(charged).toBe(
    seam.physicalReads + allowed.filter((read) => read.bytes === 1).length,
  );
  expect(f.reads.every((read) => read.allowed)).toBe(true);
  const after = new Map(await f.blobs());
  for (const [hash, bytes] of before) expect(after.get(hash)).toEqual(bytes);
  const original = await f.run({
    operation: "reference-inspect",
    requestId: "original",
  });
  expect(original.value?.job).toEqual(predecessor.value?.job);
  expect(original.value?.receipt).toEqual(predecessor.value?.receipt);
  expect(original.value?.evidence).toEqual(predecessor.value?.evidence);
  expect(f.image).toHaveBeenCalledTimes(2);
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
});

it("an expired diagnostic commit cannot stand in for the configured after-artifacts interruption", async () => {
  const f = await fixture({ diagnostic: true, fixedClock: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const observation = f.observeDiagnosticCommit(true);
  f.setFault("job-after-artifacts");
  try {
    const result = await f.diagnosticDownload(approved);
    const physical = await observation.physical();
    expect(result).toMatchObject({
      status: "interrupted",
      error: { code: "ACTION_REQUIRED" },
      value: { job: { status: "interrupted", error: { code: "CONFLICT" } } },
    });
    expect(observation.spy).toHaveBeenCalledTimes(1);
    expect(observation.observed).toHaveLength(2);
    expect(f.faultHits).toEqual([]);
    expect(
      physical.map(({ stageExists, blobExists }) => ({
        stageExists,
        blobExists,
      })),
    ).toEqual([
      { stageExists: true, blobExists: false },
      { stageExists: true, blobExists: false },
    ]);
    expect(result.value?.receipt).toBeUndefined();
    expect(f.image).toHaveBeenCalledTimes(2);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  } finally {
    observation.spy.mockRestore();
  }
});

it("validates actual published-only retained bytes offline without rewriting the interrupted acquisition", async () => {
  const f = await fixture({ diagnostic: true, fixedClock: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const observation = f.observeDiagnosticCommit();
  f.setFault("job-after-artifacts");
  const interrupted = await f.diagnosticDownload(approved);
  observation.spy.mockRestore();
  expect(interrupted.status, JSON.stringify(interrupted)).toBe("interrupted");
  expect(f.faultHits).toEqual(["job-after-artifacts"]);
  expect(interrupted.value?.job?.error?.code).toBe("INTERNAL_ERROR");
  expect(interrupted.value?.receipt).toBeUndefined();
  expect(observation.observed).toHaveLength(2);
  const published = await observation.physical();
  expect(
    published.map(({ stageExists, blobExists }) => ({
      stageExists,
      blobExists,
    })),
  ).toEqual([
    { stageExists: false, blobExists: true },
    { stageExists: false, blobExists: true },
  ]);
  f.setFault();
  f.advanceClock(40000);
  const metadata = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  const expectedJob = required(metadata.value?.metadata?.jobSha256);
  const before = await f.blobs();
  f.image.mockClear();
  const result = await f.validateRetained(expectedJob);
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.value).toMatchObject({
    verification: "retained-bytes",
    eligibility: "eligible-for-recovery-review",
    historicalStatus: "interrupted",
    consumed: true,
    pixelWidth: 2,
    pixelHeight: 2,
    stages: [
      { role: "evidence", publication: "published-only" },
      { role: "reference", publication: "published-only" },
    ],
  });
  expect(result.inputAccounting?.networkBytes).toBe(0);
  expect(result.inputAccounting?.privateBytes).toBeGreaterThan(0);
  expect(f.readPins).toBe(0);
  const again = await f.validateRetained(expectedJob);
  expect(again.value).toEqual(result.value);
  expect(await f.blobs()).toEqual(before);
  expect(await observation.physical()).toEqual(published);
  await f.reopen();
  const after = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  expect(after.value).toEqual(metadata.value);
  expect(await observation.physical()).toEqual(published);
  expect(f.image).not.toHaveBeenCalled();
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
});

it(`validates stage-only realistic source and PNG under the unchanged physical read budget including closure${nativeRetainedMode ? " [native]" : ""}`, async () => {
  const f = await fixture({
    diagnostic: true,
    nodeBytes: 2400000,
    frameSize: 460,
  });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const pngBytes = realisticReferencePng();
  expect(pngBytes.length).toBe(847196);
  f.image.mockImplementation(async (_url, budget) => {
    budget.dnsQuery();
    budget.receive(pngBytes.length);
    budget.decoded(pngBytes.length);
    return { status: 200, mediaType: "image/png", bytes: pngBytes };
  });
  const publish = vi
    .spyOn(ProjectFileSystem.prototype, "publish")
    .mockRejectedValueOnce(
      new HostBoundaryError(
        "INPUT_LIMIT",
        "Synthetic interruption before first publication",
      ),
    );
  const interrupted = await f.diagnosticDownload(approved);
  publish.mockRestore();
  expect(interrupted.status, JSON.stringify(interrupted)).toBe("interrupted");
  f.advanceClock(40000);
  const metadata = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  f.image.mockClear();
  const result = await f.validateRetained(
    required(metadata.value?.metadata?.jobSha256),
  );
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.value?.stages.map((stage) => stage.publication)).toEqual([
    "stage-only",
    "stage-only",
  ]);
  expect(result.inventoryFailure).toBeUndefined();
  const charged = f.reads
    .filter((read) => read.allowed)
    .reduce((sum, read) => sum + read.bytes, 0);
  const eof = f.reads.filter((read) => read.allowed && read.bytes === 1).length;
  expect(f.reads.every((read) => read.allowed)).toBe(true);
  expect(result.inputAccounting).toEqual({
    limitBytes: 26214400,
    privateBytes: charged,
    networkBytes: 0,
    phase: "inspection",
  });
  expect(charged).toBe(seam.physicalReads + eof);
  expect(charged).toBeLessThanOrEqual(26214400);
  expect(f.readPins).toBe(0);
  expect(f.image).not.toHaveBeenCalled();
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
  expect({
    physical: seam.physicalReads,
    eof,
    charged,
    network: 0,
  }).toMatchInlineSnapshot(`
    {
      "charged": 5698604,
      "eof": 29,
      "network": 0,
      "physical": 5698575,
    }
  `);
  if (nativeRetainedMode) {
    expect(f.nativeAdmissions).toBeGreaterThan(29);
    expect(f.strictDenials).toBeGreaterThan(29);
    const preparation = required(f.ownerPreparation);
    expect(preparation.entries).toBeGreaterThan(2);
    expect(preparation.naturalOwnerDenials).toBe(preparation.normalized);
    console.log(
      `retained-native-owner-fixture: ${JSON.stringify(preparation)}; owner-only; DACL/control/names/identity/bytes unchanged`,
    );
    console.log(
      "retained-native-history: real native pins; strict inherited denial; private=5698604; physical=5698575; eof=29; network=0; pins=0",
    );
  }
});

it("distinguishes initial source metadata denial from later lineage proof without exposing native details", async () => {
  const { f, expectedJob } = await interruptedValidationFixture();
  const metadata = vi
    .spyOn(LocalStore.prototype, "referenceJobMetadata")
    .mockRejectedValueOnce(
      new HostBoundaryError(
        "ACTION_REQUIRED",
        "Synthetic private metadata guard detail",
      ),
    );
  try {
    const result = await f.validateRetained(expectedJob);
    expect(result).toMatchObject({
      status: "failed",
      reason: "source-metadata-invalid",
      error: { code: "ACTION_REQUIRED" },
      inputAccounting: { privateBytes: 0, networkBytes: 0, phase: "proof" },
    });
    expect(result.value).toBeUndefined();
    expect(result.inventoryFailure).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(
      "Synthetic private metadata guard detail",
    );
  } finally {
    metadata.mockRestore();
  }
});

async function interruptedValidationFixture() {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  f.setFault("job-after-artifacts");
  expect((await f.diagnosticDownload(approved)).status).toBe("interrupted");
  f.setFault();
  f.advanceClock(40000);
  const metadata = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  return {
    f,
    expectedJob: required(metadata.value?.metadata?.jobSha256),
    jobId: required(metadata.value?.metadata?.jobId),
  };
}

it(`publishes realistic offline reference within one physical budget${nativeRetainedMode ? " [native]" : ""}`, async () => {
  const f = await fixture({
    diagnostic: true,
    offline: true,
    nodeBytes: 2400000,
    frameSize: 460,
    durabilityReads: true,
    ...(nativeRetainedMode ? { longDatabase: true } : {}),
  });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const pngBytes = realisticReferencePng();
  expect(pngBytes.length).toBe(847196);
  f.image.mockImplementation(async (_url, budget) => {
    budget.dnsQuery();
    budget.receive(pngBytes.length);
    budget.decoded(pngBytes.length);
    return { status: 200, mediaType: "image/png", bytes: pngBytes };
  });
  const publish = vi
    .spyOn(ProjectFileSystem.prototype, "publish")
    .mockRejectedValueOnce(
      new HostBoundaryError("INPUT_LIMIT", "Synthetic stage-only interruption"),
    );
  expect((await f.diagnosticDownload(approved)).status).toBe("interrupted");
  publish.mockRestore();
  f.advanceClock(40000);
  const metadata = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  const expectedJob = required(metadata.value?.metadata?.jobSha256);
  const command = { requestId: "original", expectedJob };
  const plan = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply-plan",
  });
  expect(plan.status, JSON.stringify(plan)).toBe("complete");
  const databasePreimage = nativeRetainedMode
    ? await f.observeDatabasePreimage()
    : undefined;
  f.image.mockClear();
  f.api.mockClear();
  f.vault.mockClear();
  f.ready.mockClear();
  const applyStarted = Date.now();
  const apply = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(apply.status, JSON.stringify(apply)).toBe("complete");
  const applyElapsed = Date.now() - applyStarted;
  expect(applyElapsed).toBeLessThan(30000);
  expect(apply.effectiveReference?.referenceStatus).toBe("complete");
  const charged = f.reads
    .filter((r) => r.allowed)
    .reduce((sum, r) => sum + r.bytes, 0);
  expect(charged).toBe(apply.inputAccounting?.privateBytes);
  expect(charged).toBe(
    seam.physicalReads +
      f.reads.filter((r) => r.allowed && r.bytes === 1).length,
  );
  expect(charged).toBeLessThanOrEqual(26214400);
  expect(apply.inputAccounting?.networkBytes).toBe(0);
  expect(f.readPins).toBe(0);
  expect(f.image).not.toHaveBeenCalled();
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
  console.log(
    `offline-reference-budget: private=${charged}; eof=${f.reads.filter((r) => r.allowed && r.bytes === 1).length}; network=0; pins=0`,
  );
  console.log(
    `offline-reference-wall: applyMs=${applyElapsed}; fixtureClock=real-plus-expiry-offset`,
  );
  const phaseLedger = () =>
    Object.fromEntries(
      [...new Set(f.ledger.map((r) => r.phase))].map((phase) => [
        phase,
        {
          bytes: f.ledger
            .filter((r) => r.phase === phase)
            .reduce((sum, r) => sum + r.bytes, 0),
          eof: f.ledger.filter((r) => r.phase === phase && r.bytes === 1)
            .length,
        },
      ]),
    );
  expect(f.ledger.reduce((sum, r) => sum + r.bytes, 0)).toBe(charged);
  console.log(`offline-apply-ledger: ${JSON.stringify(phaseLedger())}`);
  if (nativeRetainedMode) {
    expect(f.project.paths.database.length).toBe(240);
    expect(databasePreimage?.snapshot).toMatchObject({
      schema: 4,
      applicationId: 0x44535431,
      integrity: "ok",
    });
    const backup = await f.observeDatabasePreimage(true);
    expect(backup.snapshot).toEqual(databasePreimage?.snapshot);
    expect(f.backupPublications).toEqual([
      {
        pendingUnits: 305,
        finalUnits: 297,
        byteLength: backup.backup?.byteLength,
        sha256: backup.backup?.sha256,
      },
    ]);
    expect(backup.backup?.pathUnits).toBe(297);
    expect((await f.observeOffline()).events).toHaveLength(8);
    const conversionStarted = Date.now();
    const converted = await f.runOffline({
      ...command,
      operation: "convert-reference",
      expectedRecovery: required(apply.receiptSha256),
      confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
    });
    expect(converted.status, JSON.stringify(converted)).toBe("complete");
    expect(converted.conversion).toBeDefined();
    expect(converted.inputAccounting?.privateBytes).toBeLessThanOrEqual(
      26214400,
    );
    expect(converted.inputAccounting?.networkBytes).toBe(0);
    expect(Date.now() - conversionStarted).toBeLessThan(30000);
    const convertElapsed = Date.now() - conversionStarted;
    const convertEof = f.reads.filter((r) => r.allowed && r.bytes === 1).length;
    expect(converted.inputAccounting?.privateBytes).toBe(
      seam.physicalReads + convertEof,
    );
    expect(f.ledger.reduce((sum, r) => sum + r.bytes, 0)).toBe(
      converted.inputAccounting?.privateBytes,
    );
    console.log(
      `offline-reference-conversion: private=${converted.inputAccounting?.privateBytes}; network=0; pins=${f.readPins}; convertMs=${convertElapsed}; eof=${convertEof}`,
    );
    console.log(`offline-convert-ledger: ${JSON.stringify(phaseLedger())}`);
    expect((await f.observeOffline()).events).toHaveLength(10);
    console.log(
      "offline-backup-paths: source=240; pending=305; final=297; raw-preimage=equal; native-callbacks=ordinary",
    );
  }
});

it("publishes one offline reference receipt and replays without changing the consumed diagnostic", async () => {
  const { f, command, before, apply } = await committedOfflineFixture();
  expect(apply.effectiveReference?.historicalStatus).toBe("interrupted");
  const again = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply-plan",
  });
  expect(again.status, JSON.stringify(again)).toBe("complete");
  const replay = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(again.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(replay.status, JSON.stringify(replay)).toBe("complete");
  expect(replay.receiptSha256).toBe(apply.receiptSha256);
  const after = await f.observeOffline();
  for (const table of ["jobs", "job_resources", "job_stages"])
    expect(after.rows[table]).toEqual(before.rows[table]);
  for (const table of ["receipts", "artifacts"])
    for (const row of before.rows[table] ?? [])
      expect(after.rows[table]).toContainEqual(row);
  expect(after.files).toEqual(before.files);
  expect(after.controls).toHaveLength(1);
  expect(after.events).toHaveLength(8);
  expect(f.readPins).toBe(0);
});

it("converts the recovered reference with exact provenance and stable receipt replay", async () => {
  const { f, command, apply } = await committedOfflineFixture(
    "conversion-provenance",
  );
  const before = await f.observeOffline();
  const wrongRecovery = await f.runOffline({
    ...command,
    operation: "convert-reference",
    expectedRecovery: "0".repeat(64),
    confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
  });
  expect(wrongRecovery.status).toBe("failed");
  expect(wrongRecovery.error?.code).toBe("CONFLICT");
  const conversion = await f.runOffline({
    ...command,
    operation: "convert-reference",
    expectedRecovery: required(apply.receiptSha256),
    confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
  });
  expect(conversion.status, JSON.stringify(conversion)).toBe("complete");
  expect(conversion.conversion?.readiness).not.toBe("ready");
  const convertedAgain = await f.runOffline({
    ...command,
    operation: "convert-reference",
    expectedRecovery: required(apply.receiptSha256),
    confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
  });
  expect(convertedAgain.status, JSON.stringify(convertedAgain)).toBe(
    "complete",
  );
  expect(convertedAgain.conversion).toEqual(conversion.conversion);
  const inspected = await f.runOffline({
    ...command,
    operation: "reference-recovery-inspect",
  });
  expect(inspected.status, JSON.stringify(inspected)).toBe("complete");
  expect(inspected.effectiveReference?.receiptSha256).toBe(apply.receiptSha256);
  const after = await f.observeOffline();
  for (const table of ["jobs", "job_resources", "job_stages"])
    expect(after.rows[table]).toEqual(before.rows[table]);
  for (const table of ["receipts", "artifacts"])
    for (const row of before.rows[table] ?? [])
      expect(after.rows[table]).toContainEqual(row);
  expect(after.files).toEqual(before.files);
  expect(after.controls).toEqual(before.controls);
  expect(after.events).toHaveLength(10);
  const referenceEvidence = parseContract(
    "ReferenceConversionEvidence",
    await readFile(
      path.join(
        f.project.paths.artifacts,
        "blobs",
        required(conversion.conversion?.evidence.sha256),
      ),
      "utf8",
    ),
    "json",
  );
  expect(referenceEvidence.effectiveReference).toEqual(
    apply.effectiveReference,
  );
  expect(referenceEvidence.source).toEqual(apply.effectiveReference?.source);
  const receipts = (after.rows.receipts ?? []).map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("data" in row) ||
      typeof row.data !== "string"
    )
      throw new Error("Invalid synthetic receipt row.");
    return parseContract("CommitReceipt", row.data, "json");
  });
  const receipt = required(
    receipts.find((r) => r.jobId === conversion.conversion?.operationId),
  );
  const provenance = parseContract(
    "ProvenanceSnapshot",
    await readFile(
      path.join(
        f.project.paths.artifacts,
        "blobs",
        required(receipt.outputs.at(-3)).sha256,
      ),
      "utf8",
    ),
    "json",
  );
  expect(
    provenance.evidence
      .filter((e) => e.kind === "source-image")
      .map((e) => e.artifact),
  ).toContainEqual(apply.effectiveReference?.reference);
  const originalStage = required(before.files[0]);
  const stagePath = path.join(
    f.project.paths.artifacts,
    ...originalStage.name.split("/"),
  );
  const outsideInventory = path.join(
    f.project.paths.temp,
    "removed-original-target",
  );
  await rename(stagePath, outsideInventory);
  try {
    const missingStage = await f.runOffline({
      ...command,
      operation: "reference-recovery-inspect",
    });
    expect(missingStage.status).toBe("failed");
    expect(missingStage.error?.code).toBe("ARTIFACT_INTEGRITY");
  } finally {
    await rename(outsideInventory, stagePath);
  }
  expect(f.readPins).toBe(0);
});

it("preserves the sealed recovery through active and repeated archival backup validation", async () => {
  const { f, command, apply } =
    await committedOfflineFixture("converted-archive");
  const conversion = await f.runOffline({
    ...command,
    operation: "convert-reference",
    expectedRecovery: required(apply.receiptSha256),
    confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
  });
  expect(conversion.status, JSON.stringify(conversion)).toBe("complete");
  expect(conversion.conversion).toBeDefined();
  expect((await f.observeOffline()).events).toHaveLength(10);
  const otherSlot = await f.runOffline({
    operation: "reference-recovery-apply-plan",
    requestId: "different_capture",
    expectedJob: command.expectedJob,
  });
  expect(otherSlot.status).toBe("failed");
  expect(otherSlot.reason).toBe("recovery-blocked");
  expect(otherSlot.inputAccounting?.privateBytes).toBe(0);
  await f.reopen();
  const outputNames = await readdir(f.project.paths.outputs);
  const ordinaryExport = await f.runtime.execute(
    {
      operation: "artifact",
      requestId: "original",
      role: "metadata",
      outputRelative: "sealed-output.bin",
    },
    new AbortController().signal,
  );
  expect(ordinaryExport.status).toBe("failed");
  expect(ordinaryExport.error?.code).toBe("ACTION_REQUIRED");
  expect(await readdir(f.project.paths.outputs)).toEqual(outputNames);
  await f.runtime.close();
  expect(await f.backupOffline()).toEqual({
    recoveryRecords: 1,
    restoredExecution: "fenced-not-resumable",
    gcDeleted: 0,
    tamperedDenied: true,
  });
  const archived = await f.runArchivedOffline({
    ...command,
    operation: "reference-recovery-inspect",
  });
  expect(archived.status, JSON.stringify(archived)).toBe("failed");
  expect(archived.reason).toBe("recovery-blocked");
  const archivedConversion = await f.runArchivedOffline({
    ...command,
    operation: "reference-conversion-inspect",
    expectedRecovery: required(apply.receiptSha256),
  });
  expect(archivedConversion.status).toBe("failed");
  expect(archivedConversion.inspection?.state).toBe("blocked");
  expect(archivedConversion.inspection?.conversion).toBeUndefined();
  expect(f.readPins).toBe(0);
});

it("joins an observed real restore before cancellation cleanup deletes its SQLite fixture", async () => {
  const outer = captureTestScope();
  const runner = new AbortController();
  const scope = new AsyncTestScope(
    AbortSignal.any([outer.signal, runner.signal]),
  );
  const { f } = await inCaptureTest(scope, () => committedOfflineFixture());
  const cleanup = required(cleanups.at(-1));
  const gate = deferred<void>();
  const events: string[] = [];
  let entered = false;
  let settled = false;
  let currentRestore: LocalStore | undefined;
  const restore = LocalStore.prototype.restore;
  vi.spyOn(LocalStore.prototype, "restore").mockImplementation(function (
    this: LocalStore,
    value,
    context,
  ) {
    if (context.signal !== scope.signal)
      return restore.call(this, value, context);
    currentRestore = this;
    return restore
      .call(this, value, context)
      .finally(() => events.push("restore-settled"));
  });
  const close = LocalStore.prototype.close;
  vi.spyOn(LocalStore.prototype, "close").mockImplementation(function (
    this: LocalStore,
  ) {
    close.call(this);
    if (this === currentRestore) events.push("database-closed");
  });
  const stage = ProjectFileSystem.prototype.stage;
  vi.spyOn(ProjectFileSystem.prototype, "stage").mockImplementation(
    async function (this: ProjectFileSystem, ...args) {
      const result = await stage.apply(this, args);
      if (args[2].signal === scope.signal && !entered) {
        entered = true;
        events.push("restore-stage-observed");
        outer.notify();
        await gate.promise;
      }
      return result;
    },
  );
  const work = f
    .backupOffline()
    .then(
      () => {
        throw new Error("Cancelled restore unexpectedly succeeded.");
      },
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
      outer.notify();
    });
  let closing: Promise<void> | undefined;
  try {
    await outer.until(() => (entered || settled ? true : undefined));
    expect(entered).toBe(true);
    expect(Reflect.get(required(currentRestore), "active")).toBeGreaterThan(0);
    expect((await lstat(f.project.paths.temp)).isDirectory()).toBe(true);
    runner.abort();
    closing = cleanup().then(() => {
      events.push("root-removed");
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(events).not.toContain("database-closed");
    expect(events).not.toContain("root-removed");
    expect(vi.isMockFunction(LocalStore.prototype.restore)).toBe(true);
  } finally {
    gate.resolve();
    runner.abort();
    await scope.close();
    await (closing ?? cleanup());
    cleanups.splice(cleanups.indexOf(cleanup), 1);
  }
  const failure = await work;
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/CANCELLED|cancelled/i);
  expect(events.lastIndexOf("restore-settled")).toBeLessThan(
    events.indexOf("database-closed"),
  );
  expect(events.indexOf("database-closed")).toBeLessThan(
    events.indexOf("root-removed"),
  );
  await expect(lstat(f.project.paths.temp)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(f.backupOffline()).rejects.toThrow(/cancelled/i);
  const lastOwner = seam.work;
  await expect(
    f.runOffline({
      operation: "reference-recovery-inspect",
      requestId: "original",
      expectedJob: "0".repeat(64),
    }),
  ).rejects.toThrow(/cancelled/i);
  expect(seam.work).toBe(lastOwner);
});

async function committedOfflineFixture(
  telemetry?: "conversion-provenance" | "converted-archive",
) {
  const { f, command, before, plan } = await offlineStageFixture(
    false,
    true,
    telemetry,
  );
  if (!before) throw new Error("Missing synthetic preimage.");
  const apply = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(apply.status, JSON.stringify(apply)).toBe("complete");
  return { f, command, before, apply };
}

it("read-only conversion inspection reports validated pre-intent and intent-only states without writing", async () => {
  const { f, command, apply } = await committedOfflineFixture();
  const inspect = {
    ...command,
    operation: "reference-conversion-inspect" as const,
    expectedRecovery: required(apply.receiptSha256),
  };
  const before = await f.observeOffline();
  const blockedWrites = vi.spyOn(
    LocalStore.prototype,
    "beginReferenceConversion",
  );
  const result = await f.runOffline(inspect);
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.inspection).toMatchObject({
    state: "incomplete",
    detail: "no-conversion-intent-observed",
    proof: {
      recoveryPolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
      inspectionPolicySha256: REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
    },
  });
  expect(result.inspection?.conversion).toBeUndefined();
  expect(blockedWrites).not.toHaveBeenCalled();
  expect(await f.observeOffline()).toEqual(before);
  const snapshot = LocalStore.prototype.referenceRecoverySnapshot;
  let snapshots = 0;
  const changedSnapshot = vi
    .spyOn(LocalStore.prototype, "referenceRecoverySnapshot")
    .mockImplementation(async function (this: LocalStore, context) {
      const value = await snapshot.call(this, context);
      if (++snapshots === 3 && value.status === "complete")
        value.value.metadataSha256 = "f".repeat(64);
      return value;
    });
  const changed = await f.runOffline(inspect);
  expect(snapshots).toBe(3);
  expect(changed.error?.code).toBe("CONFLICT");
  expect(changed.inspection).toEqual({
    verification: "conversion-readonly-v1",
    state: "blocked",
    detail: "verification-incomplete",
  });
  changedSnapshot.mockRestore();
  const stage = vi
    .spyOn(LocalStore.prototype, "stageReferenceConversion")
    .mockRejectedValueOnce(
      new HostBoundaryError("INTERRUPTED", "Synthetic intent-only stop"),
    );
  expect(
    (
      await f.runOffline({
        ...command,
        operation: "convert-reference",
        expectedRecovery: required(apply.receiptSha256),
        confirmation: REFERENCE_CONVERSION_CONFIRMATION,
      })
    ).status,
  ).toBe("failed");
  stage.mockRestore();
  const afterIntent = await f.observeOffline();
  expect(afterIntent.events).toHaveLength(9);
  const incomplete = await f.runOffline(inspect);
  expect(incomplete.status, JSON.stringify(incomplete)).toBe("complete");
  expect(incomplete.inspection).toMatchObject({
    state: "incomplete",
    detail: "conversion-intent-without-committed-receipt",
  });
  expect(await f.observeOffline()).toEqual(afterIntent);
  const wrong = await f.runOffline({
    ...inspect,
    expectedRecovery: "0".repeat(64),
  });
  expect(wrong.status).toBe("failed");
  expect(wrong.inspection).toEqual({
    verification: "conversion-readonly-v1",
    state: "blocked",
    detail: "verification-incomplete",
  });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(
    (await f.runOffline(inspect, cancelled.signal)).inspection?.state,
  ).toBe("blocked");
  expect(await f.observeOffline()).toEqual(afterIntent);
  f.failInventoryClose();
  const failure = await f.runOffline(inspect).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NativeCaptureCleanupRequired);
  if (!(failure instanceof NativeCaptureCleanupRequired))
    throw new Error("Expected retained readonly cleanup.");
  await failure.close();
  expect(f.readPins).toBe(0);
  expect(await f.observeOffline()).toEqual(afterIntent);
});

it("read-only conversion inspection verifies after a committed conversion deadline and rejects output tampering", async () => {
  const { f, command, apply } = await committedOfflineFixture();
  const commit = LocalStore.prototype.commitReferenceConversion;
  const deadline = vi
    .spyOn(LocalStore.prototype, "commitReferenceConversion")
    .mockImplementation(async function (this: LocalStore, ...args) {
      const result = await commit.apply(this, args);
      if (result.status === "complete") f.advanceClock(30001);
      return result;
    });

  const converted = await f.runOffline({
    ...command,
    operation: "convert-reference",
    expectedRecovery: required(apply.receiptSha256),
    confirmation: REFERENCE_CONVERSION_CONFIRMATION,
  });
  expect(converted.status).toBe("failed");
  expect(converted.error?.code).toBe("DEADLINE_EXCEEDED");
  deadline.mockRestore();
  const before = await f.observeOffline();
  expect(before.events).toHaveLength(10);
  const inspect = {
    ...command,
    operation: "reference-conversion-inspect" as const,
    expectedRecovery: required(apply.receiptSha256),
  };
  const result = await f.runOffline(inspect);
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.inspection?.state).toBe("committed");
  expect(result.inspection?.conversion?.readiness).not.toBe("ready");
  expect(result.inspection?.conversion?.receiptSha256).not.toBe(
    apply.receiptSha256,
  );
  expect(await f.observeOffline()).toEqual(before);
  const artifact = required(result.inspection?.conversion?.evidence);
  const readVerified = LocalStore.prototype.readVerified;
  const finalRead = vi
    .spyOn(LocalStore.prototype, "readVerified")
    .mockImplementation(async function (this: LocalStore, value, context) {
      if (value.sha256 === artifact.sha256)
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Synthetic final output read failure",
        );
      return readVerified.call(this, value, context);
    });
  const laterFailure = await f.runOffline(inspect);
  expect(laterFailure.inspection).toEqual({
    verification: "conversion-readonly-v1",
    state: "blocked",
    detail: "verification-incomplete",
  });
  expect(laterFailure.error?.code).toBe("ARTIFACT_INTEGRITY");
  finalRead.mockRestore();
  await writeFile(
    path.join(f.project.paths.artifacts, "blobs", artifact.sha256),
    "synthetic corrupt conversion",
  );
  const denied = await f.runOffline(inspect);
  expect(denied.status).toBe("failed");
  expect(denied.inspection?.state).toBe("blocked");
  expect(denied.inspection?.conversion).toBeUndefined();
  expect(denied.inspection?.diagnostic).toEqual({
    stage: "inventory-invalid",
    inventoryFailure: {
      check: "committed-size",
      category: "committed-inventory",
    },
  });
  expect(f.readPins).toBe(0);
});

describe.each([
  "tagged",
  "untagged",
  "invalid-tag",
  "cancelled",
  "deadline",
  "authority",
  "authority-throws",
  "revoked",
  "cleanup",
] as const)("independent closed diagnostic fixture: %s", (kind) => {
  let prepared:
    | {
        value: Awaited<ReturnType<typeof committedOfflineFixture>>;
        before: Awaited<
          ReturnType<
            Awaited<
              ReturnType<typeof committedOfflineFixture>
            >["f"]["observeOffline"]
          >
        >;
        signal: AbortSignal;
      }
    | undefined;
  beforeEach(async ({ signal }) => {
    prepared = undefined;
    await ownCaptureWork(async () => {
      const telemetry = required(diagnosticTelemetry.get(captureTestScope()));
      await telemetry.measure("setup", async () => {
        const value = await committedOfflineFixture();
        const before = await value.f.observeOffline();
        captureTestScope().signal.throwIfAborted();
        prepared = { value, before, signal };
      });
    })();
  }, 60000);
  it(`read-only conversion diagnostics preserve denial and read ownership: ${kind}`, async ({
    signal: runnerSignal,
  }) => {
    const owned = required(prepared);
    expect(owned.signal).toBe(runnerSignal);
    captureTestScope().signal.throwIfAborted();
    const { f, command, apply } = owned.value;
    const before = owned.before;
    await required(diagnosticTelemetry.get(captureTestScope())).measure(
      "body",
      async () => {
        const input = {
          ...command,
          operation: "reference-conversion-inspect" as const,
          expectedRecovery: required(apply.receiptSha256),
        };
        const signal = new AbortController();
        const write = vi.spyOn(
          LocalStore.prototype,
          "beginReferenceConversion",
        );
        const inspected = vi
          .spyOn(ProjectFileSystem.prototype, "inspectRetainedReference")
          .mockImplementation(async (_input, context) => {
            if (kind === "cancelled") signal.abort();
            if (kind === "deadline") f.advanceClock(30001);
            if (kind === "revoked")
              vi.spyOn(required(seam.work), "isCurrent").mockReturnValue(false);
            if (kind === "authority-throws")
              vi.spyOn(required(seam.work), "isCurrent").mockImplementation(
                () => {
                  throw new HostBoundaryError(
                    "FORBIDDEN",
                    "Synthetic current authority failure",
                  );
                },
              );
            const outcome = {
              schemaVersion: "1.0" as const,
              projectId: context.projectId,
              requestId: context.requestId,
              status: "failed" as const,
              error: {
                code:
                  kind === "authority"
                    ? ("FORBIDDEN" as const)
                    : ("ARTIFACT_INTEGRITY" as const),
                message: "Synthetic private path must not escape.",
                retryable: false,
                diagnosticIds: [],
              },
              diagnosticIds: [],
            };
            if (kind !== "untagged")
              Reflect.set(outcome, "inventoryFailure", {
                check: "publication-shape",
                category: "history-stage",
                detail: "unproven-history-coexistence",
                ...(kind === "invalid-tag"
                  ? { path: "synthetic-private" }
                  : {}),
              });
            return outcome;
          });
        // Close failure is injected at the actual store boundary, even if inventory never acquired a pin.
        const close = LocalStore.prototype.close;
        let rejectClose = kind === "cleanup";
        const closeSpy = vi
          .spyOn(LocalStore.prototype, "close")
          .mockImplementation(function (this: LocalStore) {
            if (rejectClose) {
              rejectClose = false;
              throw new HostBoundaryError(
                "INTERRUPTED",
                "Synthetic actual close failure",
              );
            }
            return close.call(this);
          });
        const observed = await f
          .runOffline(input, signal.signal)
          .catch((error: unknown) => error);
        if (kind === "authority-throws") {
          expect(observed).toMatchObject({ code: "FORBIDDEN" });
          expect(observed).not.toHaveProperty("inspection");
        } else if (kind === "cleanup") {
          expect(observed).toBeInstanceOf(NativeCaptureCleanupRequired);
          if (!(observed instanceof NativeCaptureCleanupRequired))
            throw new Error("Missing retained cleanup owner.");
          expect(Reflect.get(observed, "inspection")).toBeUndefined();
          await observed.close();
        } else {
          if (
            !observed ||
            typeof observed !== "object" ||
            !("inspection" in observed)
          )
            throw new Error("Missing blocked inspection.");
          const value = parseContract(
            "NativeReferenceOfflineEnvelope",
            JSON.stringify(observed),
            "json",
          );
          expect(value.status).toBe("failed");
          expect(value.inspection?.state).toBe("blocked");
          expect(value.inspection?.proof).toBeUndefined();
          expect(value.inspection?.conversion).toBeUndefined();
          expect(value.inspection?.diagnostic).toEqual(
            kind === "tagged"
              ? {
                  stage: "inventory-invalid",
                  inventoryFailure: {
                    check: "publication-shape",
                    category: "history-stage",
                    detail: "unproven-history-coexistence",
                  },
                }
              : kind === "untagged" || kind === "invalid-tag"
                ? { stage: "inventory-invalid" }
                : undefined,
          );
          expect(JSON.stringify(value)).not.toMatch(
            /synthetic-private|private path/,
          );
          expect(value.inputAccounting?.networkBytes).toBe(0);
          if (kind === "tagged") {
            const reads = structuredClone(f.reads);
            const accounting = value.inputAccounting;
            inspected.mockImplementation(async (_input, context) => ({
              schemaVersion: "1.0",
              projectId: context.projectId,
              requestId: context.requestId,
              status: "failed",
              error: {
                code: "ARTIFACT_INTEGRITY",
                message: "Untagged",
                retryable: false,
                diagnosticIds: [],
              },
              diagnosticIds: [],
            }));
            const untagged = await f.runOffline(input);
            expect(untagged.inspection?.diagnostic).toEqual({
              stage: "inventory-invalid",
            });
            expect(untagged.inputAccounting).toEqual(accounting);
            expect(f.reads).toEqual(reads);
          }
        }
        closeSpy.mockRestore();
        expect(write).not.toHaveBeenCalled();
        expect(f.readPins).toBe(0);
        expect(await f.observeOffline()).toEqual(before);
      },
    );
  }, 60000);
});

it.skipIf(
  !nativeRetainedMode || !process.env.DESIGN_STUDIO_FORK_RESULT_HANDOFF,
)("cold readonly application consumes committed fork outputs", async () => {
  await consumeTransferredForkFixture(
    captureTestScope().signal,
    (work) => {
      seam.forkWorks.set(work.project, work);
    },
    (work) => cleanups.push(work),
  );
});
it.skipIf(!nativeRetainedMode || !process.env.DESIGN_STUDIO_V7_HANDOFF)(
  "cold readonly v8 inspects transferred authentic v7 conversion",
  async () => {
    const handoffPath = process.env.DESIGN_STUDIO_V7_HANDOFF;
    expect(
      Reflect.get(
        globalThis,
        Symbol.for("design-studio.synthetic-crossrelease-egress"),
      ),
    ).toMatchObject({ denialControlPassed: true });
    if (!handoffPath) throw new Error("Missing owned crossrelease handoff.");
    const handoff: unknown = JSON.parse(await readFile(handoffPath, "utf8"));
    if (
      !handoff ||
      typeof handoff !== "object" ||
      !("root" in handoff) ||
      typeof handoff.root !== "string" ||
      !("expectedJob" in handoff) ||
      typeof handoff.expectedJob !== "string" ||
      !("expectedRecovery" in handoff) ||
      typeof handoff.expectedRecovery !== "string" ||
      !("fixtureClockNowMs" in handoff) ||
      typeof handoff.fixtureClockNowMs !== "number" ||
      !Number.isSafeInteger(handoff.fixtureClockNowMs)
    )
      throw new Error("Invalid synthetic crossrelease handoff.");
    const root = handoff.root;
    const fixtureClockNowMs = handoff.fixtureClockNowMs;
    expect(fixtureClockNowMs).toBeGreaterThanOrEqual(Date.UTC(2100, 0, 1));
    expect(path.dirname(root)).toBe(path.dirname(handoffPath));
    expect(path.basename(root)).toMatch(/^ds-ph-reference-/);
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    expect(handoff).toMatchObject({
      writerCommit: "9bcfbaadca45ac6f4ffb4fcd55e8abd5569fad9a",
      writerPolicy: REFERENCE_OFFLINE_POLICY_SHA256,
    });
    const scope = captureTestScope();
    const native = await loadNative();
    const sid = native.principal();
    const pins = new Set<ReadLease>();
    initializeImmutableSqlite(
      path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
    );
    const project = {
      projectId: "project_synthetic",
      artifactRootId: "artifacts_synthetic",
      paths: {
        database: path.join(root, "db", "state.sqlite"),
        artifacts: path.join(root, "artifacts"),
        outputs: path.join(root, "outputs"),
        inputs: root,
        temp: root,
      },
      principal: { actorId: "actor_synthetic" },
      reference: {
        id: "credential_synthetic",
        providerId: "figma_rest",
        store: "windows-credential-manager",
      },
      recheck: async () => {},
      close: async () => {},
    } as CaptureProject;
    let live = true;
    let policy: ReturnType<typeof nativeCapturePolicy>;
    const current = async () => {
      scope.signal.throwIfAborted();
      if (!live)
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Synthetic readonly owner closed.",
        );
    };
    const work: CaptureWork = {
      project,
      actorId: "actor_synthetic",
      permissionScope: "synthetic",
      sqliteBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      policyId: "figma-capture-v1",
      policySha256: CAPTURE_POLICY_SHA256,
      imageOrigins: [],
      apiOrigins: [],
      get policy() {
        return policy;
      },
      current,
      isCurrent: () => live,
      readyCredential: async () => {
        throw new Error("No credential admission");
      },
      credentials: () => {
        throw new Error("No vault");
      },
      recoveryAuthority: async () => {
        throw new Error("No recovery authority");
      },
      referenceAuthority: async () => {
        await current();
        return CAPTURE_REFERENCE_POLICY_SHA256;
      },
      diagnosticAuthority: async () => {
        await current();
        return CAPTURE_DIAGNOSTIC_POLICY_SHA256;
      },
      referenceValidationAuthority: async () => {
        await current();
        return REFERENCE_VALIDATION_POLICY_SHA256;
      },
      referenceOfflineAuthority: async () => {
        await current();
        return REFERENCE_OFFLINE_POLICY_SHA256;
      },
      referenceConversionInspectionAuthority: async () => {
        await current();
        return REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256;
      },
      pinReferenceOfflineDatabase: async () => {
        throw new Error("Old writer pin must not be admitted");
      },
      pinReferenceConversionInspectionDatabase: () =>
        pinImmutableReferenceDatabase({
          filename: project.paths.database,
          sid,
          retainedPins: pins,
          authoritySha256: REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
          authorize: current,
        }),
      pinReferenceValidationEntry: (rootId, relative, directory) => {
        const physical =
          rootId === project.artifactRootId
            ? project.paths.artifacts
            : project.paths.outputs;
        return pinRetainedReferenceEntry({
          root: physical,
          relative,
          directory,
          sid,
          retainedPins: pins,
          authorize: current,
        });
      },
      attestDatabase: async (filename) => {
        expect(filename).toBe(project.paths.database);
        await current();
      },
      close: () => {
        expect(pins.size).toBe(0);
        live = false;
      },
    };
    seam.work = work;
    policy = nativeCapturePolicy(work);
    const issue = policy.issueReferenceOffline;
    const issued: OperationContext[] = [];
    policy = {
      ...policy,
      issueReferenceOffline: async (input) => {
        expect(input.write).toBe(false);
        expect(input.signal).toBe(scope.signal);
        const value = await issue(input);
        expect(
          value.authorization.grants.every(
            (grant) => !grant.operations.includes("write"),
          ),
        ).toBe(true);
        issued.push(value);
        return value;
      },
    };
    for (const method of [
      "reserveReferenceRecovery",
      "beginReferenceConversion",
      "stageReferenceConversion",
      "commitReferenceConversion",
    ] as const)
      vi.spyOn(LocalStore.prototype, method).mockImplementation(() => {
        throw new Error("Readonly path attempted write");
      });
    const createFile = vi.spyOn(native, "createFile");
    const fault = process.env.DESIGN_STUDIO_INSPECTION_FAULT;
    let faultObserved = false;
    if (fault === "ineligible-job") {
      const metadata = LocalStore.prototype.referenceJobMetadata;
      vi.spyOn(LocalStore.prototype, "referenceJobMetadata").mockImplementation(
        async function (this: LocalStore, ...args) {
          const value = await metadata.apply(this, args);
          if (
            value.status === "complete" &&
            value.value?.record.job.id.startsWith("diagnostic_")
          ) {
            value.value.record.handlerId = "synthetic-ineligible-handler";
            faultObserved = true;
          }
          return value;
        },
      );
    }
    if (fault === "history-coexistence") {
      const inspect = ProjectFileSystem.prototype.inspectRetainedReference;
      vi.spyOn(
        ProjectFileSystem.prototype,
        "inspectRetainedReference",
      ).mockImplementation(async function (
        this: ProjectFileSystem,
        input,
        context,
      ) {
        if (!("conversionEvidence" in handoff))
          throw new Error("Missing synthetic writer output descriptor.");
        const evidence = parseContract(
          "ArtifactReference",
          JSON.stringify(handoff.conversionEvidence),
          "json",
        );
        const artifact = required(
          input.artifacts.find((a) => a.sha256 === evidence.sha256),
        );
        // Only the inventory-input seam is faulted; authentic v7 records stay untouched.
        input.history = [
          ...input.history,
          {
            ...required(input.targets[0]),
            stagingId: "00000000-0000-0000-0000-000000000001",
            artifact,
          },
        ];
        faultObserved = true;
        return inspect.call(this, input, context);
      });
    }
    const open = LocalStore.open.bind(LocalStore);
    const openSpy = vi
      .spyOn(LocalStore, "open")
      .mockImplementation((options) => {
        expect(options.access).toBe("read-only");
        expect(options.referenceRecovery?.writer).toBeUndefined();
        return open(options);
      });
    if (
      fault === "fork-stage-deadline" ||
      fault === "fork-source-tamper" ||
      fault === "fork-close" ||
      fault === "fork-close-cancel" ||
      fault === "fork-close-deadline"
    ) {
      openSpy.mockRestore();
      await runTransferredForkFixture(
        work,
        {
          expectedJob: handoff.expectedJob,
          expectedRecovery: handoff.expectedRecovery,
          fixtureClockNowMs,
        },
        scope.signal,
        (value) => {
          seam.forkWorks.set(value.project, value);
        },
        (work) => cleanups.push(work),
      );
      return;
    }
    const runtime = await openNativeReferenceConversionInspection(project);
    cleanups.push(async () => {
      await runtime.close();
      expect(pins.size).toBe(0);
    });
    const input = {
      operation: "reference-conversion-inspect",
      requestId: "original",
      expectedJob: handoff.expectedJob,
      expectedRecovery: handoff.expectedRecovery,
    } as const;
    // The writer's explicit future epoch makes wall-time fallback fail even in slow runs.
    expect(policy.clock.now()).toBeLessThan(fixtureClockNowMs);
    // Only synthetic now crosses processes; real sleep/watch/deadline progress stays live.
    const readerClockStart = performance.now();
    vi.spyOn(policy.clock, "now").mockImplementation(
      () =>
        fixtureClockNowMs + Math.floor(performance.now() - readerClockStart),
    );
    const result = await runtime.execute(input, scope.signal);
    const expectedDiagnostic =
      fault === "ineligible-job"
        ? { stage: "ineligible-job" }
        : fault === "unknown-stage" ||
            fault === "unknown-blob" ||
            fault === "unknown-root"
          ? {
              stage: "inventory-invalid",
              inventoryFailure: {
                check:
                  fault === "unknown-stage"
                    ? "scan-stage-classification"
                    : fault === "unknown-blob"
                      ? "scan-blob-classification"
                      : "scan-root-entry-classification",
                category: "namespace",
              },
            }
          : fault === "history-coexistence"
            ? {
                stage: "inventory-invalid",
                inventoryFailure: {
                  check: "publication-shape",
                  category: "history-stage",
                  detail: "unproven-history-coexistence",
                },
              }
            : fault === "output-tamper"
              ? {
                  stage: "inventory-invalid",
                  inventoryFailure: {
                    check: "committed-size",
                    category: "committed-inventory",
                  },
                }
              : undefined;
    if (expectedDiagnostic) {
      expect(result).toMatchObject({
        status: "failed",
        reason: "integrity",
        inspection: {
          verification: "conversion-readonly-v1",
          state: "blocked",
          detail: "verification-incomplete",
          diagnostic: expectedDiagnostic,
        },
      });
      expect(result.inspection?.diagnostic).toEqual(expectedDiagnostic);
      expect(result.error?.code).toBe(
        fault === "unknown-stage" ||
          fault === "unknown-blob" ||
          fault === "unknown-root" ||
          fault === "ineligible-job"
          ? "ACTION_REQUIRED"
          : "ARTIFACT_INTEGRITY",
      );
      expect(result.inspection?.proof).toBeUndefined();
      expect(result.inspection?.conversion).toBeUndefined();
      if (fault === "ineligible-job" || fault === "history-coexistence")
        expect(faultObserved).toBe(true);
      expect(createFile).not.toHaveBeenCalled();
      expect(pins.size).toBe(0);
      expect(result.inputAccounting?.networkBytes).toBe(0);
      expect(canonicalBytes(result).length).toBeLessThanOrEqual(8192);
      console.log(
        JSON.stringify({
          scope: "authentic-v7-to-v8-blocked-diagnostic",
          fault,
          diagnostic: result.inspection?.diagnostic,
          privateBytes: result.inputAccounting?.privateBytes,
          nativePinsAndDatabase: "real",
          faultSeam:
            fault === "ineligible-job" || fault === "history-coexistence"
              ? "synthetic-read-result-only"
              : "owned-synthetic-file-before-readonly-snapshot",
        }),
      );
      return;
    }
    if (
      "writerOutcome" in handoff &&
      handoff.writerOutcome === "abrupt-after-stage"
    ) {
      expect(result.status).toBe("failed");
      expect(result.inspection).toEqual({
        verification: "conversion-readonly-v1",
        state: "blocked",
        detail: "verification-incomplete",
      });
      expect(createFile).not.toHaveBeenCalled();
      expect(pins.size).toBe(0);
      return;
    }
    expect(handoff).toMatchObject({ events: 10 });
    expect(result.status, JSON.stringify(result)).toBe("complete");
    expect(result.inspection?.state).toBe("committed");
    const observed = required(result.inspection);
    const proof = required(observed.proof);
    const { proofSha256, ...facts } = proof;
    expect(proofSha256).toBe(
      hashBytes(
        canonicalBytes({
          ...facts,
          state: observed.state,
          conversion: observed.conversion,
        }),
      ),
    );
    expect(proof.recoveryPolicySha256).toBe(REFERENCE_OFFLINE_POLICY_SHA256);
    expect(proof.inspectionPolicySha256).toBe(
      REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
    );
    expect(proof.recoveryReceiptSha256).toBe(handoff.expectedRecovery);
    expect(issued.length).toBeGreaterThan(0);
    expect(createFile).not.toHaveBeenCalled();
    expect(result.inputAccounting?.networkBytes).toBe(0);
    expect(result.inputAccounting?.privateBytes).toBeLessThanOrEqual(26214400);
    expect(canonicalBytes(result).length).toBeLessThanOrEqual(8192);
    console.log(
      JSON.stringify({
        scope: "authentic-v7-to-v8-readonly",
        status: "complete",
        writerCommit: "9bcfbaadca45ac6f4ffb4fcd55e8abd5569fad9a",
        historicalPolicy: proof.recoveryPolicySha256,
        inspectionPolicy: proof.inspectionPolicySha256,
        pins: pins.size,
        privateBytes: result.inputAccounting?.privateBytes,
        nativePinsAndDatabase: "real",
        installationAndCurrentAuthority: "synthetic-work-seam",
      }),
    );
  },
);
async function offlineStageFixture(
  native = false,
  durabilityReads = false,
  telemetry?: "conversion-provenance" | "converted-archive",
) {
  const f = await fixture({
    diagnostic: true,
    fixedClock: true,
    offline: native,
    durabilityReads,
    ...(telemetry ? { telemetry } : {}),
  });
  await legacyReferenceFailure(f);
  const approval = await f.diagnosticApprove();
  const publish = vi
    .spyOn(ProjectFileSystem.prototype, "publish")
    .mockRejectedValueOnce(
      new HostBoundaryError("INPUT_LIMIT", "Synthetic stage-only interruption"),
    );
  expect((await f.diagnosticDownload(approval)).status).toBe("interrupted");
  publish.mockRestore();
  f.advanceClock(40000);
  const metadata = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  const command = {
    requestId: "original",
    expectedJob: required(metadata.value?.metadata?.jobSha256),
  };
  const before = native ? undefined : await f.observeOffline();
  const plan = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply-plan",
  });
  expect(plan.status, JSON.stringify(plan)).toBe("complete");
  return { f, command, before, plan };
}

it.skipIf(
  !nativeRetainedMode || !process.env.DESIGN_STUDIO_SYNTHETIC_OFFLINE_CRASH,
)("cold offline recovery crash fixture", async () => {
  const point = process.env.DESIGN_STUDIO_SYNTHETIC_OFFLINE_CRASH;
  if (
    !point ||
    ![
      "reference-after-reserve",
      "reference-after-stage",
      "reference-before-receipt",
      "after-commit",
    ].includes(point)
  )
    throw new Error("Unknown synthetic crash boundary.");
  const { f, command, plan } = await offlineStageFixture(true);
  f.setFault(point);
  await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  throw new Error("Synthetic crash boundary was not reached.");
});

for (const gap of [
  "same-bytes-new-inode",
  "same-length-different-bytes",
] as const) {
  it.skipIf(!nativeRetainedMode)(
    `native migration backup rejects ${gap}`,
    async () => {
      const { f, command, plan } = await offlineStageFixture(true);
      const native = await loadNative();
      const publish = WindowsNtfsPublisher.prototype.publish;
      let injected = false;
      vi.spyOn(WindowsNtfsPublisher.prototype, "publish").mockImplementation(
        async function (
          this: WindowsNtfsPublisher,
          source,
          destination,
          length,
          guard,
        ) {
          if (source.endsWith(".sqlite.pending")) {
            const bytes = await readFile(source);
            if (gap === "same-bytes-new-inode") {
              const replacement = `${source}.replacement`;
              native.createFile(
                replacement,
                native.principal(),
                Buffer.alloc(0),
              );
              await writeFile(replacement, bytes);
              await rename(replacement, source);
            } else {
              bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
              await writeFile(source, bytes);
            }
            injected = true;
          }
          return publish.call(this, source, destination, length, guard);
        },
      );
      const result = await f.runOffline({
        ...command,
        operation: "reference-recovery-apply",
        expectedProof: required(plan.plan?.proofSha256),
        confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
      });
      expect(injected, JSON.stringify(result)).toBe(true);
      expect(result.status, JSON.stringify(result)).toBe("failed");
      expect(result.error?.code).toBe("ARTIFACT_INTEGRITY");
      const observed = await f.observeOffline();
      expect(observed.schema).toBe(4);
      expect(observed.controls).toHaveLength(0);
      expect(
        (await readdir(path.dirname(f.project.paths.database))).some((n) =>
          /\.migration-v4-.*\.sqlite$/.test(n),
        ),
      ).toBe(true);
      expect(f.readPins).toBe(0);
    },
  );
}

it.each([
  ["migration-before-commit", 0, 0],
  ["reference-after-reserve", 1, 0],
  ["reference-after-intent", 1, 1],
  ["reference-after-stage", 1, 1],
  ["reference-before-receipt", 1, 7],
] as const)(
  "retains exact old history across offline fault %s",
  async (fault, controls, events) => {
    const { f, command, before, plan } = await offlineStageFixture();
    if (!before) throw new Error("Missing synthetic preimage.");
    f.setFault(fault);
    const result = await f.runOffline({
      ...command,
      operation: "reference-recovery-apply",
      expectedProof: required(plan.plan?.proofSha256),
      confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
    });
    expect(result.status).toBe("failed");
    f.setFault();
    const after = await f.observeOffline();
    expect(after.controls).toHaveLength(controls);
    expect(after.events).toHaveLength(events);
    for (const table of ["jobs", "job_resources", "job_stages"])
      expect(after.rows[table]).toEqual(before.rows[table]);
    for (const file of before.files) expect(after.files).toContainEqual(file);
    const inspected = await f.runOffline({
      ...command,
      operation: "reference-recovery-apply-plan",
    });
    if (events === 0) {
      expect(inspected.status, JSON.stringify(inspected)).toBe("complete");
      const resumed = await f.runOffline({
        ...command,
        operation: "reference-recovery-apply",
        expectedProof: required(inspected.plan?.proofSha256),
        confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
      });
      expect(resumed.status, JSON.stringify(resumed)).toBe("complete");
    } else {
      expect(inspected.status).toBe("failed");
      expect(inspected.reason).toBe("recovery-blocked");
      expect((await f.observeOffline()).events).toEqual(after.events);
    }
    expect(f.readPins).toBe(0);
  },
);

it("denies same-byte target replacement across the offline read-to-write handoff before reservation", async () => {
  const { f, command, before, plan } = await offlineStageFixture();
  if (!before) throw new Error("Missing synthetic preimage.");
  const create = vi.mocked(ProjectFileSystem.create).getMockImplementation();
  if (!create) throw new Error("Synthetic filesystem seam missing.");
  let replaced = false;
  vi.spyOn(ProjectFileSystem, "create").mockImplementation(async (options) => {
    if (!replaced && options.roots.some((r) => r.access === "read-write")) {
      const old = required(before.files[0]);
      const target = path.join(
        f.project.paths.artifacts,
        ...old.name.split("/"),
      );
      const bytes = await readFile(target);
      const temp = `${target}.replacement`;
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, target);
      replaced = true;
    }
    return create(options);
  });
  const result = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(replaced).toBe(true);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("CONFLICT");
  expect((await f.observeOffline()).controls).toHaveLength(0);
});

it("denies stale offline proof before schema or publication changes", async () => {
  const { f, command, before } = await offlineStageFixture();
  if (!before) throw new Error("Missing synthetic preimage.");
  const denied = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: "0".repeat(64),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(denied.status).toBe("failed");
  expect(denied.reason).toBe("proof-changed");
  expect(await f.observeOffline()).toEqual(before);
});

it("joins independent offline proof closures and requires close-only recovery after a pin failure", async () => {
  const { f, command } = await offlineStageFixture();
  f.failInventoryClose();
  const error = await f
    .runOffline({ ...command, operation: "reference-recovery-apply-plan" })
    .then(
      () => {
        throw new Error("Expected closure failure.");
      },
      (error: unknown) => error,
    );
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof NativeCaptureCleanupRequired)) throw error;
  expect(seam.work?.isCurrent()).toBe(true);
  await error.close();
  expect(seam.work?.isCurrent()).toBe(false);
  expect(f.readPins).toBe(0);
});

it("cancels offline publication on the original signal and retains exact history", async () => {
  const { f, command, before, plan } = await offlineStageFixture();
  if (!before) throw new Error("Missing synthetic preimage.");
  const abort = new AbortController();
  const stage = LocalStore.prototype.stageReferenceRecovery;
  vi.spyOn(LocalStore.prototype, "stageReferenceRecovery").mockImplementation(
    async function (this: LocalStore, ...args) {
      abort.abort();
      return stage.apply(this, args);
    },
  );
  const result = await f.runOffline(
    {
      ...command,
      operation: "reference-recovery-apply",
      expectedProof: required(plan.plan?.proofSha256),
      confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
    },
    abort.signal,
  );
  expect(result.status).toBe("cancelled");
  expect(result.error?.code).toBe("CANCELLED");
  const after = await f.observeOffline();
  expect(after.controls).toHaveLength(1);
  expect(after.events).toHaveLength(0);
  expect(after.files).toEqual(before.files);
  expect(after.rows.jobs).toEqual(before.rows.jobs);
  expect(f.readPins).toBe(0);
});

it("reports the real receipt when offline final inspection fails after commit", async () => {
  const { f, command, plan } = await offlineStageFixture();
  const inspect = ProjectFileSystem.prototype.inspectRetainedReference;
  vi.spyOn(
    ProjectFileSystem.prototype,
    "inspectRetainedReference",
  ).mockImplementation(async function (
    this: ProjectFileSystem,
    input,
    context,
  ) {
    if (input.recoveredTargetArtifacts?.length)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Synthetic final inspection limit",
      );
    return inspect.call(this, input, context);
  });
  const result = await f.runOffline({
    ...command,
    operation: "reference-recovery-apply",
    expectedProof: required(plan.plan?.proofSha256),
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  });
  expect(result.status).toBe("failed");
  expect(result.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.effectiveReference).toBeUndefined();
  expect(result.error?.message).toContain("receipt committed");
  expect((await f.observeOffline()).events).toHaveLength(8);
});

it.each(["approval", "source", "bounds", "dimensions", "png"] as const)(
  "rejects physically hashed retained output with forged %s evidence rather than trusting stage metadata",
  async (kind) => {
    const { f, expectedJob, jobId } = await interruptedValidationFixture();
    await f.runtime.close();
    rewriteSyntheticRetainedEvidence(
      f.project.paths.database,
      path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      jobId,
      (evidence, image) => {
        if (kind === "approval")
          evidence.request.approval.sha256 = "f".repeat(64);
        if (kind === "source")
          evidence.request.binding.sourceVersion = "forged";
        if (kind === "bounds") required(evidence.reference).bounds.width = 3;
        if (kind === "dimensions") required(evidence.reference).pixelWidth = 3;
        if (kind === "png")
          image[image.length - 1] = (image[image.length - 1] ?? 0) ^ 1;
      },
      canonicalBytes,
    );
    f.image.mockClear();
    const result = await f.validateRetained(expectedJob);
    expect(result.status, JSON.stringify(result)).toBe("failed");
    expect(result.reason).toBe("evidence-invalid");
    expect(result.inventoryFailure).toBeUndefined();
    expect(result.value).toBeUndefined();
    expect(f.readPins).toBe(0);
    expect(f.image).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("rejects same-byte source inode replacement between verified proof reads and retained inventory", async () => {
  const { f, expectedJob } = await interruptedValidationFixture();
  const inspect = ProjectFileSystem.prototype.inspectRetainedReference;
  const replaced = vi
    .spyOn(ProjectFileSystem.prototype, "inspectRetainedReference")
    .mockImplementationOnce(async function (this: ProjectFileSystem, ...args) {
      await f.corruptNodes("replace-after-proof");
      return inspect.apply(this, args);
    });
  try {
    const result = await f.validateRetained(expectedJob);
    expect(result).toMatchObject({
      status: "failed",
      reason: "inventory-invalid",
      error: { code: "ARTIFACT_INTEGRITY" },
      inventoryFailure: {
        check: "proof-native-identity",
        category: "original-proof",
      },
    });
    expect(result.value).toBeUndefined();
    expect(f.readPins).toBe(0);
  } finally {
    replaced.mockRestore();
  }
});

it.each([
  "tagged",
  "shape-detail",
  "cancelled",
  "unclassified",
  "invalid-tag",
] as const)(
  "retained inventory failure projection stays local and closed: %s",
  async (kind) => {
    const { f, expectedJob } = await interruptedValidationFixture();
    const inspect = vi
      .spyOn(ProjectFileSystem.prototype, "inspectRetainedReference")
      .mockImplementationOnce(async (_input, context) => {
        const outcome = {
          schemaVersion: "1.0" as const,
          projectId: context.projectId,
          requestId: context.requestId,
          status:
            kind === "cancelled" ? ("cancelled" as const) : ("failed" as const),
          error: {
            code:
              kind === "cancelled"
                ? ("CANCELLED" as const)
                : ("ARTIFACT_INTEGRITY" as const),
            message:
              "Synthetic private path/SID/exception must never be projected.",
            retryable: false,
            diagnosticIds: [],
          },
          diagnosticIds: [],
        };
        if (kind !== "unclassified")
          Reflect.set(outcome, "inventoryFailure", {
            check:
              kind === "shape-detail"
                ? "publication-shape"
                : "missing-recorded-entry",
            category: "history-stage",
            ...(kind === "shape-detail"
              ? { detail: "unproven-history-coexistence" }
              : {}),
            ...(kind === "invalid-tag" ? { path: "synthetic-private" } : {}),
          });
        return outcome;
      });
    try {
      const result = await f.validateRetained(expectedJob);
      expect(result.status).toBe(kind === "cancelled" ? "cancelled" : "failed");
      expect(result.error?.code).toBe(
        kind === "cancelled" ? "CANCELLED" : "ARTIFACT_INTEGRITY",
      );
      expect(result.error?.retryable).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.inventoryFailure).toEqual(
        kind === "shape-detail"
          ? {
              check: "publication-shape",
              category: "history-stage",
              detail: "unproven-history-coexistence",
            }
          : kind === "tagged"
            ? { check: "missing-recorded-entry", category: "history-stage" }
            : undefined,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-private|private path|SID\/exception/,
      );
      expect(f.readPins).toBe(0);
    } finally {
      inspect.mockRestore();
    }
  },
);

it("post-decode recheck failure does not invent an initial inventory diagnostic", async () => {
  const { f, expectedJob } = await interruptedValidationFixture();
  const original = ProjectFileSystem.prototype.inspectRetainedReference;
  const inspect = vi
    .spyOn(ProjectFileSystem.prototype, "inspectRetainedReference")
    .mockImplementationOnce(async function (this: ProjectFileSystem, ...args) {
      const result = await original.apply(this, args);
      expect(result.status).toBe("complete");
      expect(result.inventoryFailure).toBeUndefined();
      if (result.status === "complete")
        result.value.check = async () => {
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Synthetic later native identity changed.",
          );
        };
      return result;
    });
  try {
    const result = await f.validateRetained(expectedJob);
    expect(result).toMatchObject({
      status: "failed",
      reason: "state-changed",
      error: { code: "ARTIFACT_INTEGRITY", retryable: false },
    });
    expect(result.value).toBeUndefined();
    expect(result.inventoryFailure).toBeUndefined();
    expect(f.readPins).toBe(0);
  } finally {
    inspect.mockRestore();
  }
});

it("owns recovery plan input before asynchronous digest checks and final proof construction", async () => {
  const { f, expectedJob } = await interruptedValidationFixture();
  const validation = await f.openValidation();
  const work = required(seam.work);
  const context = await work.policy.issueReferenceValidation({
    jobId: "validation_readonly",
    requestId: "readonly_grants",
    jobReads: [],
    deadline: new Date(work.policy.clock.now() + 30000).toISOString(),
    signal: new AbortController().signal,
  });
  expect(context.authorization.egress).toBe("deny");
  expect(context.budget.maxExternalCalls).toBe(0);
  expect(
    context.authorization.grants.every((grant) =>
      grant.operations.every((operation) => operation === "read"),
    ),
  ).toBe(true);
  for (const scope of [
    {
      resourceKind: "artifact" as const,
      resourceId: f.project.artifactRootId,
      operation: "write" as const,
    },
    {
      resourceKind: "job" as const,
      resourceId: "validation_readonly",
      operation: "write" as const,
    },
    {
      resourceKind: "credential" as const,
      resourceId: f.project.reference.id,
      operation: "credential-use" as const,
    },
    {
      resourceKind: "provider" as const,
      resourceId: "figma_rest",
      operation: "read" as const,
    },
    {
      resourceKind: "source" as const,
      resourceId: "synthetic",
      operation: "reference-download" as const,
    },
  ])
    expect(() =>
      authorizeOperation(
        context,
        { projectId: f.project.projectId, ...scope },
        work.policy.verify,
      ),
    ).toThrow();
  const command = {
    operation: "reference-recovery-plan" as const,
    requestId: "original",
    expectedJob,
  };
  const original = LocalStore.prototype.referencePublicationState;
  const mutated = vi
    .spyOn(LocalStore.prototype, "referencePublicationState")
    .mockImplementation(async function (this: LocalStore, context) {
      const result = await original.call(this, context);
      command.expectedJob = "f".repeat(64);
      command.requestId = "changed-after-digest-check";
      return result;
    });

  try {
    const result = await validation.execute(
      command,
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result)).toBe("complete");
    expect(result.requestId).toBe("original");
    expect(result.value?.jobSha256).toBe(expectedJob);
    expect(JSON.stringify(result)).not.toContain("changed-after-digest-check");
  } finally {
    mutated.mockRestore();
    await validation.close();
  }
});

it("rejects changed outer diagnostic effects even when the inner Job digest still matches", async () => {
  const { f, expectedJob } = await interruptedValidationFixture();
  const validation = await f.openValidation();
  let kind: "reserved" | "unknown" | "extra" | "actual" = "reserved";
  const change = (record: import("@design-studio/storage").StoredJob) => {
    if (!record.job.id.startsWith("diagnostic_")) return;
    const effect = required(record.effects[0]);
    if (kind === "extra") record.effects.push(structuredClone(effect));
    else if (kind === "actual") required(effect.actual).externalCalls = 0;
    else effect.state = kind;
  };
  const metadata = LocalStore.prototype.referenceJobMetadata;
  const state = LocalStore.prototype.referencePublicationState;
  vi.spyOn(LocalStore.prototype, "referenceJobMetadata").mockImplementation(
    async function (this: LocalStore, ...args) {
      const result = await metadata.apply(this, args);
      if (result.status === "complete" && result.value)
        change(result.value.record);
      return result;
    },
  );
  vi.spyOn(
    LocalStore.prototype,
    "referencePublicationState",
  ).mockImplementation(async function (this: LocalStore, ...args) {
    const result = await state.apply(this, args);
    if (result.status === "complete")
      for (const record of result.value.jobs) change(record);
    return result;
  });
  try {
    for (const value of ["reserved", "unknown", "extra", "actual"] as const) {
      kind = value;
      expect(
        await validation.execute(
          {
            operation: "reference-recovery-plan",
            requestId: "original",
            expectedJob,
          },
          new AbortController().signal,
        ),
      ).toMatchObject({
        status: "failed",
        reason: "ineligible-job",
        inputAccounting: { privateBytes: 0, networkBytes: 0 },
      });
    }
  } finally {
    await validation.close();
  }
});

it.each([false, true])(
  "retains failed validation cleanup ownership and preserves primary failure=%s",
  async (failDecoder) => {
    const { f, expectedJob } = await interruptedValidationFixture();
    const validation = await f.openValidation();
    const closeReader = vi.spyOn(ReferenceReader.prototype, "close");
    if (failDecoder)
      vi.spyOn(ReferenceReader.prototype, "png").mockRejectedValueOnce(
        new HostBoundaryError("ASSET_INVALID", "Synthetic decoder failure"),
      );
    f.failInventoryClose();
    const command = {
      operation: "reference-recovery-plan" as const,
      requestId: "original",
      expectedJob,
    };
    const failure = await validation
      .execute(command, new AbortController().signal)
      .then(
        () => {
          throw new Error("Expected failed cleanup");
        },
        (error: unknown) => error,
      );
    const detail =
      failure instanceof Error && failure.cause instanceof AggregateError
        ? failure.cause.errors.map(String).join("; ")
        : String(failure);
    expect(failure, detail).toMatchObject({
      operationCode: failDecoder ? "ASSET_INVALID" : "INTERRUPTED",
      cleanupCode: "INTERRUPTED",
    });
    expect(closeReader).toHaveBeenCalledTimes(2);
    expect(f.readPins).toBe(1);
    await expect(
      validation.execute(command, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await validation.close();
    expect(f.readPins).toBe(0);
    await validation.close();
  },
);

it.each(["private", "network"] as const)(
  "keeps exact aggregate and EOF boundaries closed for %s input",
  (kind) => {
    const input = new ReferenceInput();
    input.phase = "commit";
    input.reserveRead(26214400 - 2);
    input.reserveNetwork(1);
    if (kind === "private") input.reserveRead(1);
    else input.reserveNetwork(1);
    expect(input.privateBytes + input.networkBytes).toBe(26214400);
    expect(() =>
      kind === "private" ? input.reserveRead(1) : input.reserveNetwork(1),
    ).toThrow();
    expect(input.snapshot().rejected).toEqual({
      kind,
      bytes: 1,
      limit: "aggregate",
      phase: "commit",
    });
    expect(input.privateBytes + input.networkBytes).toBe(26214400);
  },
);

it("reports per-read and invalid charges without accepting unmetered bytes", () => {
  const input = new ReferenceInput();
  input.maximumFileBytes = 262144;
  expect(() => input.reserveRead(262145)).toThrow();
  expect(input.snapshot().rejected).toMatchObject({
    limit: "per-read",
    bytes: 262145,
  });
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => input.reserveNetwork(value)).toThrow();
  expect(input.privateBytes + input.networkBytes).toBe(0);
});

it.each([false, true])(
  "inspects only closed derived-slot metadata without artifact reads, interrupted=%s",
  async (interrupted) => {
    const f = await fixture({ diagnostic: true });
    await legacyReferenceFailure(f);
    const approved = await f.diagnosticApprove();
    if (interrupted) f.setFault("job-after-artifacts");
    const result = await f.diagnosticDownload(approved);
    f.setFault();
    expect(result.status).toBe(interrupted ? "interrupted" : "complete");
    const defaultInspection = await f.run({
      operation: "reference-diagnostic-inspect",
      requestId: "original",
    });
    expect(defaultInspection.value).toEqual(result.value);
    expect(defaultInspection.value?.metadata).toBeUndefined();
    const before = await f.blobs();
    f.reads.length = 0;
    seam.physicalReads = 0;
    const inspect = () =>
      f.run({
        operation: "reference-diagnostic-inspect",
        requestId: "original",
        inspection: "metadata-only",
      });
    const inspected = await inspect();
    expect(inspected.status).toBe(interrupted ? "interrupted" : "complete");
    expect(inspected.value).toEqual({
      phase: interrupted ? "admitted" : "completed",
      consumed: true,
      metadata: {
        verification: "metadata-only",
        jobId: result.value?.job?.id,
        jobSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: interrupted ? "interrupted" : "completed",
        attempt: 1,
        ...(interrupted ? { errorCode: "INTERNAL_ERROR" } : {}),
        usage: {
          inputBytes: expect.any(Number),
          outputBytes: expect.any(Number),
          externalCalls: 1,
          modelTokens: 0,
          costMicros: 0,
        },
        effects: [
          {
            id: "reference-image-get",
            state: "settled",
            reserved: {
              inputBytes: 0,
              outputBytes: 0,
              externalCalls: 1,
              modelTokens: 0,
              costMicros: 0,
            },
            actual: {
              inputBytes: 0,
              outputBytes: 0,
              externalCalls: 1,
              modelTokens: 0,
              costMicros: 0,
            },
          },
        ],
        stages: expect.arrayContaining([
          expect.objectContaining({
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            byteLength: expect.any(Number),
            disposition: interrupted ? "recovery-needed" : "retained",
          }),
        ]),
        receiptPresent: !interrupted,
      },
    });
    expect(f.reads).toHaveLength(0);
    const closed = {
      operation: "reference-diagnostic-plan" as const,
      requestId: "original",
      inspection: "metadata-only" as const,
    };
    expect(await f.run(closed)).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT" },
    });
    const foreign = {
      operation: "reference-diagnostic-inspect" as const,
      requestId: "original",
      inspection: "metadata-only" as const,
      projectId: "foreign",
    };
    expect(await f.run(foreign)).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT" },
    });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await f.run(
        {
          operation: "reference-diagnostic-inspect",
          requestId: "original",
          inspection: "metadata-only",
        },
        cancelled.signal,
      ),
    ).toMatchObject({ status: "cancelled" });
    expect(seam.physicalReads).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThan(8192);
    expect(JSON.stringify(inspected)).not.toMatch(
      /synthetic-only|https:|blobs|paths|headers|selectionUrl/,
    );
    expect(await f.blobs()).toEqual(before);
    await f.reopen();
    f.reads.length = 0;
    expect((await inspect()).value).toEqual(inspected.value);
    expect(f.reads).toHaveLength(0);
    expect(
      await f.run({
        operation: "reference-diagnostic-inspect",
        requestId: required(result.value?.job?.id),
        inspection: "metadata-only",
      }),
    ).toMatchObject({ status: "failed" });
    f.deny();
    expect(await inspect()).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN" },
    });

    expect(f.image).toHaveBeenCalledTimes(2);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("keeps the input meter active through post-commit inspection and reports a real receipt separately", async () => {
  const f = await fixture({ diagnostic: true, nodeBytes: 1200000 });
  await legacyReferenceFailure(f);
  const approval = await f.diagnosticApprove();
  const nodes = required(approval.value?.proposal?.binding.nodes);
  const contract = ReferenceReader.prototype.contract;
  const excess = vi
    .spyOn(ReferenceReader.prototype, "contract")
    .mockImplementation(async function (this: ReferenceReader, ...args) {
      if (this.input.phase === "inspection")
        for (let i = 0; i < 30; i++) await this.json(nodes, 26214400);
      return contract.apply(this, args);
    });
  f.reads.length = 0;
  seam.physicalReads = 0;
  const result = await f.diagnosticDownload(approval);
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "INPUT_LIMIT" },
    inputAccounting: {
      phase: "inspection",
      rejected: {
        kind: "private",
        limit: "aggregate",
        phase: "inspection",
      },
    },
  });
  const charged = f.reads
    .filter((read) => read.allowed)
    .reduce((sum, read) => sum + read.bytes, 0);
  expect(result.inputAccounting?.privateBytes).toBe(charged);
  expect(seam.physicalReads).toBeLessThanOrEqual(charged);
  expect(
    charged + required(result.inputAccounting).networkBytes,
  ).toBeLessThanOrEqual(26214400);
  expect(result.value?.receipt).toBeUndefined();
  excess.mockRestore();
  f.reads.length = 0;
  const inspected = await f.run({
    operation: "reference-diagnostic-inspect",
    requestId: "original",
    inspection: "metadata-only",
  });
  expect(inspected.value?.metadata).toMatchObject({
    status: "completed",
    receiptPresent: true,
  });
  expect(f.reads).toHaveLength(0);
  expect(f.image).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "consumes exactly one server-derived diagnostic slot, including failed successor=%s",
  async (failSuccessor) => {
    const f = await fixture({ diagnostic: true });
    const predecessor = await legacyReferenceFailure(f);
    f.advanceClock(300001);
    const originalBlobs = await f.blobs();
    const approved = await f.diagnosticApprove();
    expect(approved.value?.proposal?.diagnosticPredecessor?.jobId).toBe(
      predecessor.value?.job?.id,
    );
    expect(approved.value?.proposal?.binding.originalRequestId).toBe(
      "original",
    );
    expect(approved.value?.proposal?.binding.acquisitionId).not.toBe(
      predecessor.value?.job?.id,
    );
    expect(f.image).toHaveBeenCalledTimes(1);
    if (failSuccessor)
      f.image.mockResolvedValue({
        status: 200,
        bytes: Buffer.from("<html>synthetic</html>"),
        mediaType: "application/octet-stream",
      });
    const result = await f.diagnosticDownload(approved);
    expect(result.status, JSON.stringify(result)).toBe(
      failSuccessor ? "unavailable" : "complete",
    );
    expect(result.value?.consumed).toBe(true);
    expect(result.value?.job?.attempt).toBe(1);
    expect(result.value?.evidence?.usage.externalCalls).toBe(1);
    expect(f.image).toHaveBeenCalledTimes(2);
    expect(
      (
        await f.run({
          operation: "reference-diagnostic-plan",
          requestId: required(result.value?.job?.id),
        })
      ).status,
    ).toBe("failed");
    await f.reopen();
    expect((await f.diagnosticDownload(approved)).value?.receipt).toEqual(
      result.value?.receipt,
    );
    const after = new Map(await f.blobs());
    for (const [hash, bytes] of originalBlobs)
      expect(after.get(hash)).toEqual(bytes);
    const original = await f.run({
      operation: "reference-inspect",
      requestId: "original",
    });
    expect(original.value?.job).toEqual(predecessor.value?.job);
    expect(original.value?.receipt).toEqual(predecessor.value?.receipt);
    expect(original.value?.evidence).toEqual(predecessor.value?.evidence);
    f.changeDiagnosticPolicy();
    expect((await f.diagnosticPlan()).status).toBe("failed");
    expect(f.image).toHaveBeenCalledTimes(2);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);
it("does not give legacy native capability diagnostic authority", async () => {
  const f = await fixture();
  await legacyReferenceFailure(f);
  expect(await f.diagnosticPlan()).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("refuses an acquired PNG as a diagnostic predecessor", async () => {
  const f = await fixture({ diagnostic: true });
  await f.download(await f.approve());
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it.each(["receipt", "unknown", "reserved"] as const)(
  "refuses diagnostic admission with %s predecessor evidence",
  async (kind) => {
    const f = await fixture({ diagnostic: true });
    await legacyReferenceFailure(f);
    f.corruptReferenceRead(kind);
    expect((await f.diagnosticPlan()).status).toBe("failed");
    expect(f.image).toHaveBeenCalledTimes(1);
  },
);
it("refuses a diagnostic successor while a synthetic publication remains uncommitted", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  await f.retainSyntheticStage();
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("requires current diagnostic authority and a fresh unexpired approval before contact", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  f.advanceClock(300001);
  expect((await f.diagnosticDownload(approved)).status).toBe("failed");
  f.deny();
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("burns the diagnostic slot on a terminal decoder limit without claiming a receipt", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const { header, signature } = await import(
    "../../assets/tests/png-fixtures.js"
  );
  f.image.mockResolvedValue({
    status: 200,
    mediaType: "image/png",
    bytes: Buffer.concat([signature, header(6, 8, 6553601), chunk("IEND")]),
  });
  const result = await f.diagnosticDownload(approved);
  expect(result).toMatchObject({
    status: "failed",
    error: {
      code: "RASTER_LIMIT",
      referenceDiagnostic: { reason: "raster-limit" },
    },
  });
  expect(result.value?.receipt).toBeUndefined();
  await f.reopen();
  expect(await f.diagnosticDownload(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true, phase: "admitted", job: { status: "failed" } },
  });
  expect(f.image).toHaveBeenCalledTimes(2);
});

it("rechecks settled same-source cooldowns before diagnostic admission", async () => {
  const f = await fixture({ diagnostic: true });
  const predecessor = await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  await f.seedCooldown(predecessor);
  expect(await f.diagnosticDownload(approved)).toMatchObject({
    status: "failed",
    error: { code: "RATE_LIMITED" },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("refuses old native capability and changed proof without network", async () => {
  const f = await fixture();
  expect(
    await f.run({
      operation: "reference-approve",
      requestId: "original",
      origin,
      expectedProof: "0".repeat(64),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
  f.deny();
  expect(await f.plan()).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  expect(f.image).not.toHaveBeenCalled();
});
it.each([
  "https://foreign.invalid/synthetic.png",
  `${origin}/synthetic.png?X-Amz-Date=20000101T000000Z&X-Amz-Expires=60`,
])(
  "refuses unsupported origin or provable expiry without acquisition: %s",
  async (url) => {
    const f = await fixture({ url });
    const plan = await f.plan();
    if (plan.status === "complete")
      expect(
        await f.run({
          operation: "reference-approve",
          requestId: "original",
          origin,
          expectedProof: required(plan.value?.proposal?.proofSha256),
          confirmation: REFERENCE_APPROVAL_CONFIRMATION,
        }),
      ).toMatchObject({ status: "failed" });
    else expect(plan.status).toBe("failed");
    expect(f.image).not.toHaveBeenCalled();
  },
);
it.each([
  [401, "AUTH_REQUIRED"],
  [403, "FORBIDDEN"],
] as const)(
  "records remote %s honestly and never refreshes or retries after reopen",
  async (status, code) => {
    const f = await fixture();
    const approval = await f.approve();
    f.image.mockRejectedValue(new CaptureHttpError(code, status));
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe("unavailable");
    expect(result.value?.evidence).toMatchObject({
      statusCode: status,
      referenceStatus: "unavailable",
    });
    await f.reopen();
    expect((await f.download(approval)).status).toBe("unavailable");
    expect(f.image).toHaveBeenCalledTimes(1);
    expect(f.api).not.toHaveBeenCalled();
  },
);
it("never retries a job with an unresolved effect after reopen or a different request", async () => {
  const f = await fixture();
  const approval = await f.approve();
  f.image.mockRejectedValue(new CaptureHttpError("PROVIDER_UNAVAILABLE"));
  await f.download(approval);
  await f.reopen();
  expect(await f.download(approval)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(
    await f.run({
      operation: "reference-download",
      requestId: "another",
      expectedApproval: required(approval.value?.approval?.sha256),
      confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("persists partial geometry rather than upgrading mismatched dimensions", async () => {
  const f = await fixture({ dimensions: 1 });
  const result = await f.download(await f.approve());
  expect(result.status, JSON.stringify(result)).toBe("partial");
  expect(result.value?.evidence?.missing).toContain(
    "reference-dimensions-mismatch",
  );
});
it.each([{ nodeVersion: "wrong-version" }, { renderNode: "7:8" }])(
  "rejects missing pinned source or mismatched selected image without contact: %j",
  async (options) => {
    const f = await fixture(options);
    expect(await f.plan()).toMatchObject({ status: "failed" });
    expect(f.image).not.toHaveBeenCalled();
  },
);
it("rejects changed original artifact bytes and expired approval without consuming a job", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.advanceClock(300001);
  expect(await f.download(approved)).toMatchObject({
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });
  expect(
    await f.run({ operation: "reference-inspect", requestId: "original" }),
  ).toMatchObject({ value: { consumed: false } });
  await f.corruptNodes();
  expect(await f.plan()).toMatchObject({ status: "failed" });
  expect(f.image).not.toHaveBeenCalled();
});
it("preserves proven no-effect failure as a consumed attempt rather than unknown or a new GET", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.image.mockRejectedValue(
    new CaptureHttpError("POLICY_FAILED", undefined, undefined, false),
  );
  const result = await f.download(approved);
  expect(result.status, JSON.stringify(result)).toBe("unavailable");
  expect(result.value?.evidence?.usage.externalCalls).toBe(0);
  expect(result.value?.consumed).toBe(true);
  await f.reopen();
  await f.download(approved);
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("cancels in-flight reference work, joins it and prevents a second admitted invocation", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.reads.length = 0;
  seam.physicalReads = 0;
  const abort = new AbortController();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.image.mockImplementation(async (_url, budget) => {
    entered?.();
    await new Promise<void>((resolve) => {
      budget.signal.addEventListener("abort", () => resolve(), { once: true });
      if (budget.signal.aborted) resolve();
    });
    throw new CaptureHttpError("CANCELLED");
  });
  const running = f.download(approved, abort.signal);
  await started;
  await expect(f.download(approved)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  abort.abort();
  const cancelled = await running;
  expect(cancelled.status).not.toBe("complete");
  const charged = f.reads
    .filter((read) => read.allowed)
    .reduce((sum, read) => sum + read.bytes, 0);
  expect(cancelled.inputAccounting?.privateBytes).toBe(charged);
  expect(seam.physicalReads).toBeLessThanOrEqual(charged);
  expect(charged).toBeLessThanOrEqual(26214400);
  await f.reopen();
  expect(await f.download(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("keeps post-network publication failure non-successful and non-replayable after reopen", async () => {
  const f = await fixture();
  const approved = await f.approve();
  const original = f.image.getMockImplementation();
  f.image.mockImplementation(async (...args) => {
    const result = await required(original)(...args);
    f.setFault("before-commit");
    return result;
  });
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  f.setFault();
  await f.reopen();
  expect(await f.download(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("renews only an unused expired approval through a fresh explicit proof, and replays lost responses without renewal", async () => {
  const f = await fixture();
  const first = await f.approve();
  const firstProof = required(first.value?.proposal?.proofSha256);
  const replay = await f.run({
    operation: "reference-approve",
    requestId: "original",
    origin,
    expectedProof: firstProof,
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  });
  expect(replay.value?.approval).toEqual(first.value?.approval);
  f.advanceClock(300001);
  expect((await f.download(first)).status).toBe("failed");
  const fresh = await f.plan();
  expect(fresh.value?.proposal).toMatchObject({
    approvalGeneration: 1,
    previousApproval: first.value?.approval,
  });
  expect(fresh.value?.proposal?.proofSha256).not.toBe(firstProof);
  const oldReplay = await f.run({
    operation: "reference-approve",
    requestId: "original",
    origin,
    expectedProof: firstProof,
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  });
  expect(oldReplay.value?.approval).toEqual(first.value?.approval);
  const renewal = {
    operation: "reference-approve" as const,
    requestId: "original",
    origin,
    expectedProof: required(fresh.value?.proposal?.proofSha256),
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  };
  const racing = await Promise.allSettled([f.run(renewal), f.run(renewal)]);
  const successful = racing.filter((entry) => entry.status === "fulfilled");
  expect(successful).toHaveLength(1);
  const renewed = required(successful[0]).value;
  expect(renewed.status, JSON.stringify(renewed)).toBe("complete");
  expect((await f.run(renewal)).value?.approval).toEqual(
    renewed.value?.approval,
  );
  expect((await f.download(first)).status).toBe("failed");
  expect((await f.download(renewed)).status).toBe("complete");
  f.advanceClock(300001);
  expect((await f.plan()).value?.proposal?.approvalGeneration).toBe(1);
  expect((await f.download(renewed)).status).toBe("complete");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("meters repeated receipt verification at the physical pre-read boundary before exceeding 25 MiB", async () => {
  const f = await fixture({ large: true });
  const proposal = ReferenceReader.prototype.proposal;
  vi.spyOn(ReferenceReader.prototype, "proposal").mockImplementation(
    async function (this: ReferenceReader, requestId) {
      const value = await proposal.call(this, requestId);
      for (let index = 0; index < 100; index++) {
        const receipt = await this.store.jobs.getJobReceipt(
          value.proposal.binding.originalJobId,
          this.context,
        );
        if (receipt.status !== "complete")
          throw new HostBoundaryError(
            receipt.error.code,
            "Synthetic repeated verification refused.",
          );
      }
      return value;
    },
  );
  const result = await f.plan();
  expect(result, JSON.stringify(f.reads)).toMatchObject({
    status: "failed",
    error: { code: "INPUT_LIMIT" },
  });
  const read = f.reads
    .filter((event) => event.allowed)
    .reduce((sum, event) => sum + event.bytes, 0);
  expect(read).toBeLessThanOrEqual(26214400);
  expect(seam.physicalReads).toBeLessThanOrEqual(read);
  expect(seam.physicalReads).toBeGreaterThan(25000000);
  expect(
    f.reads.filter((event) => event.bytes >= 300000 && event.allowed).length,
  ).toBeGreaterThanOrEqual(2);
  expect(f.reads.some((event) => !event.allowed)).toBe(true);
  expect(f.image).not.toHaveBeenCalled();
});

it("checks small control-artifact bounds before storage verification reads the body", async () => {
  const f = await fixture({ large: true });
  const proposal = ReferenceReader.prototype.proposal;
  vi.spyOn(ReferenceReader.prototype, "proposal").mockImplementation(
    async function (this: ReferenceReader, requestId) {
      const value = await proposal.call(this, requestId);
      f.reads.length = 0;
      seam.physicalReads = 0;
      await this.contract(
        "FigmaReferenceApproval",
        value.proposal.binding.nodes,
      );
      return value;
    },
  );
  expect(await f.plan()).toMatchObject({
    status: "failed",
    error: { code: "INPUT_LIMIT" },
  });
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]).toMatchObject({ allowed: false });
  expect(f.reads[0]?.bytes).toBeGreaterThan(262144);
  expect(seam.physicalReads).toBe(0);
  expect(f.image).not.toHaveBeenCalled();
});

it("rechecks current reference authority after the single verified read before using its bytes", async () => {
  const f = await fixture();
  const read = LocalStore.prototype.readVerified;
  const probe = vi
    .spyOn(LocalStore.prototype, "readVerified")
    .mockImplementation(async function (this: LocalStore, ...args) {
      const result = await read.apply(this, args);
      f.deny();
      return result;
    });
  expect(await f.plan()).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(f.image).not.toHaveBeenCalled();
});

it.each([
  "truncate",
  "grow",
  "replace",
  "hardlink",
  "swap",
  "junction",
] as const)(
  "rejects %s at the native single verified proof-read boundary",
  async (kind) => {
    const f = await fixture({ large: true });
    const planned = await f.plan();
    const nodes = required(planned.value?.proposal?.binding.nodes);
    const read = ReferenceReader.prototype.json;
    vi.spyOn(ReferenceReader.prototype, "json").mockImplementation(
      async function (this: ReferenceReader, reference, maximum) {
        if (reference.id === nodes.id) await f.corruptNodes(kind);
        return read.call(this, reference, maximum);
      },
    );
    const result = await f.plan();
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code:
          kind === "hardlink" || kind === "junction"
            ? "PATH_FORBIDDEN"
            : "ARTIFACT_INTEGRITY",
      },
    });
    expect(f.image).not.toHaveBeenCalled();
  },
);

it("shares actual private-read charges with image allowance and does not turn local revocation into remote denial", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.reads.length = 0;
  f.image.mockImplementation(async (_url, budget) => {
    const privateBytes = f.reads
      .filter((entry) => entry.allowed)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    expect(privateBytes).toBeGreaterThan(0);
    expect(() => budget.receive(26214400 - privateBytes + 1)).toThrow();
    f.deny();
    throw new CaptureHttpError("FORBIDDEN");
  });
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  expect(result.value?.evidence).toBeUndefined();
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("does not treat an input limit accompanying HTTP 403 as a remote-denial exception", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.image.mockRejectedValue(new CaptureHttpError("INPUT_LIMIT", 403));
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  expect(result.value?.evidence).toBeUndefined();
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("retains uncooperative service ownership and original wait failure across stop timeout and close-only retry", async () => {
  const f = await fixture();
  const approved = await f.approve();
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stops = vi.spyOn(JobService.prototype, "stop");
  const closeFiles = vi.spyOn(
    ProjectFileSystem.prototype,
    "closePreservingStages",
  );
  f.image.mockImplementation(async () => {
    enter?.();
    await released;
    throw new CaptureHttpError("PROVIDER_UNAVAILABLE");
  });
  vi.spyOn(JobService.prototype, "waitForAttempt").mockImplementationOnce(
    async () => {
      await entered;
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Synthetic original wait failure",
      );
    },
  );
  const running = f.download(approved);
  try {
    await entered;
    expect(await running).toMatchObject({
      status: "interrupted",
      error: { code: "INTERRUPTED" },
    });
    await expect(f.download(approved)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.runtime.execute(
        { operation: "inspect", requestId: "original" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.runtime.close()).rejects.toMatchObject({
      operationCode: "PROVIDER_UNAVAILABLE",
      cleanupCode: "INTERRUPTED",
    });
    expect(stops.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closeFiles).not.toHaveBeenCalled();
    release?.();
    await f.runtime.close();
    expect(closeFiles).toHaveBeenCalledTimes(1);
    expect(f.image).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await running;
    await f.runtime.close();
  }
});
