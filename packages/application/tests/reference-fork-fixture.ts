import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateContract } from "@design-studio/contracts";
import { ProjectFileSystem } from "@design-studio/host";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { expect, vi } from "vitest";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { loadNative, type ReadLease } from "../../project-host/dist/native.js";
import { REFERENCE_FORK_POLICY_SHA256 } from "../../project-host/dist/reference-fork-profile.js";
import { pinImmutableReferenceDatabase } from "../../project-host/dist/reference-validation-database.js";
import { pinRetainedReferenceEntry } from "../../project-host/dist/reference-validation-entry.js";
import { referenceForkCreation } from "../../project-host/src/reference-fork-creation.js";
import { createRetainedOwnerFixture } from "../../project-host/tests/retained-owner-fixture.js";
import { NativeCaptureCleanupRequired } from "../src/capture-runtime-internal.js";
import {
  openNativeReferenceFork,
  REFERENCE_FORK_CONFIRMATION,
} from "../src/reference-fork.js";
import { openNativeReferenceForkResult } from "../src/reference-fork-result.js";
import { ReferenceInput } from "../src/reference-input.js";

export async function runTransferredForkFixture(
  sourceWork: CaptureWork,
  binding: {
    expectedJob: string;
    expectedRecovery: string;
    fixtureClockNowMs: number;
  },
  signal: AbortSignal,
  admit: (work: CaptureWork) => void,
  cleanup: (work: () => Promise<void>) => void,
) {
  const native = await loadNative();
  const sid = native.principal();
  const directory = await mkdtemp(
    path.join(path.dirname(sourceWork.project.paths.temp), "fork-owned-"),
  );
  let created = false;
  let handedOff = false;
  let destinationOwner:
    | Awaited<ReturnType<typeof createRetainedOwnerFixture>>
    | undefined;
  const readPaths: string[] = [];
  const corrupt =
    process.env.DESIGN_STUDIO_INSPECTION_FAULT === "fork-source-tamper";
  let corrupted = false;
  const failClose = process.env.DESIGN_STUDIO_INSPECTION_FAULT === "fork-close";
  const lateCancel =
    process.env.DESIGN_STUDIO_INSPECTION_FAULT === "fork-close-cancel";
  const lateDeadline =
    process.env.DESIGN_STUDIO_INSPECTION_FAULT === "fork-close-deadline";
  const originalAbort = new AbortController();
  const executionSignal = lateCancel
    ? AbortSignal.any([signal, originalAbort.signal])
    : signal;
  let finalizationOffset = 0;
  let destinationStore: LocalStore | undefined;
  let closeFailed = false;
  const closeStore = LocalStore.prototype.close;
  if (failClose)
    vi.spyOn(LocalStore.prototype, "close").mockImplementation(function (
      this: LocalStore,
    ) {
      if (this === destinationStore && !closeFailed) {
        closeFailed = true;
        throw new Error("Synthetic retained destination close");
      }
      closeStore.call(this);
    });
  if (corrupt) {
    const read = LocalStore.prototype.readVerified;
    vi.spyOn(LocalStore.prototype, "readVerified").mockImplementation(
      async function (this: LocalStore, reference, context) {
        const result = await read.call(this, reference, context);
        if (
          !corrupted &&
          context.projectId === sourceWork.project.projectId &&
          result.status === "complete"
        ) {
          result.value.bytes[0] = (result.value.bytes[0] ?? 0) ^ 1;
          corrupted = true;
        }
        return result;
      },
    );
  }
  const ledger: { phase: string; bytes: number }[] = [];
  const reserve = ReferenceInput.prototype.reserveRead;
  vi.spyOn(ReferenceInput.prototype, "reserveRead").mockImplementation(
    function (this: ReferenceInput, bytes) {
      ledger.push({ phase: this.phase, bytes });
      reserve.call(this, bytes);
    },
  );
  vi.spyOn(
    ProjectFileSystem.prototype,
    "inspectRetainedReference",
  ).mockImplementation(async () => {
    throw new Error("Fork must never traverse the retained stage namespace.");
  });
  const open = LocalStore.open.bind(LocalStore);
  const openSpy = vi
    .spyOn(LocalStore, "open")
    .mockImplementation(async (options) => {
      if (options.projectId === sourceWork.project.projectId) {
        expect(options.access).toBe("read-only");
        const read = options.fileSystem.read.bind(options.fileSystem);
        options.fileSystem.read = (input, context) => {
          expect(input.path).toMatch(/^blobs\/[0-9a-f]{64}$/);
          readPaths.push(input.path);
          return read(input, context);
        };
      } else {
        expect(options.referenceFork).toBeDefined();
        expect(options.referenceRecovery).toBeUndefined();
      }
      const store = await open(options);
      if (options.referenceFork) destinationStore = store;
      return store;
    });
  let runtime: ReturnType<typeof openNativeReferenceFork> | undefined;
  cleanup(async () => {
    await runtime?.close();
    destinationOwner?.close();
    openSpy.mockRestore();
    if (!handedOff) await rm(directory, { recursive: true, force: true });
  });
  let sourcePolicy: ReturnType<typeof nativeCapturePolicy>;
  const sourceFork: CaptureWork = {
    ...sourceWork,
    get policy() {
      return sourcePolicy;
    },
    close: () => {
      sourcePolicy.close();
      sourceWork.close();
    },
    referenceForkAuthority: async () => {
      await sourceWork.current();
      return REFERENCE_FORK_POLICY_SHA256;
    },
    pinReferenceForkDatabase: async () =>
      pinImmutableReferenceDatabase({
        filename: sourceWork.project.paths.database,
        sid,
        retainedPins: new Set(),
        authoritySha256: REFERENCE_FORK_POLICY_SHA256,
        authorize: sourceWork.current,
      }),
  };
  admit(sourceFork);
  sourcePolicy = nativeCapturePolicy(sourceFork);
  const sourceStarted = performance.now();
  vi.spyOn(sourcePolicy.clock, "now").mockImplementation(
    () =>
      binding.fixtureClockNowMs +
      finalizationOffset +
      Math.floor(performance.now() - sourceStarted),
  );
  runtime = openNativeReferenceFork(sourceWork.project, async () => {
    expect(created).toBe(false);
    created = true;
    const root = path.join(directory, "ds-ph-fork-destination");
    native.createDirectory(root, sid);
    destinationOwner = await createRetainedOwnerFixture(root);
    await destinationOwner.declareTree("artifacts");
    for (const child of ["artifacts", "outputs", "db"])
      native.createDirectory(path.join(root, child), sid);
    native.createFile(
      path.join(root, "db", "state.sqlite"),
      sid,
      Buffer.alloc(0),
    );
    let live = true;
    let policy: ReturnType<typeof nativeCapturePolicy>;
    const creation = referenceForkCreation({
      root: path.join(root, "artifacts"),
      sid,
      authorize: async (context) => {
        expect(context.projectId).toBe("project_fork_synthetic");
        expect(context.jobId).toMatch(/^fork_reference_/);
        expect(context.authorization.egress).toBe("deny");
        if (!live) throw new Error("Synthetic destination owner closed");
      },
    });
    const project: CaptureProject = {
      projectId: "project_fork_synthetic",
      artifactRootId: "artifacts_fork_synthetic",
      paths: {
        temp: root,
        inputs: root,
        database: path.join(root, "db", "state.sqlite"),
        artifacts: path.join(root, "artifacts"),
        outputs: path.join(root, "outputs"),
      },
      principal: sourceWork.project.principal,
      reference: sourceWork.project.reference,
      recheck: async () => {
        if (!live) throw new Error("Destination owner closed");
      },
      close: async () => {
        if (lateCancel) {
          await Promise.resolve();
          originalAbort.abort();
        }
        if (lateDeadline) {
          await Promise.resolve();
          finalizationOffset = 30001;
        }
      },
    };
    const work: CaptureWork = {
      createReferenceForkStage: creation.create,
      ...sourceWork,
      project,
      permissionScope: "fork-synthetic",
      get policy() {
        return policy;
      },
      current: project.recheck,
      isCurrent: () => live,
      close: () => {
        creation.close();
        live = false;
        policy.close();
      },
      attestDatabase: async (filename) => {
        expect(filename).toBe(project.paths.database);
      },
      referenceForkAuthority: async () => {
        await project.recheck();
        return REFERENCE_FORK_POLICY_SHA256;
      },
      pinReferenceForkDatabase: async () => {
        throw new Error("Destination immutable source pin forbidden");
      },
      readyCredential: async () => {
        throw new Error("No credential");
      },
      credentials: () => {
        throw new Error("No credential");
      },
    };
    admit(work);
    policy = nativeCapturePolicy(work);
    const started = performance.now();
    vi.spyOn(policy.clock, "now").mockImplementation(
      () => binding.fixtureClockNowMs + Math.floor(performance.now() - started),
    );
    return project;
  });
  const running = runtime.execute(
    {
      operation: "reference-fork",
      requestId: "original",
      expectedJob: binding.expectedJob,
      expectedRecovery: binding.expectedRecovery,
      confirmation: REFERENCE_FORK_CONFIRMATION,
    },
    executionSignal,
  );
  if (failClose) {
    await expect(running).rejects.toBeInstanceOf(NativeCaptureCleanupRequired);
    expect(closeFailed).toBe(true);
    expect(sourceWork.isCurrent()).toBe(true);
    expect(runtime.failureResult?.conversion).toBeUndefined();
    expect(runtime.failureResult?.partialDestination).toBe("blocked-no-replay");
    expect(runtime.failureResult?.inputAccounting.privateBytes).toBe(
      ledger.reduce((n, row) => n + row.bytes, 0),
    );
    await runtime.close();
    expect(sourceWork.isCurrent()).toBe(false);
    return;
  }
  const result = await running;
  if (lateCancel || lateDeadline) {
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(
      lateCancel ? "CANCELLED" : "DEADLINE_EXCEEDED",
    );
    expect(result.conversion).toBeUndefined();
    expect(result.partialDestination).toBe("blocked-no-replay");
    expect(sourceWork.isCurrent()).toBe(false);
    expect(result.inputAccounting.privateBytes).toBe(
      ledger.reduce((n, row) => n + row.bytes, 0),
    );
    return;
  }
  if (corrupt) {
    expect(corrupted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ARTIFACT_INTEGRITY");
    expect(result.destinationProjectId).toBeUndefined();
    expect(created).toBe(false);
    expect(result.inputAccounting.privateBytes).toBe(
      ledger.reduce((n, row) => n + row.bytes, 0),
    );
    return;
  }
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.destinationProjectId).toBe("project_fork_synthetic");
  expect(result.conversion?.operationId).toMatch(/^fork_reference_/);
  expect(result.conversion?.outputs.length).toBeGreaterThan(6);
  expect(result.inputAccounting.networkBytes).toBe(0);
  expect(result.inputAccounting.privateBytes).toBeLessThanOrEqual(26214400);
  expect(ledger.reduce((total, row) => total + row.bytes, 0)).toBe(
    result.inputAccounting.privateBytes,
  );
  expect(new Set(ledger.map((row) => row.phase))).toEqual(
    new Set(["proof", "commit", "inspection"]),
  );
  expect(ledger.filter((row) => row.bytes === 1).length).toBeGreaterThanOrEqual(
    readPaths.length,
  );
  expect(created).toBe(true);
  expect(readPaths.length).toBeGreaterThan(0);
  const handoff = process.env.DESIGN_STUDIO_V7_HANDOFF;
  if (!handoff || !result.conversion)
    throw new Error("Missing owned cold fork handoff.");
  if (!destinationOwner)
    throw new Error("Missing declared destination owner fixture.");
  const natural = await destinationOwner.inspect();
  const foreign = natural.filter((entry) => entry.owner !== sid);
  expect(foreign).toEqual([]);
  const origin = result.conversion.origin;
  const originAncestors = natural.filter(
    (entry) =>
      entry.relative === "artifacts" ||
      entry.relative === "artifacts/blobs" ||
      entry.relative === `artifacts/blobs/${origin.sha256}`,
  );
  expect(originAncestors).toHaveLength(3);
  const pins = new Set<ReadLease>();
  const admission = pinRetainedReferenceEntry({
    root: path.join(directory, "ds-ph-fork-destination", "artifacts"),
    relative: `blobs/${origin.sha256}`,
    directory: false,
    sid,
    retainedPins: pins,
    authorize: async () => {
      executionSignal.throwIfAborted();
    },
  });
  if (originAncestors.some((entry) => entry.owner !== sid))
    await expect(admission).rejects.toThrow(/owner/);
  else (await admission).close();
  expect(pins.size).toBe(0);
  const after = await destinationOwner.inspect();
  expect(after).toEqual(natural);
  destinationOwner.close();
  console.log(
    JSON.stringify({
      scope: "synthetic-fork-destination-owner-observation",
      entries: natural.length,
      naturalOwnerDenials: foreign.length,
      originPathHasForeignOwner: originAncestors.some(
        (entry) => entry.owner !== sid,
      ),
      foreignEntryKinds: [
        ...new Set(
          foreign.map((entry) =>
            entry.relative === "artifacts/blobs"
              ? "blob-directory"
              : entry.directory
                ? "stage-directory"
                : "published-blob",
          ),
        ),
      ],
      ownerMutations: 0,
      bytesDaclAndIdentityUnchanged: true,
    }),
  );
  await writeFile(
    path.join(path.dirname(handoff), "fork-result-handoff.json"),
    JSON.stringify({
      root: path.join(directory, "ds-ph-fork-destination"),
      receipt: result.conversion.receiptSha256,
      artifacts: result.conversion.artifacts,
      origin: result.conversion.origin,
      outputs: result.conversion.outputs,
      fixtureClockNowMs: binding.fixtureClockNowMs,
    }),
    { flag: "wx" },
  );
  handedOff = true;
  console.log(
    JSON.stringify({
      scope: "authentic-recorded-input-fork",
      status: result.status,
      outputCount: result.conversion?.outputs.length,
      privateBytes: result.inputAccounting.privateBytes,
      sourceBodyReadsOnlyRecordedBlobs: true,
      nativeDestinationPublication: true,
    }),
  );
}

