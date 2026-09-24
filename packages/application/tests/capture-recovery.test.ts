import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FigmaCaptureManifest,
  type FigmaCaptureRequest,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import { fakeComplete } from "@design-studio/contracts/testing";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
} from "@design-studio/figma-capture";
import * as figmaImport from "@design-studio/figma-import";
import { parseFigmaSelection } from "@design-studio/figma-import";
import { HostBoundaryError, ProjectFileSystem } from "@design-studio/host";
import { JobService } from "@design-studio/jobs";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import {
  type JobWorkerExpected,
  LocalStore,
  type StorageOptions,
  type StoredJob,
  type StoredJobStage,
} from "@design-studio/storage";
import { afterEach, aroundEach, expect, vi, it as vitestIt } from "vitest";
import * as referenceDecoder from "../../figma-capture/dist/decode.js";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { png } from "../../figma-capture/tests/support.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "../../project-host/src/capture-diagnostic-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../../project-host/src/capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../../project-host/src/capture-reference-profile.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "../../project-host/src/reference-offline-profile.js";
import { REFERENCE_VALIDATION_POLICY_SHA256 } from "../../project-host/src/reference-validation-profile.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import {
  addSyntheticCaptureProtection,
  addSyntheticStoppedCaptures,
  corruptSyntheticCapture,
  corruptSyntheticCaptureStage,
  mutateOpenSyntheticCapture,
  removeSyntheticCaptureProtection,
} from "../../storage/tests/capture-recovery-corruption.js";
import {
  closeSettledStores,
  joinSettledStores,
} from "../../storage/tests/lifetime.js";
import {
  syntheticBackupPin,
  syntheticImmutableSnapshot,
} from "../../storage/tests/support.js";
import {
  CAPTURE_RECOVERY_CONFIRMATION,
  nativeCaptureResources,
} from "../src/capture-recovery.js";
import {
  assembleNativeCapture,
  type NativeCaptureRuntime,
  NativeCaptureStartupCleanupRequired,
} from "../src/capture-runtime-internal.js";
import { RecoveryDecisions } from "../src/recovery.js";
import { ReferenceInput } from "../src/reference-input.js";
import {
  type NativeReferenceOfflineInput,
  openNativeReferenceOffline,
} from "../src/reference-offline.js";
import { ReferenceReader } from "../src/reference-proof.js";
import * as referencePublications from "../src/reference-publications.js";
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
} from "./capture-test-scope.js";

const seam = vi.hoisted(() => ({
  work: undefined as CaptureWork | undefined,
  onCurrent: undefined as (() => Promise<void>) | undefined,
  measureReads: false,
  physicalReads: 0,
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
  acquireCaptureWork: () => {
    if (!seam.work) throw new Error("Synthetic native owner missing");
    return seam.work;
  },
}));
vi.mock("../../project-host/dist/capture-work.js", () => ({
  assertCaptureWork: (work: CaptureWork) => {
    if (work !== seam.work) throw new Error("Synthetic native owner changed");
  },
}));
const cleanups: (() => Promise<void>)[] = [];
const it = ownCaptureTests(vitestIt);
aroundEach((run, context) => {
  if (cleanups.length)
    throw new Error("Previous capture fixture has not quiesced.");
  return inCaptureTest(new AsyncTestScope(context.signal), run);
});
afterEach(async () => {
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
    throw new AggregateError(errors, "Capture fixture cleanup did not settle.");
  vi.restoreAllMocks();
  seam.work = undefined;
  seam.onCurrent = undefined;
});
function value<T>(outcome: Outcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  if (outcome.status !== "complete") throw new Error("Expected complete");
  return outcome.value;
}
function required<T>(input: T | undefined): T {
  if (input === undefined) throw new Error("Missing synthetic value");
  return input;
}
function fence(record: StoredJob): JobWorkerExpected {
  const lease = required(record.job.lease);
  return {
    state: record.job.status,
    rowVersion: record.rowVersion,
    leaseId: lease.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    resources: record.resources,
  };
}
const call = {
  inputBytes: 0,
  outputBytes: 0,
  externalCalls: 1,
  modelTokens: 0,
  costMicros: 0,
};

function fixture(...args: Parameters<typeof createFixture>) {
  return ownCaptureWork(createFixture)(...args);
}

