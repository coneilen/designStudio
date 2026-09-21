import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
import { parseFigmaSelection } from "@design-studio/figma-import";
import { HostBoundaryError, ProjectFileSystem } from "@design-studio/host";
import { JobService } from "@design-studio/jobs";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import {
  type JobWorkerExpected,
  LocalStore,
  type StoredJob,
} from "@design-studio/storage";
import { afterEach, expect, it, vi } from "vitest";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../../project-host/src/capture-recovery-profile.js";
import {
  addSyntheticStoppedCaptures,
  corruptSyntheticCapture,
  mutateOpenSyntheticCapture,
} from "../../storage/tests/capture-recovery-corruption.js";
import {
  CAPTURE_RECOVERY_CONFIRMATION,
  nativeCaptureResources,
} from "../src/capture-recovery.js";
import {
  assembleNativeCapture,
  type NativeCaptureRuntime,
} from "../src/capture-runtime-internal.js";

const seam = vi.hoisted(() => ({ work: undefined as CaptureWork | undefined }));
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
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    seam.work = undefined;
  }
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

async function fixture(
  retainStage = true,
  cooldown?: "future" | "unknown" | "elapsed",
) {
  const root = await mkdtemp(
    path.join(tmpdir(), "capture-recovery-synthetic-"),
  );
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
  let store: LocalStore;
  let policy: ReturnType<typeof nativeCapturePolicy>;
  let credentialSha256 = "b".repeat(64);
  let admitted = true;
  let captureAllowed = false;
  let fault: string | undefined;
  let beforeCommit: (() => void) | undefined;
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
    store = await openStore({
      ...options,
      fault: (point) => {
        if (point === "before-commit") beforeCommit?.();
        if (point === fault) throw new Error("Synthetic storage interruption");
      },
    });
    return store;
  });
  const open = async () => {
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
      },
      readyCredential: ready,
      recoveryAuthority: async () => {
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
    runtime = await assembleNativeCapture(project);
    return { policy, store, runtime };
  };
  const initialOwners = await open();
  cleanups.push(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
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
    signal: new AbortController().signal,
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
    signal: new AbortController().signal,
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
  const initial = structuredClone(record);
  const input = {
    operation: "recover" as const,
    requestId: originalRequestId,
    failedJobId: originalJobId,
    nextRequestId: "next_request",
  };
  return {
    root,
    artifacts,
    outputs,
    project,
    initial,
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
      return policy;
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
      await runtime.close();
      await open();
    },
    async record() {
      const context = await policy.issue({
        jobId: originalJobId,
        requestId: originalRequestId,
        signal: new AbortController().signal,
      });
      return value(await store.jobs.get(originalJobId, context));
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
      const result = await runtime.recover(input, new AbortController().signal);
      expect(result.status, JSON.stringify(result)).toBe("complete");
      return required(result.value).proposal;
    },
  };
}

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