export async function consumeTransferredForkFixture(
  signal: AbortSignal,
  admit: (work: CaptureWork) => void,
  cleanup: (work: () => Promise<void>) => void,
) {
  const location = process.env.DESIGN_STUDIO_FORK_RESULT_HANDOFF;
  if (!location) throw new Error("Missing cold result handoff.");
  const handoff = JSON.parse(await readFile(location, "utf8"));
  expect(path.dirname(path.dirname(handoff.root))).toBe(path.dirname(location));
  expect(path.basename(path.dirname(handoff.root))).toMatch(/^fork-owned-/);
  expect((await lstat(handoff.root)).isSymbolicLink()).toBe(false);
  const native = await loadNative(),
    sid = native.principal();
  const roles = [
    "design",
    "report",
    "reference",
    "wrong-reference",
    "close-cancel",
    "close-deadline",
  ] as const;
  const sourceOrigin = handoff.outputs.find(
    (a: { sha256: string }) => a.sha256 === handoff.origin.sha256,
  );
  expect(sourceOrigin).toBeDefined();
  for (const mode of roles) {
    const role =
      mode === "wrong-reference" ||
      mode === "close-cancel" ||
      mode === "close-deadline"
        ? "design"
        : mode;
    const abort = new AbortController();
    const ownedSignal = AbortSignal.any([signal, abort.signal]);
    let elapsed = 0;
    const pins = new Set<ReadLease>();
    let live = true,
      policy: ReturnType<typeof nativeCapturePolicy>;
    const project: CaptureProject = {
      projectId: "project_fork_synthetic",
      artifactRootId: "artifacts_fork_synthetic",
      principal: { actorId: "actor_synthetic" } as CaptureProject["principal"],
      reference: {
        id: "credential_synthetic",
        providerId: "figma_rest",
        store: "windows-credential-manager",
      },
      paths: {
        temp: handoff.root,
        inputs: handoff.root,
        artifacts: path.join(handoff.root, "artifacts"),
        outputs: path.join(handoff.root, "outputs"),
        database: path.join(handoff.root, "db", "state.sqlite"),
      },
      recheck: async () => {
        if (!live) throw new Error("Cold owner closed");
      },
      close: async () => {},
    };
    const work: CaptureWork = {
      project,
      actorId: "actor_synthetic",
      permissionScope: "fork-synthetic",
      sqliteBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      policyId: "figma-capture-v1",
      policySha256: "a".repeat(64),
      imageOrigins: [],
      apiOrigins: [],
      get policy() {
        return policy;
      },
      current: project.recheck,
      isCurrent: () => live,
      readyCredential: async () => {
        throw new Error("No credential");
      },
      credentials: () => {
        throw new Error("No credential");
      },
      recoveryAuthority: async () => {
        throw new Error("No recovery");
      },
      referenceForkAuthority: async () => {
        await project.recheck();
        return REFERENCE_FORK_POLICY_SHA256;
      },
      pinReferenceForkDatabase: async () =>
        pinImmutableReferenceDatabase({
          filename: project.paths.database,
          sid,
          retainedPins: pins,
          authoritySha256: REFERENCE_FORK_POLICY_SHA256,
          authorize: project.recheck,
        }),
      pinReferenceValidationEntry: (rootId, relative, directory) => {
        expect(rootId).toBe(project.artifactRootId);
        return pinRetainedReferenceEntry({
          root: project.paths.artifacts,
          relative,
          directory,
          sid,
          retainedPins: pins,
          authorize: project.recheck,
        });
      },
      attestDatabase: async (filename) => {
        expect(filename).toBe(project.paths.database);
      },
      close: () => {
        expect(pins.size).toBe(0);
        live = false;
        policy.close();
        if (mode === "close-cancel") abort.abort();
        if (mode === "close-deadline") elapsed = 30001;
      },
    };
    admit(work);
    policy = nativeCapturePolicy(work);
    const started = performance.now();
    vi.spyOn(policy.clock, "now").mockImplementation(
      () =>
        handoff.fixtureClockNowMs +
        elapsed +
        Math.floor(performance.now() - started),
    );
    const runtime = openNativeReferenceForkResult(project);
    cleanup(() => runtime.close());
    // Obtain the reference role from the supported receipt-bound origin manifest, not a raw path read.
    const reference =
      mode === "wrong-reference"
        ? handoff.origin
        : handoff.artifacts.find((a: { role: string }) => a.role === role)
            ?.artifact;
    expect(reference).toBeDefined();
    let borrowed: Uint8Array | undefined;
    const result = await runtime.execute(
      {
        operation: "reference-fork-result",
        requestId: "read-result",
        expectedReceipt: handoff.receipt,
      },
      ownedSignal,
      {
        role,
        reference,
        consume: async (bytes) => {
          borrowed = bytes;
          if (role === "reference")
            expect([...bytes.subarray(0, 8)]).toEqual([
              137, 80, 78, 71, 13, 10, 26, 10,
            ]);
          else {
            const parsed = JSON.parse(
              new TextDecoder("utf8", { fatal: true }).decode(bytes),
            );
            if (role === "design")
              expect(validateContract("DesignIR", parsed).success).toBe(true);
            else expect(parsed.readiness).toBeDefined();
          }
        },
      },
    );
    if (mode === "wrong-reference") {
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("FORBIDDEN");
      expect(borrowed).toBeUndefined();
    } else {
      expect(result.status, JSON.stringify(result)).toBe(
        mode.startsWith("close-") ? "failed" : "complete",
      );
      if (mode.startsWith("close-")) {
        expect(result.conversion).toBeUndefined();
        expect(result.error?.code).toBe(
          mode === "close-cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED",
        );
      }
      expect(borrowed?.every((b) => b === 0)).toBe(true);
    }
    expect(pins.size).toBe(0);
  }
  console.log(
    JSON.stringify({
      scope: "cold-committed-fork-consumer",
      roles: ["design", "report", "reference"],
      verifiedBytesConsumed: true,
      borrowedBytesZeroed: true,
    }),
  );
}