async function createFixture(
  retainStage = true,
  cooldown?: "future" | "unknown" | "elapsed",
  history: {
    repaired?: boolean;
    priorResourceUse?: boolean;
    stageCount?: number;
    committedStageBytes?: boolean;
    successorStageBytes?: boolean;
    fixedClock?: boolean;
  } = {},
) {
  const scope = captureTestScope();
  initializeImmutableSqlite(
    path.resolve(
      ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
    ),
  );
  const root = await mkdtemp(
    path.join(tmpdir(), "capture-recovery-synthetic-"),
  );
  const stores: LocalStore[] = [];
  const runtimes: NativeCaptureRuntime[] = [];
  const services: JobService[] = [];
  const stopRequests: Promise<
    { outcome: Awaited<ReturnType<JobService["stop"]>> } | { error: unknown }
  >[] = [];
  const validations: Awaited<
    ReturnType<typeof openNativeReferenceValidation>
  >[] = [];
  const offlines: Awaited<ReturnType<typeof openNativeReferenceOffline>>[] = [];
  const startupClosures: (() => Promise<void>)[] = [];
  cleanups.push(async () => {
    await scope.close();
    const stopped = await Promise.all(stopRequests.splice(0));
    for (const service of services) value(await service.stop());
    const stopErrors: unknown[] = [];
    for (const result of stopped) {
      try {
        if ("error" in result) throw result.error;
        value(result.outcome);
      } catch (error) {
        stopErrors.push(error);
      }
    }
    if (stopErrors.length)
      throw new AggregateError(
        stopErrors,
        "Original synthetic service stop failed.",
      );
    await joinSettledStores(stores);
    for (const close of startupClosures) await close();
    for (const validation of validations) await validation.close();
    for (const offline of offlines) await offline.close();
    for (const runtime of runtimes) await runtime.close();
    await closeSettledStores(stores);
    await rm(root, { recursive: true, force: true });
  });
  scope.signal.throwIfAborted();
  const artifacts = path.join(root, "artifacts");
  const outputs = path.join(root, "outputs");
  await mkdir(artifacts);
  await mkdir(outputs);
  const project = {
    projectId: "project_synthetic",
    artifactRootId: "artifacts_synthetic",
    paths: {
      database: path.join(root, "state.sqlite"),
      artifacts,
      outputs,
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
  const nativeBinding = path.resolve(
    ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
  );
  let runtime: NativeCaptureRuntime;
  let validation:
    | Awaited<ReturnType<typeof openNativeReferenceValidation>>
    | undefined;
  let validationMode = false;
  let offlineMode = false;
  let offline:
    | Awaited<ReturnType<typeof openNativeReferenceOffline>>
    | undefined;
  let clockOffset = 0;
  const fixedNow = history.fixedClock ? Date.now() : undefined;
  let store: LocalStore;
  let policy: ReturnType<typeof nativeCapturePolicy>;
  let credentialSha256 = "b".repeat(64);
  let admitted = true;
  let captureAllowed = false;
  let fault: string | undefined;
  let beforeCommit: (() => void) | undefined;
  let fixtureRecovery: RecoveryDecisions | undefined;
  let historicalClaim: StoredJob | undefined;
  const ready = vi.fn(async () => undefined);
  const vault = vi.fn();
  const create = ProjectFileSystem.create.bind(ProjectFileSystem);
  vi.spyOn(ProjectFileSystem, "create").mockImplementation((options) =>
    create({ ...options, publicationProfile: "portable-atomic" }),
  );
  // Logical publication acknowledgment for synthetic portable files only; not native durability evidence.
  vi.spyOn(
    ProjectFileSystem.prototype,
    "ensurePublicationDurable",
  ).mockImplementation(async (_root, _artifacts, context) =>
    fakeComplete(context, { durable: true }),
  );
  const openStore = LocalStore.open.bind(LocalStore);
  vi.spyOn(LocalStore, "open").mockImplementation(async (options) => {
    const jobs = required(options.jobs);
    store = await openStore({
      ...options,
      jobs: {
        ...jobs,
        authorizeRecovery: (...args) =>
          fixtureRecovery
            ? fixtureRecovery.authorize(...args)
            : jobs.authorizeRecovery(...args),
      },
      fault: (point) => {
        if (point === "before-commit") beforeCommit?.();
        if (point === fault) throw new Error("Synthetic storage interruption");
      },
    });
    stores.push(store);
    return store;
  });
  const open = async () => {
    scope.signal.throwIfAborted();
    let current = true;
    const work: CaptureWork = {
      project,
      actorId: project.principal.actorId,
      permissionScope: "synthetic",
      sqliteBinding: nativeBinding,
      policyId: "synthetic",
      policySha256: "a".repeat(64),
      imageOrigins: [],
      apiOrigins: ["https://api.figma.com"],
      get policy() {
        return policy;
      },
      current: async () => {
        if (!current)
          throw new HostBoundaryError("FORBIDDEN", "Closed synthetic work");
        await seam.onCurrent?.();
      },
      readyCredential: ready,
      referenceAuthority: async () => CAPTURE_REFERENCE_POLICY_SHA256,
      diagnosticAuthority: async () => CAPTURE_DIAGNOSTIC_POLICY_SHA256,
      referenceValidationAuthority: async () =>
        REFERENCE_VALIDATION_POLICY_SHA256,
      referenceOfflineAuthority: async () => REFERENCE_OFFLINE_POLICY_SHA256,
      pinReferenceOfflineDatabase: async () => {
        const pin = await syntheticImmutableSnapshot(project.paths.database);
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
            const after = await lstat(project.paths.database);
            expect([after.ino, after.dev, after.size, after.mtimeMs]).toEqual([
              before.ino,
              before.dev,
              before.size,
              before.mtimeMs,
            ]);
          },
        };
      },
      prepareReferenceBackup: async (filename) => {
        await writeFile(filename, Buffer.alloc(0), { flag: "wx" });
      },
      pinReferenceBackup: async (filename) => syntheticBackupPin(filename),
      publishReferenceBackup: async (source, destination, _context, proof) => {
        await proof.check();
        proof.close();
        await rename(source, destination);
        return syntheticBackupPin(destination);
      },
      pinReferenceValidationDatabase: () =>
        syntheticImmutableSnapshot(project.paths.database),
      pinReferenceValidationEntry: async (rootId, relative) => {
        const filename = path.join(
          rootId === project.artifactRootId ? artifacts : outputs,
          ...relative.split("/"),
        );
        const stat = await lstat(filename);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1))
          throw new HostBoundaryError(
            "PATH_FORBIDDEN",
            "Synthetic retained pin refused.",
          );
        return {
          check: async () => {},
          handle: 1,
          byteLength: stat.size,
          identity: {
            path: filename,
            volume: stat.dev,
            file: String(stat.ino),
          },
          read: () => {
            throw new Error("Synthetic native pin has no body reader");
          },
          close: () => {},
        };
      },
      recoveryAuthority: async () => {
        if (validationMode || offlineMode)
          throw new Error(
            "Read-only validation must not inspect the credential journal",
          );
        if (!admitted)
          throw new HostBoundaryError(
            "ACTION_REQUIRED",
            "Old synthetic release has no recovery capability",
          );
        return {
          policySha256: CAPTURE_RECOVERY_POLICY_SHA256,
          credentialSha256,
        };
      },
      isCurrent: () => current,
      attestDatabase: async () => {},
      credentials: () => ({
        async use(_reference, context, consumer) {
          vault();
          if (!captureAllowed)
            throw new Error("Offline recovery must not read a vault");
          const bytes = Buffer.from("synthetic-only-pat");
          try {
            return fakeComplete(context, await consumer(bytes));
          } finally {
            bytes.fill(0);
          }
        },
      }),
      close: () => {
        current = false;
      },
    };
    seam.work = work;
    policy = nativeCapturePolicy(work);
    const now = policy.clock.now.bind(policy.clock);
    vi.spyOn(policy.clock, "now").mockImplementation(
      () => (fixedNow ?? now()) + clockOffset,
    );
    try {
      if (offlineMode) {
        offline = await openNativeReferenceOffline(project);
        offlines.push(offline);
      } else if (validationMode) {
        validation = await openNativeReferenceValidation(project);
        validations.push(validation);
      } else {
        const native = await assembleNativeCapture(project);
        runtimes.push(native);
        runtime = {
          execute: ownCaptureWork((input, signal) =>
            native.execute(input, AbortSignal.any([signal, scope.signal])),
          ),
          recover: ownCaptureWork((input, signal) =>
            native.recover(input, AbortSignal.any([signal, scope.signal])),
          ),
          ...(native.reference
            ? {
                reference: ownCaptureWork((input, signal) => {
                  if (!native.reference)
                    throw new Error("Missing native reference facade");
                  return native.reference(
                    input,
                    AbortSignal.any([signal, scope.signal]),
                  );
                }),
              }
            : {}),
          close: () => native.close(),
        };
      }
    } catch (error) {
      if (error instanceof NativeCaptureStartupCleanupRequired)
        startupClosures.push(error.close);
      throw error;
    }
    return { policy, store, runtime };
  };
  const initialOwners = await open();
  const originalRequestId = "failed_request";
  const originalJobId = `capture_${canonicalDigest([project.projectId, project.principal.actorId, originalRequestId])}`;
  const url =
    "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2";
  const selection = parseFigmaSelection(url);
  const selected = {
    id: `native_${"a".repeat(64)}`,
    projectId: project.projectId,
    sourceId: `figma_${canonicalDigest([project.projectId, selection])}`,
    artifactRootId: project.artifactRootId,
    ...selection,
    credential: project.reference,
    imageOrigins: [],
  };
  const request: FigmaCaptureRequest = {
    schemaVersion: "1.0",
    projectId: project.projectId,
    captureId: originalJobId,
    selectionUrl: url,
    policyId: selected.id,
    policySha256: canonicalDigest(selected),
    credential: project.reference,
  };
  const resources = nativeCaptureResources(project.projectId);
  const seedId = `seed_${canonicalDigest([originalJobId, request])}`;
  const seed = await initialOwners.policy.issue({
    jobId: seedId,
    requestId: seedId,
    signal: scope.signal,
  });
  const receipt = value(
    await initialOwners.store.commit(
      [
        value(await initialOwners.store.stage(canonicalBytes(request), seed)),
        value(await initialOwners.store.stage(canonicalBytes(resources), seed)),
      ],
      seed,
    ),
  );
  const context = await initialOwners.policy.issue({
    jobId: originalJobId,
    requestId: originalRequestId,
    signal: scope.signal,
  });
  let record = value(
    await initialOwners.store.jobs.create(
      {
        id: originalJobId,
        operation: "capture",
        input: {
          id: required(receipt.outputs[0]).id,
          sha256: required(receipt.outputs[0]).sha256,
        },
        resources: {
          snapshotId: required(receipt.outputs[1]).id,
          sha256: required(receipt.outputs[1]).sha256,
          componentRegistryRevision: "none",
          tokenRegistryRevision: "none",
          selectedModes: {},
        },
        handlerId: CAPTURE_HANDLER_ID,
        handlerVersion: CAPTURE_HANDLER_VERSION,
        authorityRef: selected.id,
        resourceKeys: [
          `capture_source_${canonicalDigest([project.projectId, selection.fileKey, project.reference])}`,
        ],
        deadline: context.deadline,
        budget: context.budget,
      },
      context,
    ),
  );
  if (history.priorResourceUse) {
    const priorContext = await initialOwners.policy.issue({
      jobId: "synthetic_resource_predecessor",
      requestId: "synthetic_resource_predecessor",
      signal: scope.signal,
    });
    let prior = value(
      await initialOwners.store.jobs.create(
        {
          ...record.submission,
          id: "synthetic_resource_predecessor",
          operation: "write",
          handlerId: "synthetic-resource-user",
          deadline: priorContext.deadline,
        },
        priorContext,
      ),
    );
    prior = value(
      await initialOwners.store.jobs.claim(
        prior.job.id,
        {
          state: "queued",
          rowVersion: prior.rowVersion,
        },
        "synthetic_prior_owner",
        5000,
        priorContext,
      ),
    );
    value(
      await initialOwners.store.jobs.update(
        prior.job.id,
        fence(prior),
        {
          kind: "fail",
          error: {
            code: "INVALID_INPUT",
            message: "Synthetic no-effect resource use",
            retryable: false,
            diagnosticIds: [],
          },
        },
        priorContext,
      ),
    );
  }
  if (history.repaired) {
    const decisions = new RecoveryDecisions(
      initialOwners.policy,
      project.projectId,
    );
    fixtureRecovery = decisions;
    const repair = vi.spyOn(initialOwners.store.jobs, "reconcile");
    const service = new JobService({
      projectId: project.projectId,
      artifactRootId: project.artifactRootId,
      ownerId: "synthetic_repaired_owner",
      repository: initialOwners.store.jobs,
      clock: initialOwners.policy.clock,
      executionAuthority: {
        verify: initialOwners.policy.verify,
        // Stop observation must outlive the cancelled execution signal.
        observe: async (signal) => {
          const issued = await initialOwners.policy.issue({
            jobId: originalJobId,
            requestId: originalRequestId,
            signal,
          });
          expect(issued.signal).toBe(signal);
          return issued;
        },
        issue: async (_record, signal) => {
          const issued = await initialOwners.policy.issue({
            jobId: originalJobId,
            requestId: originalRequestId,
            signal,
            deadline: record.job.deadline,
          });
          expect(issued.signal).toBe(signal);
          return issued;
        },
      },
      recoveryAuthority: {
        async issue(record, signal) {
          const recoveryContext = await initialOwners.policy.issue({
            jobId: record.job.id,
            requestId: record.requestId,
            signal,
          });
          expect(recoveryContext.signal).toBe(signal);
          decisions.register(record, recoveryContext);
          return recoveryContext;
        },
        decide: (record, facts, context) =>
          decisions.decide(record, facts, context),
      },
      handlers: [
        {
          id: CAPTURE_HANDLER_ID,
          version: CAPTURE_HANDLER_VERSION,
          operation: "capture",
          async run(execution) {
            historicalClaim = structuredClone(execution.record);
            for (let index = 1; index <= 2; index++) {
              await execution.reserve(`figma_http_${index}`, call);
              await execution.settle(`figma_http_${index}`, call);
            }
            if (retainStage)
              for (let index = 0; index < (history.stageCount ?? 1); index++)
                value(
                  await execution.stage(
                    canonicalBytes(
                      history.committedStageBytes
                        ? resources
                        : history.successorStageBytes
                          ? { file: { version: "v1" } }
                          : {
                              file: { version: "synthetic_version" },
                              index,
                              privateNode: "DO-NOT-EMIT-PROVIDER-DATA",
                            },
                    ),
                  ),
                );
            throw new HostBoundaryError(
              "CONFLICT",
              "Synthetic post-effect finalizer conflict",
            );
          },
        },
      ],
    });
    services.push(service);
    scope.releaseOnEnd(() => {
      const stopping = service.stop();
      stopRequests.push(
        stopping.then(
          (outcome) => ({ outcome }),
          (error: unknown) => ({ error }),
        ),
      );
    });
    try {
      value(await service.runOnce());
      value(await service.waitForAttempt(originalJobId, context));
    } finally {
      value(await service.stop());
      fixtureRecovery = undefined;
    }
    record = value(await initialOwners.store.jobs.get(originalJobId, context));
    expect(repair.mock.calls.map((call) => call[2].kind)).toEqual([
      "interrupt",
      "resolved",
    ]);
    repair.mockRestore();
    expect(record).toMatchObject({
      generation: 3,
      job: { attempt: 1, status: "failed" },
    });
  } else {
    record = value(
      await initialOwners.store.jobs.claim(
        originalJobId,
        { state: "queued", rowVersion: record.rowVersion },
        "synthetic_owner",
        5000,
        context,
      ),
    );
    for (let index = 1; index <= 2; index++) {
      record = value(
        await initialOwners.store.jobs.update(
          originalJobId,
          fence(record),
          { kind: "reserve-usage", id: `figma_http_${index}`, usage: call },
          context,
        ),
      );
      record = value(
        await initialOwners.store.jobs.update(
          originalJobId,
          fence(record),
          {
            kind: "settle-usage",
            id: `figma_http_${index}`,
            result: "settled",
            actual: call,
          },
          context,
        ),
      );
    }
    if (retainStage) {
      let retained: unknown = {
        file: { version: "synthetic_version" },
        privateNode: "DO-NOT-EMIT-PROVIDER-DATA",
        signedUrl: "https://private.invalid/?signed=DO-NOT-EMIT",
      };
      if (cooldown) {
        const manifest: FigmaCaptureManifest = {
          schemaVersion: "1.0",
          format: "figma-rest-capture-v1",
          captureId: originalJobId,
          projectId: project.projectId,
          policyId: request.policyId,
          policySha256: request.policySha256,
          request: record.job.input,
          selection,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          completeness: "unavailable",
          referenceStatus: "unavailable",
          readiness: "not-evaluated",
          observations: [
            {
              call: 1,
              operation: "metadata",
              outcome: "rate-limited",
              statusCode: 429,
              receivedBytes: 0,
              nodeIds: [],
            },
          ],
          artifacts: [],
          missing: ["metadata"],
          limitations: [],
          usage: {
            externalCalls: 2,
            dnsQueries: 2,
            networkReceivedBytes: 0,
            networkBodyBytes: 0,
            persistedBytes: 0,
          },
          retry:
            cooldown === "unknown"
              ? "retry-after-unknown"
              : "explicit-action-required",
          ...(cooldown !== "unknown"
            ? {
                nextEligibleAt: new Date(
                  Date.now() + (cooldown === "future" ? 3600000 : -3600000),
                ).toISOString(),
              }
            : {}),
        };
        expect(validateContract("FigmaCaptureManifest", manifest).success).toBe(
          true,
        );
        retained = manifest;
      }
      record = value(
        await initialOwners.store.jobs.stage(
          originalJobId,
          fence(record),
          canonicalBytes(retained),
          context,
        ),
      ).record;
    }
    record = value(
      await initialOwners.store.jobs.update(
        originalJobId,
        fence(record),
        {
          kind: "fail",
          error: {
            code: "CONFLICT",
            message: "Synthetic stopped failed attempt",
            retryable: false,
            diagnosticIds: [],
          },
        },
        context,
      ),
    );
  }
  const initial = structuredClone(record);
  const input = {
    operation: "recover" as const,
    requestId: originalRequestId,
    failedJobId: originalJobId,
    nextRequestId: "next_request",
  };
  const helpers = {
    root,
    artifacts,
    outputs,
    project,
    initial,
    historicalClaim,
    input,
    url,
    ready,
    vault,
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    get policy() {
      const current = policy;
      return {
        ...current,
        issue: ownCaptureWork(
          (input: Parameters<typeof policy.issue>[0]) =>
            current.issue({
              ...input,
              signal: AbortSignal.any([input.signal, scope.signal]),
            }),
          scope,
        ),
      };
    },
    setAdmitted(value: boolean) {
      admitted = value;
    },
    allowCapture() {
      captureAllowed = true;
    },
    setCredential(value: string) {
      credentialSha256 = value;
    },
    setFault(value: string | undefined) {
      fault = value;
    },
    advanceClock(milliseconds: number) {
      clockOffset += milliseconds;
    },
    async validateRetained(expectedJob: string) {
      await runtime.close();
      validationMode = true;
      await open();
      try {
        return await required(validation).execute(
          {
            operation: "reference-recovery-plan",
            requestId: input.nextRequestId,
            expectedJob,
          },
          scope.signal,
        );
      } finally {
        await validation?.close();
      }
    },
    async runOffline(command: NativeReferenceOfflineInput) {
      await runtime.close();
      await validation?.close();
      await offline?.close();
      offlineMode = true;
      await open();
      return required(offline).execute(command, scope.signal);
    },
    raceBeforeCommit(nextOnly = false) {
      beforeCommit = () =>
        mutateOpenSyntheticCapture(
          store,
          originalJobId,
          (record) => {
            record.rowVersion++;
          },
          nextOnly
            ? `capture_${canonicalDigest([project.projectId, project.principal.actorId, input.nextRequestId])}`
            : undefined,
        );
    },
    async reopen() {
      await validation?.close();
      await runtime.close();
      validationMode = false;
      offlineMode = false;
      await open();
    },
    async record() {
      const context = await policy.issue({
        jobId: originalJobId,
        requestId: originalRequestId,
        signal: scope.signal,
      });
      return value(await store.jobs.get(originalJobId, context));
    },
    async stages() {
      const context = await policy.issue({
        jobId: originalJobId,
        requestId: originalRequestId,
        signal: scope.signal,
      });
      return value(await store.jobs.getStages(originalJobId, context));
    },
    async ordinaryReceipt(
      id: string,
      bytes = canonicalBytes({ ordinary: true, id }),
    ) {
      const context = await policy.issue({
        jobId: id,
        requestId: id,
        signal: scope.signal,
      });
      const stage = value(await store.stage(bytes, context));
      return store.commit([stage], context);
    },
    async mutate(change: (record: StoredJob) => void) {
      await runtime.close();
      corruptSyntheticCapture(
        project.paths.database,
        nativeBinding,
        originalJobId,
        change,
      );
      await open();
    },
    async mutateStage(change: (stage: StoredJobStage) => void) {
      await runtime.close();
      corruptSyntheticCaptureStage(
        project.paths.database,
        nativeBinding,
        originalJobId,
        change,
      );
      await open();
    },
    async addHistory(count: number) {
      await runtime.close();
      addSyntheticStoppedCaptures(
        project.paths.database,
        nativeBinding,
        originalJobId,
        count,
        canonicalDigest,
      );
      await open();
    },
    async propose() {
      const result = await runtime.recover(input, scope.signal);
      expect(result.status, JSON.stringify(result)).toBe("complete");
      return required(result.value).proposal;
    },
  };
  Object.assign(helpers, {
    validateRetained: ownCaptureWork(helpers.validateRetained),
    reopen: ownCaptureWork(helpers.reopen),
    record: ownCaptureWork(helpers.record),
    stages: ownCaptureWork(helpers.stages),
    ordinaryReceipt: ownCaptureWork(helpers.ordinaryReceipt),
    mutate: ownCaptureWork(helpers.mutate),
    mutateStage: ownCaptureWork(helpers.mutateStage),
    addHistory: ownCaptureWork(helpers.addHistory),
    propose: ownCaptureWork(helpers.propose),
  });
  return helpers;
}

it.each(["setup", "storage", "native"] as const)(
  "joins cancelled original capture fixture %s work before owner close and spy restoration",
  async (kind) => {
    const runner = new AbortController();
    const scope = new AsyncTestScope(runner.signal);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    captureTestScope().releaseOnEnd(release);
    let observedSignal: AbortSignal | undefined;
    let settled = false;
    let completed = false;
    let restored = false;
    let rejected: unknown;
    let result: unknown;
    const begin = () => {
      if (kind === "setup") {
        seam.onCurrent = async () => {
          seam.onCurrent = undefined;
          enter();
          await gate;
        };
        return fixture();
      }
      return Promise.resolve(undefined);
    };
    const construction = inCaptureTest(scope, begin);
    const f =
      kind === "setup"
        ? undefined
        : await inCaptureTest(scope, () => fixture());
    if (kind === "storage" && f) {
      const options: unknown = Reflect.get(f.store, "options");
      const authority = (
        value: unknown,
      ): value is Pick<StorageOptions, "authorize"> =>
        !!value &&
        typeof value === "object" &&
        "authorize" in value &&
        typeof value.authorize === "function";
      if (!authority(options))
        throw new Error("Missing synthetic storage authority");
      const original = options.authorize;
      vi.spyOn(options, "authorize").mockImplementationOnce(
        async (...args: unknown[]) => {
          const context = args[0];
          if (
            !context ||
            typeof context !== "object" ||
            !("signal" in context) ||
            !(context.signal instanceof AbortSignal)
          )
            throw new Error("Missing original signal");
          observedSignal = context.signal;
          enter();
          await gate;
          return Reflect.apply(original, options, args);
        },
      );
    }
    if (kind === "native") {
      const inspect = ProjectFileSystem.prototype.inspectCaptureRecovery;
      vi.spyOn(
        ProjectFileSystem.prototype,
        "inspectCaptureRecovery",
      ).mockImplementationOnce(async function (
        this: ProjectFileSystem,
        stages,
        context,
      ) {
        observedSignal = context.signal;
        enter();
        await gate;
        return inspect.call(this, stages, context);
      });
    }
    const operation =
      kind === "setup"
        ? construction
        : kind === "storage"
          ? required(f).record()
          : required(f).runtime.recover(
              required(f).input,
              new AbortController().signal,
            );
    const pending = operation
      .then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          rejected = error;
        },
      )
      .finally(() => {
        settled = true;
      });
    await entered;
    const storeClose = LocalStore.prototype.close;
    const closeOrder: boolean[] = [];
    vi.spyOn(LocalStore.prototype, "close").mockImplementation(function (
      this: LocalStore,
    ) {
      closeOrder.push(settled);
      return storeClose.call(this);
    });
    const cleanup = required(cleanups.at(-1));
    runner.abort(new Error("Synthetic original runner abort"));
    expect(scope.signal.aborted).toBe(true);
    if (kind !== "setup") expect(observedSignal?.aborted).toBe(true);
    const closing = cleanup().then(() => {
      completed = true;
      vi.restoreAllMocks();
      restored = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(completed).toBe(false);
      expect(restored).toBe(false);
      expect(closeOrder).toEqual([]);
      expect(vi.isMockFunction(LocalStore.open)).toBe(true);
      await expect(
        ownCaptureWork(async () => "late work", scope)(),
      ).rejects.toBe(scope.signal.reason);
      release();
      await pending;
      await closing;
      cleanups.splice(cleanups.indexOf(cleanup), 1);
      expect(settled).toBe(true);
      expect(completed).toBe(true);
      expect(restored).toBe(true);
      expect(closeOrder.length).toBeGreaterThan(0);
      expect(closeOrder.every(Boolean)).toBe(true);
      if (kind === "native") {
        expect(rejected).toBeUndefined();
        expect(result).toMatchObject({
          error: { code: expect.stringMatching(/^(CANCELLED|FORBIDDEN)$/) },
        });
      } else if (kind === "setup") {
        expect(rejected).toMatchObject({ code: "CANCELLED" });
      } else expect(rejected).toBeDefined();
    } finally {
      release();
      await pending;
      await closing;
    }
  },
);

it("joining cancelled capture work preserves its original rejection", async () => {
  const runner = new AbortController();
  const scope = new AsyncTestScope(runner.signal);
  const primary = new Error("Synthetic original failure");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  captureTestScope().releaseOnEnd(release);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = ownCaptureWork(async () => {
    entered();
    await gate;
    throw primary;
  }, scope)();
  const rejection = expect(original).rejects.toBe(primary);
  await ready;
  runner.abort();
  const closing = scope.close();
  release();
  await rejection;
  await closing;
});

it("caller cancellation does not cancel the original capture test scope", async () => {
  const f = await fixture();
  const caller = new AbortController();
  caller.abort();
  expect(await f.runtime.recover(f.input, caller.signal)).toMatchObject({
    error: { code: "CANCELLED" },
  });
  expect(captureTestScope().signal.aborted).toBe(false);
  await f.propose();
});

it.each([false, true])(
  "records offline authorization with retained stages=%s and replays exactly after reopen",
  async (retain) => {
    const f = await fixture(retain);
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new Error("No recovery network"));
    const proposal = await f.propose();
    const again = await f.propose();
    expect(again).toEqual(proposal);
    const command = {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    };
    const issued = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    expect(issued.status, JSON.stringify(issued)).toBe("complete");
    expect(required(issued.value).phase).toBe("authorized");
    expect(await f.record()).toEqual(f.initial);
    await f.reopen();
    const replay = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    expect(replay, JSON.stringify(replay)).toEqual(issued);
    expect(await f.record()).toEqual(f.initial);
    expect(JSON.stringify(replay)).not.toMatch(
      /DO-NOT-EMIT|signed=|private-name|[A-Z]:\\\\/,
    );
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  },
);

it("preserves replay after exact successor INSERT and refuses a third request", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  const command = {
    ...f.input,
    expectedProof: proposal.proofSha256,
    confirmation: CAPTURE_RECOVERY_CONFIRMATION,
  };
  const issued = await f.runtime.recover(command, new AbortController().signal);
  expect(issued.status, JSON.stringify(issued)).toBe("complete");
  const start = vi
    .spyOn(JobService.prototype, "start")
    .mockRejectedValue(new Error("Synthetic crash after successor INSERT"));
  const capture = await f.runtime.execute(
    { operation: "capture", requestId: f.input.nextRequestId, url: f.url },
    new AbortController().signal,
  );
  expect(start.mock.calls.length, JSON.stringify(capture)).toBe(1);
  expect(capture.status).not.toBe("complete");
  start.mockRestore();
  await f.reopen();
  const replay = await f.runtime.recover(command, new AbortController().signal);
  expect(replay.status, JSON.stringify(replay)).toBe("complete");
  expect(replay.value).toEqual({ ...issued.value, consumed: true });
  expect(await f.record()).toEqual(f.initial);
  const third = await f.runtime.recover(
    { ...command, nextRequestId: "third_request" },
    new AbortController().signal,
  );
  expect(third.status).toBe("failed");
  expect(f.vault).not.toHaveBeenCalled();
});

it.each(["credential", "row", "orphan", "output", "old-release"] as const)(
  "refuses changed %s evidence without rewriting the old failure",
  async (change) => {
    const f = await fixture();
    const proposal = await f.propose();
    if (change === "credential") f.setCredential("c".repeat(64));
    if (change === "row")
      await f.mutate((record) => {
        record.rowVersion++;
      });
    if (change === "orphan")
      await writeFile(path.join(f.artifacts, "unclassified"), "synthetic");
    if (change === "output")
      await writeFile(path.join(f.outputs, "unclassified"), "synthetic");
    if (change === "old-release") f.setAdmitted(false);
    const result = await f.runtime.recover(
      {
        ...f.input,
        expectedProof: proposal.proofSha256,
        confirmation: CAPTURE_RECOVERY_CONFIRMATION,
      },
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result)).toBe("failed");
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it.each(["unknown", "reserved"] as const)(
  "refuses %s effects",
  async (state) => {
    const f = await fixture();
    await f.mutate((record) => {
      const effect = required(record.effects[0]);
      effect.state = state;
      delete effect.actual;
    });
    const result = await f.runtime.recover(
      f.input,
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("passes both history gates, performs one separately invoked attempt and never covers a third request", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  const command = {
    ...f.input,
    expectedProof: proposal.proofSha256,
    confirmation: CAPTURE_RECOVERY_CONFIRMATION,
  };
  const issued = await f.runtime.recover(command, new AbortController().signal);
  expect(issued.status, JSON.stringify(issued)).toBe("complete");
  f.allowCapture();
  const network = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockRejectedValue(new CaptureHttpError("AUTH_REQUIRED", 401));
  const checks = vi.spyOn(f.store.jobs, "getCaptureRecovery");
  const next = await f.runtime.execute(
    { operation: "capture", requestId: f.input.nextRequestId, url: f.url },
    new AbortController().signal,
  );
  expect(next.status, JSON.stringify(next)).toBe("partial");
  expect(checks.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(network).toHaveBeenCalledTimes(1);
  const sameNext = await f.runtime.execute(
    { operation: "capture", requestId: f.input.nextRequestId, url: f.url },
    new AbortController().signal,
  );
  expect(sameNext).toEqual(next);
  expect(network).toHaveBeenCalledTimes(1);
  await f.reopen();
  const replay = await f.runtime.recover(command, new AbortController().signal);
  expect(replay.status, JSON.stringify(replay)).toBe("complete");
  expect(replay.value).toEqual({ ...issued.value, consumed: true });
  const third = await f.runtime.execute(
    { operation: "capture", requestId: "third_request", url: f.url },
    new AbortController().signal,
  );
  expect(third.status).toBe("failed");
  expect(network).toHaveBeenCalledTimes(1);
  expect(await f.record()).toEqual(f.initial);
});

it.each(["future", "unknown", "elapsed"] as const)(
  "preserves retained-manifest cooldown %s",
  async (cooldown) => {
    const f = await fixture(true, cooldown);
    const result = await f.runtime.recover(
      f.input,
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result)).toBe(
      cooldown === "elapsed" ? "complete" : "failed",
    );
    if (cooldown !== "elapsed")
      expect(result.error?.code).toBe(
        cooldown === "future" ? "RATE_LIMITED" : "ACTION_REQUIRED",
      );
    expect(await f.record()).toEqual(f.initial);
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it.each(["before-commit", "after-commit"] as const)(
  "handles issuance fault at %s without reminting",
  async (point) => {
    const f = await fixture();
    const proposal = await f.propose();
    const command = {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    };
    f.setFault(point);
    const result = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    expect(result.status).toBe(
      point === "after-commit" ? "complete" : "failed",
    );
    f.setFault(undefined);
    await f.reopen();
    const replay = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    if (point === "after-commit") expect(replay).toEqual(result);
    else expect(replay.status).toBe("failed");
    expect(await f.record()).toEqual(f.initial);
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("refuses changed retained bytes, missing stages, and unowned same-byte stages", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  const directories = (await readdir(f.artifacts)).filter((name) =>
    name.startsWith(".host-"),
  );
  const files = (
    await Promise.all(
      directories.map(async (directory) =>
        (
          await readdir(path.join(f.artifacts, directory))
        ).map((name) => path.join(f.artifacts, directory, name)),
      ),
    )
  ).flat();
  const stage = required(files[0]);
  const original = await readFile(stage);
  const command = {
    ...f.input,
    expectedProof: proposal.proofSha256,
    confirmation: CAPTURE_RECOVERY_CONFIRMATION,
  };
  await writeFile(stage, "changed");
  expect(
    (await f.runtime.recover(command, new AbortController().signal)).status,
  ).toBe("failed");
  await writeFile(stage, original);
  const unowned = path.join(
    path.dirname(stage),
    "11111111-1111-4111-8111-111111111111",
  );
  await writeFile(unowned, original);
  expect(
    (await f.runtime.recover(command, new AbortController().signal)).status,
  ).toBe("failed");
  await rm(unowned);
  await rm(stage);
  expect(
    (await f.runtime.recover(command, new AbortController().signal)).status,
  ).toBe("failed");
});

it("refuses malformed confirmation and does not grant a concurrent different target", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  expect(
    (
      await f.runtime.recover(
        {
          ...f.input,
          expectedProof: proposal.proofSha256,
          confirmation: "yes",
        },
        new AbortController().signal,
      )
    ).error?.code,
  ).toBe("INVALID_INPUT");
  const first = f.runtime.recover(
    {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    },
    new AbortController().signal,
  );
  await expect(
    f.runtime.recover(
      { ...f.input, nextRequestId: "different" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await first).status).toBe("complete");
  const other = await f.runtime.recover(
    { ...f.input, nextRequestId: "different" },
    new AbortController().signal,
  );
  expect(other.error?.code).toBe("CONFLICT");
  expect(f.vault).not.toHaveBeenCalled();
});

it.each([
  "OtherFile/selection?node-id=1-2",
  "SyntheticFile/selection?node-id=9-9",
])(
  "does not let reserved next request bytes change to %s",
  async (selection) => {
    const f = await fixture();
    const proposal = await f.propose();
    expect(
      (
        await f.runtime.recover(
          {
            ...f.input,
            expectedProof: proposal.proofSha256,
            confirmation: CAPTURE_RECOVERY_CONFIRMATION,
          },
          new AbortController().signal,
        )
      ).status,
    ).toBe("complete");
    const result = await f.runtime.execute(
      {
        operation: "capture",
        requestId: f.input.nextRequestId,
        url: `https://www.figma.com/design/${selection}`,
      },
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result)).toBe("failed");
    expect(f.vault).not.toHaveBeenCalled();
    expect(await f.record()).toEqual(f.initial);
  },
);

it.each([false, true])(
  "rechecks the old version at transaction completion, successor=%s",
  async (successor) => {
    const f = await fixture();
    const proposal = await f.propose();
    const command = {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    };
    if (successor) {
      expect(
        (await f.runtime.recover(command, new AbortController().signal)).status,
      ).toBe("complete");
      f.raceBeforeCommit(true);
      const result = await f.runtime.execute(
        { operation: "capture", requestId: f.input.nextRequestId, url: f.url },
        new AbortController().signal,
      );
      expect(result.status).toBe("failed");
    } else {
      f.raceBeforeCommit();
      expect(
        (await f.runtime.recover(command, new AbortController().signal)).status,
      ).toBe("failed");
    }
    expect(await f.record()).toEqual(f.initial);
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("refuses authority revoked after physical inspection without persisting a grant", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  const inspect = ProjectFileSystem.prototype.inspectCaptureRecovery;
  const spy = vi
    .spyOn(ProjectFileSystem.prototype, "inspectCaptureRecovery")
    .mockImplementation(async function (this: ProjectFileSystem, ...args) {
      const result = await inspect.apply(this, args);
      f.policy.close();
      return result;
    });
  const result = await f.runtime.recover(
    {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  spy.mockRestore();
  await f.reopen();
  expect(await f.propose()).toEqual(proposal);
  expect(f.vault).not.toHaveBeenCalled();
});

it.each([
  "cancelled",
  "interrupted",
  "waiting-for-user",
  "completed",
  "queued",
] as const)("does not authorize nonfailed state %s", async (status) => {
  const f = await fixture();
  await f.mutate((record) => {
    record.job.status = status;
  });
  expect(
    (await f.runtime.recover(f.input, new AbortController().signal)).status,
  ).toBe("failed");
  expect(f.vault).not.toHaveBeenCalled();
});

it.each([999, 1000])(
  "bounds full native proof inspection at %s additional jobs",
  async (count) => {
    const f = await fixture(false);
    await f.addHistory(count);
    const result = await f.runtime.recover(
      f.input,
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result)).toBe(
      count === 999 ? "complete" : "failed",
    );
    if (count === 1000) expect(result.error?.code).toBe("INPUT_LIMIT");
    expect(f.vault).not.toHaveBeenCalled();
  },
);

it("refuses an escaped publication pair without adopting or unlinking it", async () => {
  const f = await fixture();
  const proposal = await f.propose();
  const directories = (await readdir(f.artifacts)).filter((name) =>
    name.startsWith(".host-"),
  );
  const files = (
    await Promise.all(
      directories.map(async (directory) =>
        (
          await readdir(path.join(f.artifacts, directory))
        ).map((name) => path.join(f.artifacts, directory, name)),
      ),
    )
  ).flat();
  const stage = required(files[0]);
  const bytes = await readFile(stage);
  const destination = path.join(
    f.artifacts,
    "blobs",
    canonicalDigest(JSON.parse(bytes.toString("utf8"))),
  );
  await link(stage, destination);
  const result = await f.runtime.recover(
    {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(await readFile(stage)).toEqual(bytes);
  expect(await readFile(destination)).toEqual(bytes);
  expect(await f.record()).toEqual(f.initial);
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "authorizes the real repaired failure with stages=%s and prior resource use=%s",
  async (retain, prior) => {
    const f = await fixture(retain, undefined, {
      repaired: true,
      priorResourceUse: prior,
      stageCount: 2,
    });
    expect(f.initial).toMatchObject({
      generation: 3,
      resources: [],
      job: { status: "failed", attempt: 1 },
    });
    const claim = required(f.historicalClaim);
    expect(claim.generation).toBe(1);
    expect(claim.resources[0]?.generation).toBe(prior ? 2 : 1);
    const stages = await f.stages();
    expect(stages).toHaveLength(retain ? 2 : 0);
    for (const stage of stages)
      expect(stage).toMatchObject({
        fencingToken: 1,
        attempt: 1,
        leaseId: claim.job.lease?.id,
        disposition: "recovery-needed",
        jobId: f.initial.job.id,
      });
    await f.reopen();
    const proposal = await f.propose();
    const command = {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    };
    const issued = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    expect(issued.status, JSON.stringify(issued)).toBe("complete");
    const authorization = required(required(issued.value).authorization);
    const grant = JSON.parse(
      await readFile(
        path.join(f.artifacts, "blobs", authorization.sha256),
        "utf8",
      ),
    );
    expect(grant.resourceStates).toEqual([
      {
        key: f.initial.resourceKeys[0],
        generation: prior ? 2 : 1,
        state: "released",
        jobId: null,
        leaseId: null,
        fencingToken: null,
      },
    ]);
    f.allowCapture();
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new CaptureHttpError("AUTH_REQUIRED", 401));
    const next = await f.runtime.execute(
      {
        operation: "capture",
        requestId: f.input.nextRequestId,
        url: f.url,
      },
      new AbortController().signal,
    );
    expect(next.status, JSON.stringify(next)).toBe("partial");
    expect(network).toHaveBeenCalledTimes(1);
    expect(await f.record()).toEqual(f.initial);
    expect(await f.stages()).toEqual(stages);
    await f.reopen();
    const replay = await f.runtime.recover(
      command,
      new AbortController().signal,
    );
    expect(replay.value).toEqual({ ...issued.value, consumed: true });
  },
);

it.each([
  "recovery_capture_notes",
  `recovery_capture_${"a".repeat(63)}`,
  `recovery_capture_${"a".repeat(63)}g`,
  `recovery_capture_${"A".repeat(64)}`,
])(
  "ordinary receipt %s is allowed and ignored by recovery lookup",
  async (id) => {
    const f = await fixture(false);
    expect((await f.ordinaryReceipt(id)).status).toBe("complete");
    f.setAdmitted(false);
    f.allowCapture();
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new CaptureHttpError("AUTH_REQUIRED", 401));
    const capture = await f.runtime.execute(
      {
        operation: "capture",
        requestId: "unrelated_capture",
        url: "https://www.figma.com/design/OtherFile/selection?node-id=1-2",
      },
      new AbortController().signal,
    );
    expect(capture.status, JSON.stringify(capture)).toBe("partial");
    expect(network).toHaveBeenCalledTimes(1);
  },
);

it("exact reserved control keys deny ordinary commits and validate real authorization bytes", async () => {
  const f = await fixture(false);
  const proposal = await f.propose();
  const issued = await f.runtime.recover(
    {
      ...f.input,
      expectedProof: proposal.proofSha256,
      confirmation: CAPTURE_RECOVERY_CONFIRMATION,
    },
    new AbortController().signal,
  );
  expect(issued.status).toBe("complete");
  const ordinary = await f.ordinaryReceipt(
    `recovery_capture_${"f".repeat(64)}`,
  );
  expect(ordinary.status).toBe("failed");
  if (ordinary.status === "failed")
    expect(ordinary.error.code).toBe("FORBIDDEN");
  const authorization = required(required(issued.value).authorization);
  await writeFile(
    path.join(f.artifacts, "blobs", authorization.sha256),
    '{"ordinary":true}',
  );
  const next = await f.runtime.execute(
    {
      operation: "capture",
      requestId: f.input.nextRequestId,
      url: "https://www.figma.com/design/OtherFile/selection?node-id=1-2",
    },
    new AbortController().signal,
  );
  expect(next.status).toBe("failed");
  expect(next.error?.code).toBe("ARTIFACT_INTEGRITY");
  expect(f.vault).not.toHaveBeenCalled();
});

it.each([
  "lease",
  "host",
  "fence",
  "stale-fence",
  "attempt",
  "job",
  "request",
  "root",
  "disposition",
] as const)("refuses repaired-stage provenance mismatch: %s", async (kind) => {
  const f = await fixture(true, undefined, { repaired: true, stageCount: 2 });
  await f.mutateStage((stage) => {
    if (kind === "lease")
      stage.leaseId = "lease-11111111-1111-4111-8111-111111111111";
    if (kind === "host")
      stage.hostInstanceId = "host-11111111-1111-4111-8111-111111111111";
    if (kind === "fence") stage.fencingToken = 2;
    if (kind === "stale-fence") stage.fencingToken = 0;
    if (kind === "attempt") stage.attempt = 2;
    if (kind === "job") stage.jobId = "foreign_job";
    if (kind === "request") stage.requestId = "foreign_request";
    if (kind === "root") stage.artifactRootId = "foreign_root";
    if (kind === "disposition") stage.disposition = "retained";
  });
  const result = await f.runtime.recover(f.input, new AbortController().signal);
  expect(result.status, JSON.stringify(result)).toBe("failed");
  expect(f.vault).not.toHaveBeenCalled();
  expect(await f.record()).toEqual(f.initial);
});

it("keeps unsupported generation histories refused and accepts independent resource reuse after a direct failure", async () => {
  const f = await fixture(true, undefined, { priorResourceUse: true });
  expect(f.initial.generation).toBe(1);
  expect((await f.propose()).originalGeneration).toBe(1);
  await f.mutate((record) => {
    record.generation = 2;
  });
  expect(
    (await f.runtime.recover(f.input, new AbortController().signal)).status,
  ).toBe("failed");
  await f.mutate((record) => {
    record.generation = 5;
  });
  expect(
    (await f.runtime.recover(f.input, new AbortController().signal)).status,
  ).toBe("failed");
});

it.each([
  "valid",
  "diagnostic-valid",
  "diagnostic-retained-valid",
  "diagnostic-retained-coexisting-history",
  "diagnostic-retained-coexisting-current-only",
  "diagnostic-retained-successor-output",
  "diagnostic-retained-successor-output-offline",
  "diagnostic-retained-successor-record",
  "diagnostic-retained-successor-receipt",
  "diagnostic-retained-successor-protection",
  "diagnostic-retained-successor-extra-output",
  "diagnostic-retained-successor-version",
  "diagnostic-retained-successor-foreign-job",
  "diagnostic-retained-successor-authority",
  "diagnostic-reference-lease-expired",
  "diagnostic-retained-unknown-stage",
  "diagnostic-retained-missing-protection",
  "diagnostic-retained-extra-input",
  "diagnostic-retained-extra-output",
  "diagnostic-unknown-stage",
  "diagnostic-missing-protection",
  "diagnostic-receipt-mutation",
  "unknown-stage",
  "changed-stage",
  "pair-link",
  "foreign-stage",
  "changed-original",
  "unrelated-protection",
  "missing-protection",
  "timestamp-tie-unrelated",
] as const)(
  "authenticates retained predecessor stages after successor conversion and private exports: %s",
  async (fault) => {
    const retained = fault.startsWith("diagnostic-retained-");
    const coexistence = fault === "diagnostic-retained-coexisting-history";
    const successorCoexistence = fault.startsWith(
      "diagnostic-retained-successor-",
    );
    const offlinePublication =
      fault === "diagnostic-retained-successor-output-offline";
    const validSuccessor =
      fault === "diagnostic-retained-successor-output" || offlinePublication;
    const f = await fixture(true, undefined, {
      repaired: true,
      committedStageBytes: coexistence,
      successorStageBytes: successorCoexistence,
      fixedClock: true,
    });
    const beforeRecord = await f.record();
    const beforeStages = await f.stages();
    const stage = required(beforeStages[0]);
    const directories = (await readdir(f.artifacts)).filter((name) =>
      name.startsWith(".host-"),
    );
    const matching = (
      await Promise.all(
        directories.map(async (directory) =>
          (
            await readdir(path.join(f.artifacts, directory))
          ).includes(stage.stagingId)
            ? directory
            : undefined,
        ),
      )
    ).filter((entry) => entry !== undefined);
    expect(matching).toHaveLength(1);
    const stagePath = path.join(
      f.artifacts,
      required(matching[0]),
      stage.stagingId,
    );
    const beforeBytes = await readFile(stagePath);
    const committedPath = path.join(
      f.artifacts,
      ...stage.staged.artifact.path.split("/"),
    );
    const beforeStageIdentity = await lstat(stagePath);
    const beforeCommittedIdentity = coexistence
      ? await lstat(committedPath)
      : undefined;
    if (successorCoexistence)
      await expect(lstat(committedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    if (coexistence) {
      expect(beforeStageIdentity.nlink).toBe(1);
      expect(beforeCommittedIdentity?.nlink).toBe(1);
      expect(beforeCommittedIdentity?.ino).not.toBe(beforeStageIdentity.ino);
      expect(await readFile(committedPath)).toEqual(beforeBytes);
    }
    if (fault === "timestamp-tie-unrelated") {
      const now = f.policy.clock.now();
      vi.spyOn(f.policy.clock, "now").mockReturnValue(now);
      value(await f.ordinaryReceipt("unrelated_before_grant"));
    }
    const proof = await f.propose();
    expect(
      (
        await f.runtime.recover(
          {
            ...f.input,
            expectedProof: proof.proofSha256,
            confirmation: CAPTURE_RECOVERY_CONFIRMATION,
          },
          new AbortController().signal,
        )
      ).status,
    ).toBe("complete");
    f.allowCapture();
    const origin = "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
    const api = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockImplementation(async (operation) => ({
        status: 200,
        mediaType: "application/json",
        bytes: Buffer.from(
          JSON.stringify(
            operation === "metadata"
              ? { file: { version: "v1" } }
              : operation === "nodes"
                ? {
                    version: "v1",
                    nodes: {
                      "1:2": {
                        document: {
                          id: "1:2",
                          type: "FRAME",
                          name: "Synthetic recovered frame",
                          absoluteBoundingBox: {
                            x: 0,
                            y: 0,
                            width: 2,
                            height: 2,
                          },
                          children: [],
                        },
                      },
                    },
                  }
                : {
                    images: {
                      "1:2": `${origin}/synthetic.png?private=synthetic`,
                    },
                  },
          ),
        ),
      }));
    const requestId = f.input.nextRequestId;
    const next = await f.runtime.execute(
      { operation: "capture", requestId, url: f.url },
      new AbortController().signal,
    );
    expect(next.status, JSON.stringify(next)).toBe("partial");
    expect(next.value?.jobStatus).toBe("completed");
    if (fault === "valid" || fault === "diagnostic-valid" || retained) {
      const convert = figmaImport.convertFigmaStructure;
      vi.spyOn(figmaImport, "convertFigmaStructure").mockImplementation(
        (...args) => {
          const result = convert(...args);
          result.report.diagnostics.push({
            schemaVersion: "1.0",
            id: "synthetic_large_report",
            code: "ACTION_REQUIRED",
            severity: "warning",
            message: "x".repeat(4500000),
            operations: [],
            nodeIds: [],
            evidenceIds: [],
            recovery: "Synthetic report-size regression only.",
          });
          return result;
        },
      );
    }
    const converted = await f.runtime.execute(
      { operation: "convert", requestId },
      new AbortController().signal,
    );
    expect(converted.status, JSON.stringify(converted)).toBe("partial");
    const conversionEvidence = required(
      converted.value?.artifacts.find(
        (entry) => entry.role === "conversion-evidence",
      ),
    );
    const currentProjection = validateContract(
      "FigmaConversionEvidence",
      JSON.parse(
        await readFile(
          path.join(f.artifacts, "blobs", conversionEvidence.artifact.sha256),
          "utf8",
        ),
      ),
    );
    expect(currentProjection.success).toBe(true);
    if (!currentProjection.success)
      throw new Error("Invalid synthetic conversion evidence");
    expect(currentProjection.value.adapter).toBe("figma-structure-fixed-v2");
    if (fault === "valid" || fault === "diagnostic-valid" || retained)
      expect(
        converted.value?.artifacts.find((entry) => entry.role === "report")
          ?.artifact.byteLength,
      ).toBeGreaterThanOrEqual(4500000);
    for (const role of ["nodes", "report"] as const)
      expect(
        (
          await f.runtime.execute(
            {
              operation: "artifact",
              requestId,
              role,
              outputRelative: `${role}.json`,
            },
            new AbortController().signal,
          )
        ).status,
      ).toBe("partial");
    const priorFiles = await Promise.all(
      (await readdir(path.join(f.artifacts, "blobs"))).map(
        async (name) =>
          [
            name,
            await readFile(path.join(f.artifacts, "blobs", name)),
          ] as const,
      ),
    );
    const exports = await Promise.all(
      ["nodes.json", "report.json"].map(
        async (name) =>
          [name, await readFile(path.join(f.outputs, name))] as const,
      ),
    );
    f.ready.mockClear();
    f.vault.mockClear();
    api.mockClear();
    // Any reference-time credential/recovery authority access is a regression.
    required(seam.work).recoveryAuthority = async () => {
      throw new Error("Reference must not inspect the credential journal");
    };
    const settlementFailures: string[] = [];
    const update = f.store.jobs.update.bind(f.store.jobs);
    const settlement =
      fault === "diagnostic-reference-lease-expired"
        ? vi
            .spyOn(f.store.jobs, "update")
            .mockImplementation(async (...args) => {
              const signal = args[3].signal;
              const result = await update(...args);
              expect(args[3].signal).toBe(signal);
              if (
                args[2].kind === "settle-usage" &&
                result.status !== "complete" &&
                result.status !== "partial"
              )
                settlementFailures.push(result.error.code);
              return result;
            })
        : undefined;
    const image = vi
      .spyOn(FigmaHttpsTransport.prototype, "image")
      .mockImplementation(async (_url, budget) => {
        budget.dnsQuery();
        const bytes = png(true, 2, 2);
        budget.receive(bytes.length);
        budget.decoded(bytes.length);
        if (fault === "diagnostic-reference-lease-expired")
          f.advanceClock(5001);
        return { status: 200, mediaType: "image/png", bytes };
      });
    if (fault === "unknown-stage") {
      const directory = path.join(
        f.artifacts,
        ".host-11111111-1111-4111-8111-111111111111",
      );
      await mkdir(directory);
      await writeFile(
        path.join(directory, "22222222-2222-4222-8222-222222222222"),
        beforeBytes,
      );
    }
    if (fault === "changed-stage")
      await writeFile(stagePath, Buffer.from("synthetic changed"));
    if (fault === "pair-link")
      await link(stagePath, path.join(f.outputs, "paired.json"));
    if (fault === "foreign-stage")
      await f.mutateStage((entry) => {
        entry.requestId = "foreign";
      });
    if (fault === "changed-original")
      await f.mutate((record) => {
        record.rowVersion++;
      });
    if (fault === "unrelated-protection") {
      const context = await f.policy.issue({
        jobId: "unrelated",
        requestId: "unrelated",
        signal: new AbortController().signal,
      });
      value(
        await f.store.stage(Buffer.from("uncommitted private bytes"), context),
      );
    }
    if (fault === "missing-protection")
      removeSyntheticCaptureProtection(f.store, f.initial.job.id);
    const run = required(f.runtime.reference).bind(f.runtime);
    let closedProof: (() => unknown) | undefined;
    if (successorCoexistence) {
      expect(await readFile(committedPath)).toEqual(beforeBytes);
      expect((await lstat(committedPath)).ino).not.toBe(
        beforeStageIdentity.ino,
      );
      expect((await lstat(committedPath)).nlink).toBe(1);
    }
    const planned = await run(
      { operation: "reference-plan", requestId },
      new AbortController().signal,
    );
    expect(planned.status, JSON.stringify(planned)).toBe("complete");
    const approved = await run(
      {
        operation: "reference-approve",
        requestId,
        origin,
        expectedProof: required(planned.value?.proposal?.proofSha256),
        confirmation: REFERENCE_APPROVAL_CONFIRMATION,
      },
      new AbortController().signal,
    );
    const diagnostic = fault.startsWith("diagnostic-");
    if (fault !== "valid" && !diagnostic) {
      expect(approved.status, JSON.stringify(approved)).toBe("failed");
      expect(image).not.toHaveBeenCalled();
      return;
    }
    expect(approved.status, JSON.stringify(approved)).toBe("complete");
    const legacy = diagnostic
      ? vi
          .spyOn(referenceDecoder, "decodeReference")
          .mockRejectedValueOnce(
            new HostBoundaryError(
              "INVALID_INPUT",
              "Synthetic legacy phase unknown.",
            ),
          )
      : undefined;
    const result = await run(
      {
        operation: "reference-download",
        requestId,
        expectedApproval: required(approved.value?.approval?.sha256),
        confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
      },
      new AbortController().signal,
    );
    const decoderCalls = legacy?.mock.calls.length;
    legacy?.mockRestore();
    settlement?.mockRestore();
    if (fault === "diagnostic-reference-lease-expired") {
      expect(result.status).toBe("failed");
      expect(result.value).toBeUndefined();
      expect(result.inputAccounting).toMatchObject({
        phase: "acquisition",
        networkBytes: 87,
      });
      expect(settlementFailures).toEqual(["CONFLICT"]);
      expect(decoderCalls).toBe(0);
      expect(image).toHaveBeenCalledTimes(1);
      expect(api).not.toHaveBeenCalled();
      expect(f.vault).not.toHaveBeenCalled();
      expect(await f.record()).toEqual(beforeRecord);
      expect(await f.stages()).toEqual(beforeStages);
      expect(await readFile(stagePath)).toEqual(beforeBytes);
      return;
    }
    expect(result.status, JSON.stringify(result)).toBe(
      diagnostic ? "unavailable" : "complete",
    );
    if (diagnostic) {
      expect(result.value?.evidence?.referenceDiagnostic).toBeUndefined();
      const originalReferenceFiles = await Promise.all(
        (await readdir(path.join(f.artifacts, "blobs"))).map(
          async (name) =>
            [
              name,
              await readFile(path.join(f.artifacts, "blobs", name)),
            ] as const,
        ),
      );
      if (fault === "diagnostic-unknown-stage") {
        const directory = path.join(
          f.artifacts,
          ".host-11111111-1111-4111-8111-111111111111",
        );
        await mkdir(directory);
        await writeFile(
          path.join(directory, "22222222-2222-4222-8222-222222222222"),
          beforeBytes,
        );
      }
      if (fault === "diagnostic-missing-protection")
        removeSyntheticCaptureProtection(
          f.store,
          required(result.value?.job?.id),
        );
      if (fault === "diagnostic-receipt-mutation")
        mutateOpenSyntheticCapture(
          f.store,
          required(result.value?.job?.id),
          (record) => {
            required(record.job.receipt).idempotency.payloadSha256 = "f".repeat(
              64,
            );
          },
        );
      const planned = await run(
        { operation: "reference-diagnostic-plan", requestId },
        new AbortController().signal,
      );
      if (fault !== "diagnostic-valid" && !retained) {
        expect(planned.status, JSON.stringify(planned)).toBe("failed");
        expect(image).toHaveBeenCalledTimes(1);
        expect(await f.record()).toEqual(beforeRecord);
        expect(await f.stages()).toEqual(beforeStages);
        expect(await readFile(stagePath)).toEqual(beforeBytes);
        for (const [name, bytes] of originalReferenceFiles)
          expect(
            (await readFile(path.join(f.artifacts, "blobs", name))).equals(
              bytes,
            ),
          ).toBe(true);
        for (const [name, bytes] of exports)
          expect(
            (await readFile(path.join(f.outputs, name))).equals(bytes),
          ).toBe(true);
        return;
      }
      expect(planned.status, JSON.stringify(planned)).toBe("complete");
      const approved = await run(
        {
          operation: "reference-diagnostic-approve",
          requestId,
          origin,
          expectedProof: required(planned.value?.proposal?.proofSha256),
          confirmation: DIAGNOSTIC_APPROVAL_CONFIRMATION,
        },
        new AbortController().signal,
      );
      expect(approved.status, JSON.stringify(approved)).toBe("complete");
      if (retained && !offlinePublication) f.setFault("job-after-artifacts");
      const offlineStage = offlinePublication
        ? vi
            .spyOn(ProjectFileSystem.prototype, "publish")
            .mockRejectedValueOnce(
              new HostBoundaryError(
                "INPUT_LIMIT",
                "Synthetic retained stage-only publication",
              ),
            )
        : undefined;
      const downloaded = await run(
        {
          operation: "reference-diagnostic-download",
          requestId,
          expectedApproval: required(approved.value?.approval?.sha256),
          confirmation: DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
        },
        new AbortController().signal,
      );
      offlineStage?.mockRestore();
      expect(downloaded.status, JSON.stringify(downloaded)).toBe(
        retained ? "interrupted" : "complete",
      );
      if (retained) {
        f.setFault(undefined);
        if (fault === "diagnostic-retained-coexisting-current-only") {
          value(
            await f.ordinaryReceipt(
              "later_unprotected_same_content",
              beforeBytes,
            ),
          );
          expect(await readFile(committedPath)).toEqual(beforeBytes);
          expect((await lstat(committedPath)).ino).not.toBe(
            (await lstat(stagePath)).ino,
          );
        }
        f.advanceClock(40000);
        const metadata = await run(
          {
            operation: "reference-diagnostic-inspect",
            requestId,
            inspection: "metadata-only",
          },
          new AbortController().signal,
        );
        if (fault === "diagnostic-retained-unknown-stage") {
          const extra = path.join(
            f.artifacts,
            ".host-11111111-1111-4111-8111-111111111111",
          );
          await mkdir(extra);
          await writeFile(
            path.join(extra, "22222222-2222-4222-8222-222222222222"),
            beforeBytes,
          );
        }
        if (fault === "diagnostic-retained-missing-protection")
          removeSyntheticCaptureProtection(
            f.store,
            required(downloaded.value?.job?.id),
          );
        if (
          fault === "diagnostic-retained-extra-input" ||
          fault === "diagnostic-retained-extra-output"
        )
          addSyntheticCaptureProtection(
            f.store,
            required(downloaded.value?.job?.id),
            fault === "diagnostic-retained-extra-input" ? "job-input" : "job",
          );
        if (successorCoexistence) {
          const inventory = referencePublications.retainedReferenceInventory;
          vi.spyOn(
            referencePublications,
            "retainedReferenceInventory",
          ).mockImplementationOnce(async (reader, state, proposal, token) => {
            expect(token).toBeDefined();
            closedProof = () =>
              reader.verifiedCaptureOutputs(required(token), proposal);
            const originalBinding = structuredClone(proposal);
            expect(() => reader.verifiedCaptureOutputs({}, proposal)).toThrow();
            expect(() =>
              reader.verifiedCaptureOutputs({ ...token }, proposal),
            ).toThrow();
            expect(() =>
              reader.verifiedCaptureOutputs(
                JSON.parse(JSON.stringify(token)),
                proposal,
              ),
            ).toThrow();
            const outputs = reader.verifiedCaptureOutputs(
              required(token),
              proposal,
            );
            outputs.artifacts.length = 0;
            expect(
              reader.verifiedCaptureOutputs(required(token), proposal).artifacts
                .length,
            ).toBeGreaterThan(0);
            for (const field of [
              "sourceVersion",
              "originalJobId",
              "originalRecordSha256",
              "originalReceiptSha256",
              "acquisitionId",
            ] as const)
              expect(() =>
                reader.verifiedCaptureOutputs(required(token), {
                  ...proposal,
                  binding: { ...proposal.binding, [field]: "wrong" },
                }),
              ).toThrow();
            const foreign = new ReferenceReader(
              reader.work,
              reader.store,
              reader.files,
              reader.context,
              reader.input,
              true,
              true,
            );
            try {
              expect(() =>
                foreign.verifiedCaptureOutputs(required(token), proposal),
              ).toThrow();
            } finally {
              await foreign.close();
            }
            expect(proposal).toEqual(originalBinding);
            const current = vi
              .spyOn(reader.work, "isCurrent")
              .mockReturnValue(false);
            try {
              expect(() =>
                reader.verifiedCaptureOutputs(required(token), proposal),
              ).toThrow();
            } finally {
              current.mockRestore();
            }
            const altered = structuredClone(state);
            const successor = required(
              altered.jobs.find(
                (r) => r.job.id === proposal.binding.originalJobId,
              ),
            );
            const receipt = required(
              altered.receipts.find(
                (entry) => entry.receipt.jobId === successor.job.id,
              ),
            );
            if (fault === "diagnostic-retained-successor-record")
              successor.rowVersion++;
            if (fault === "diagnostic-retained-successor-receipt")
              receipt.receipt.idempotency.payloadSha256 = "f".repeat(64);
            if (fault === "diagnostic-retained-successor-protection")
              altered.references = altered.references.filter(
                (entry) =>
                  !(
                    entry.kind === "job" &&
                    entry.owner === receipt.receipt.id &&
                    entry.artifactId === stage.staged.artifact.id
                  ),
              );
            if (fault === "diagnostic-retained-successor-extra-output")
              receipt.receipt.outputs.push(
                structuredClone(stage.staged.artifact),
              );
            if (fault === "diagnostic-retained-successor-foreign-job")
              successor.job.id = "foreign_capture";
            const actualProposal =
              fault === "diagnostic-retained-successor-version"
                ? {
                    ...proposal,
                    binding: { ...proposal.binding, sourceVersion: "wrong" },
                  }
                : proposal;
            if (fault === "diagnostic-retained-successor-authority") {
              const beforeBytes = reader.bytes;
              const revoked = vi
                .spyOn(reader.work, "referenceValidationAuthority")
                .mockRejectedValue(
                  new HostBoundaryError(
                    "FORBIDDEN",
                    "Synthetic current async validation authority revoked.",
                  ),
                );
              try {
                await expect(
                  inventory(reader, altered, actualProposal, token),
                ).rejects.toThrow();
                expect(reader.bytes).toBe(beforeBytes);
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic current async validation authority revoked.",
                );
              } finally {
                revoked.mockRestore();
              }
            }
            const inventoryResult = await inventory(
              reader,
              altered,
              actualProposal,
              token,
            );
            if (validSuccessor) {
              expect(inventoryResult.committedHistoryArtifacts).toEqual([]);
              expect(inventoryResult.successorCaptureHistoryArtifacts).toEqual([
                stage.staged.artifact,
              ]);
              const providerArtifacts = reader
                .verifiedCaptureOutputs(required(token), proposal)
                .artifacts.filter((item) =>
                  ["metadata", "nodes", "render-map"].includes(item.role),
                )
                .map((item) => item.artifact);
              expect(providerArtifacts).toContainEqual(stage.staged.artifact);
            }
            return inventoryResult;
          });
        }
        const measured = coexistence || validSuccessor;
        const charges: number[] = [];
        const reserve = ReferenceInput.prototype.reserveRead;
        const meter = measured
          ? vi
              .spyOn(ReferenceInput.prototype, "reserveRead")
              .mockImplementation(function (this: ReferenceInput, count) {
                reserve.call(this, count);
                charges.push(count);
              })
          : undefined;
        seam.physicalReads = 0;
        seam.measureReads = measured;
        const recovered = await f
          .validateRetained(required(metadata.value?.metadata?.jobSha256))
          .finally(() => {
            seam.measureReads = false;
            meter?.mockRestore();
          });
        if (closedProof) expect(closedProof).toThrow();
        expect(recovered.status, JSON.stringify(recovered)).toBe(
          fault === "diagnostic-retained-valid" || coexistence || validSuccessor
            ? "complete"
            : "failed",
        );
        if (fault === "diagnostic-retained-coexisting-current-only")
          expect(recovered).toMatchObject({
            status: "failed",
            reason: "inventory-invalid",
            error: { code: "ARTIFACT_INTEGRITY" },
            inventoryFailure: {
              check: "publication-shape",
              category: "history-stage",
              detail: "unproven-history-coexistence",
            },
          });
        if (
          fault === "diagnostic-retained-valid" ||
          coexistence ||
          validSuccessor
        ) {
          expect(recovered.value).toMatchObject({
            historicalStatus: "interrupted",
            eligibility: "eligible-for-recovery-review",
          });
          expect(recovered.inputAccounting?.privateBytes).toBeLessThan(
            26214400,
          );
          expect(recovered.inputAccounting?.networkBytes).toBe(0);
          expect(recovered.inventoryFailure).toBeUndefined();
          if (measured && !offlinePublication) {
            const charged = charges.reduce((sum, count) => sum + count, 0);
            const eof = charges.filter((count) => count === 1).length;
            expect(recovered.inputAccounting?.privateBytes).toBe(charged);
            expect(charged).toBe(seam.physicalReads + eof);
            expect(
              charges.filter((count) => count === beforeBytes.length).length,
            ).toBeGreaterThanOrEqual(2);
            const measurement = {
              physical: seam.physicalReads,
              eof,
              charged,
              network: recovered.inputAccounting?.networkBytes,
            };
            if (coexistence)
              expect(measurement).toEqual({
                physical: 54713,
                eof: 32,
                charged: 54745,
                network: 0,
              });
            else
              expect(measurement).toEqual({
                physical: 53879,
                eof: 32,
                charged: 53911,
                network: 0,
              });
            expect(await readFile(committedPath)).toEqual(beforeBytes);
            if (beforeCommittedIdentity)
              expect((await lstat(committedPath)).ino).toBe(
                beforeCommittedIdentity.ino,
              );
            expect((await lstat(stagePath)).ino).toBe(beforeStageIdentity.ino);
            expect((await lstat(committedPath)).nlink).toBe(1);
            expect((await lstat(stagePath)).nlink).toBe(1);
          }
          if (offlinePublication) {
            const command = {
              requestId,
              expectedJob: required(metadata.value?.metadata?.jobSha256),
            };
            const plan = await f.runOffline({
              ...command,
              operation: "reference-recovery-apply-plan",
            });
            expect(plan.status, JSON.stringify(plan)).toBe("complete");
            const recovered = await f.runOffline({
              ...command,
              operation: "reference-recovery-apply",
              expectedProof: required(plan.plan?.proofSha256),
              confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
            });
            expect(recovered.status, JSON.stringify(recovered)).toBe(
              "complete",
            );
            const converted = await f.runOffline({
              ...command,
              operation: "convert-reference",
              expectedRecovery: required(recovered.receiptSha256),
              confirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
            });
            expect(converted.status, JSON.stringify(converted)).toBe(
              "complete",
            );
            expect(converted.conversion?.readiness).not.toBe("ready");
          }
        }
      }
      await f.reopen();
      const inspect = required(f.runtime.reference).bind(f.runtime);
      if (!retained)
        expect(
          (
            await inspect(
              { operation: "reference-diagnostic-inspect", requestId },
              new AbortController().signal,
            )
          ).value?.receipt,
        ).toEqual(downloaded.value?.receipt);
      const original = await inspect(
        { operation: "reference-inspect", requestId },
        new AbortController().signal,
      );
      expect(original.value?.job).toEqual(result.value?.job);
      expect(original.value?.receipt).toEqual(result.value?.receipt);
      expect(original.value?.evidence).toEqual(result.value?.evidence);
      for (const [name, bytes] of originalReferenceFiles)
        expect(
          (await readFile(path.join(f.artifacts, "blobs", name))).equals(bytes),
        ).toBe(true);
      expect(image).toHaveBeenCalledTimes(2);
    } else expect(image).toHaveBeenCalledTimes(1);
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(await f.record()).toEqual(beforeRecord);
    expect(await f.stages()).toEqual(beforeStages);
    expect(await readFile(stagePath)).toEqual(beforeBytes);
    for (const [name, bytes] of priorFiles)
      expect(
        (await readFile(path.join(f.artifacts, "blobs", name))).equals(bytes),
      ).toBe(true);
    for (const [name, bytes] of exports)
      expect((await readFile(path.join(f.outputs, name))).equals(bytes)).toBe(
        true,
      );
  },
  60000,
);
