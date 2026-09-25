import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_BUDGETS,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import Database from "better-sqlite3";
import {
  afterEach,
  aroundEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  vi,
  test as vitestTest,
} from "vitest";
import { AsyncTestScope } from "../../jobs/tests/async-scope.js";
import {
  inTestScope,
  ownTests,
  ownTestWork,
  testScope,
} from "../../jobs/tests/test-scope.js";
import {
  decodeBackup,
  encodeBackup,
  LocalStore,
  type StorageOptions,
} from "../src/index.js";
import { storedJob } from "../src/job-codec.js";
import type {
  JobCompletion,
  JobStorageOptions,
  JobSubmission,
  JobWorkerExpected,
  StoredJob,
} from "../src/job-types.js";
import {
  closeSettledStores,
  inStorageTest,
  storageTestSignal,
} from "./lifetime.js";
import { bytes, context, diskFixture, hash, revision } from "./support.js";

const roots: string[] = [];
const stores: LocalStore[] = [];
const rawDatabases = new Set<Database.Database>();
const seedScopes: AsyncTestScope[] = [];
type CancelScenario = "restore-control" | "aggregate-control";
type CancelPhase =
  | "prepare-source"
  | "prepare-destination"
  | "prepare-oversized-row"
  | "tamper"
  | "restore-reject"
  | "verify-empty"
  | "aggregate-reject"
  | "cleanup";
type CancelPhaseEvent = {
  scope: "synthetic-storage-cancellation";
  scenario: CancelScenario;
  event: "start" | "settled" | "rejected" | "runner-abort";
  phase: CancelPhase | null;
  elapsedMs: number;
  durationMs?: number;
  runnerAborted: boolean;
};
function cancellationTelemetry(
  scenario: CancelScenario | undefined,
  original: AbortSignal,
  sink: (event: CancelPhaseEvent) => void = (event) =>
    console.log(JSON.stringify(event)),
) {
  const started = performance.now();
  let pending: CancelPhase | null = null;
  let reported = false;
  const emit = (
    event: CancelPhaseEvent["event"],
    phase: CancelPhase | null,
    durationMs?: number,
  ) => {
    if (scenario)
      sink({
        scope: "synthetic-storage-cancellation",
        scenario,
        event,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        runnerAborted: original.aborted,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
  };
  const abort = () => {
    if (!reported) {
      reported = true;
      emit("runner-abort", pending);
    }
  };
  original.addEventListener("abort", abort, { once: true });
  if (original.aborted) abort();
  return {
    async measure<T>(phase: CancelPhase, run: () => Promise<T>): Promise<T> {
      const previous = pending;
      pending = phase;
      const start = performance.now();
      emit("start", phase);
      try {
        const result = await run();
        emit("settled", phase, Math.round(performance.now() - start));
        return result;
      } catch (error) {
        emit("rejected", phase, Math.round(performance.now() - start));
        throw error;
      } finally {
        pending = previous;
      }
    },
    close() {
      original.removeEventListener("abort", abort);
    },
  };
}
const telemetry = new WeakMap<
  AsyncTestScope,
  ReturnType<typeof cancellationTelemetry>
>();
const phase = <T>(name: CancelPhase, work: () => Promise<T>) =>
  required(telemetry.get(testScope())).measure(name, work);
const test = ownTests(vitestTest);
aroundEach((run, context) => {
  const scope = new AsyncTestScope(context.signal);
  const name = context.task.name;
  telemetry.set(
    scope,
    cancellationTelemetry(
      name.startsWith("restore rejects cancellation-control")
        ? "restore-control"
        : name ===
            "aggregate cancellation metadata is bounded before idempotency lookup materializes rows"
          ? "aggregate-control"
          : undefined,
      context.signal,
    ),
  );
  return inTestScope(scope, () => inStorageTest(scope.signal, run));
});
const nativeBinding = resolve(
  ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
);
const error = {
  code: "INTERRUPTED" as const,
  message: "Synthetic interruption.",
  retryable: false,
  diagnosticIds: [],
};
afterEach(async () => {
  await phase("cleanup", async () => {
    await testScope().close();
    for (const scope of seedScopes) await scope.close();
    seedScopes.length = 0;
    await closeFixtureResources();
    required(telemetry.get(testScope())).close();
  });
});
async function closeFixtureResources() {
  await closeSettledStores(stores);
  for (const database of rawDatabases) {
    database.close();
    rawDatabases.delete(database);
  }
  for (const root of [...roots]) {
    await rm(root, { recursive: true, force: true });
    roots.splice(roots.indexOf(root), 1);
  }
}
function value<T>(outcome: Outcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  if (outcome.status !== "complete") throw new Error("Expected complete.");
  return outcome.value;
}
function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined)
    throw new Error("Missing fixture value.");
  return item;
}
function fence(record: StoredJob): JobWorkerExpected {
  const lease = record.job.lease;
  if (!lease) throw new Error("Expected lease.");
  return {
    state: record.job.status,
    rowVersion: record.rowVersion,
    leaseId: lease.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    resources: record.resources,
  };
}
function setup(...args: Parameters<typeof setupOriginal>) {
  return ownTestWork(setupOriginal)(...args);
}
async function setupOriginal(
  maxWorkers = 1,
  discovery: JobStorageOptions["discovery"] | null = {
    authorizeOwner: async () => {},
  },
) {
  storageTestSignal().throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "job transactions "));
  roots.push(root);
  storageTestSignal().throwIfAborted();
  const disk = await diskFixture(root);
  storageTestSignal().throwIfAborted();
  let now = Date.parse("2026-09-17T00:00:00.000Z");
  let fault: string | undefined;
  let beforeCommit: (() => void) | undefined;
  let barrier = async () => {};
  let verifier = async () => {};
  const clock = { now: () => now, sleep: async () => {} };
  const options: StorageOptions = {
    databasePath: join(root, "state.sqlite"),
    nativeBinding,
    projectId: "project1",
    artifactRootId: "artifact-root",
    permissionScope: "permission1",
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
    ensurePublicationDurable: async () => barrier(),
    // Labeled logical-migration acknowledgment, not physical backup durability.
    ensureDatabaseBackupDurable: async () => {},
    authorize: async () => {},
    attestLocalDatabase: async () => {},
    canonicalBytes: (input) => bytes(JSON.stringify(input)),
    verifyRevision: async () => {},
    assessApproval: async () => ({
      complete: true,
      blockingDiagnosticIds: [],
      waiverEligibleDiagnosticIds: [],
    }),
    authorizeRestore: async () => {},
    authorizeRetention: async () => {},
    canDiscardStage: async () => false,
    jobs: {
      clock,
      maxWorkers,
      verifyCompletion: async () => verifier(),
      authorizeRecovery: async () => {},
      ...(discovery ? { discovery } : {}),
    },
    fault: (point) => {
      if (point === "before-commit") beforeCommit?.();
      if (fault === point) throw new Error("Synthetic transaction fault.");
    },
  };
  let store = await LocalStore.open(options);
  stores.push(store);
  storageTestSignal().throwIfAborted();
  function ctx(id = "work"): OperationContext {
    return { ...context(id), clock };
  }
  const staged = value(
    await store.stage(bytes("immutable input"), ctx("seed")),
  );
  value(await store.commit([staged], ctx("seed")));
  const input = { id: staged.artifact.id, sha256: staged.artifact.sha256 };
  function submission(id = "job-work", keys: string[] = []): JobSubmission {
    return {
      id,
      operation: "render",
      input,
      resources: {
        snapshotId: input.id,
        sha256: input.sha256,
        componentRegistryRevision: "v1",
        tokenRegistryRevision: "v1",
        selectedModes: {},
      },
      handlerId: "synthetic",
      handlerVersion: "v1",
      authorityRef: "approval1",
      resourceKeys: keys,
      deadline: ctx().deadline,
      budget: { ...DEFAULT_BUDGETS },
    };
  }
  return {
    root,
    disk,
    options,
    ctx,
    submission,
    get store() {
      return store;
    },
    advance(ms: number) {
      now += ms;
    },
    fault(point?: string) {
      fault = point;
    },
    beforeCommit(callback?: () => void) {
      beforeCommit = callback;
    },
    barrier(callback: () => Promise<void>) {
      barrier = callback;
    },
    verifier(callback: () => Promise<void>) {
      verifier = callback;
    },
    async reopen() {
      storageTestSignal().throwIfAborted();
      store.close();
      store = await LocalStore.open(options);
      stores.push(store);
      storageTestSignal().throwIfAborted();
    },
  };
}
async function claim(
  f: Awaited<ReturnType<typeof setup>>,
  keys: string[] = [],
) {
  const queued = value(
    await f.store.jobs.create(f.submission("job-work", keys), f.ctx()),
  );
  return value(
    await f.store.jobs.claim(
      queued.job.id,
      { state: queued.job.status, rowVersion: queued.rowVersion },
      "worker1",
      1000,
      f.ctx(),
    ),
  );
}
async function completion(
  f: Awaited<ReturnType<typeof setup>>,
  record: StoredJob,
) {
  const result = value(
    await f.store.jobs.stage(
      record.job.id,
      fence(record),
      bytes("output"),
      f.ctx(),
    ),
  );
  const output: JobCompletion = {
    outputs: [result.staged],
    outputState: "complete",
    diagnosticIds: [],
  };
  return { record: result.record, output };
}

test("reference metadata inspection is admitted, owner-scoped, body-free and bounded before parsing", async () => {
  const f = await setup();
  const record = value(await f.store.jobs.create(f.submission(), f.ctx()));
  expect(
    await f.store.referenceJobMetadata(record.job.id, f.ctx()),
  ).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
  f.options.referenceInspection = { authorize: async () => {} };
  let reads = 0;
  const read = f.disk.fs.read;
  f.disk.fs.read = async (...args) => {
    reads++;
    return read(...args);
  };
  expect(
    value(await f.store.referenceJobMetadata(record.job.id, f.ctx())),
  ).toEqual({ record, receipt: null, stages: [] });
  expect(
    value(await f.store.referenceJobMetadata("absent", f.ctx())),
  ).toBeNull();
  const foreign = f.ctx();
  foreign.authorization = {
    ...foreign.authorization,
    actorId: "foreign-actor",
  };
  expect(
    await f.store.referenceJobMetadata(record.job.id, foreign),
  ).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
  expect(
    await f.store.referenceJobMetadata(record.job.id, {
      ...f.ctx(),
      projectId: "foreign-project",
    }),
  ).toMatchObject({ status: "failed" });
  for (const overflow of ["job", "stages"]) {
    f.store.close();
    const db = new Database(f.options.databasePath, { nativeBinding });
    try {
      db.prepare("UPDATE jobs SET data=? WHERE id=?").run(
        overflow === "job" ? "x".repeat(262145) : JSON.stringify(record),
        record.job.id,
      );
      if (overflow === "stages")
        for (let i = 0; i < 3; i++)
          db.prepare("INSERT INTO job_stages VALUES (?,?,?)").run(
            `synthetic_${i}`,
            record.job.id,
            "{}",
          );
    } finally {
      db.close();
    }
    await f.reopen();
    expect(
      await f.store.referenceJobMetadata(record.job.id, f.ctx()),
    ).toMatchObject({ status: "failed", error: { code: "INPUT_LIMIT" } });
  }
  expect(reads).toBe(0);
  f.options.referenceInspection = {
    authorize: async () => {
      throw Object.assign(new Error("revoked"), { code: "FORBIDDEN" });
    },
  };
  expect(
    await f.store.referenceJobMetadata(record.job.id, f.ctx()),
  ).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
});

test.each(
  (["verifier", "durability"] as const).flatMap((phase) =>
    (
      [
        "first-output",
        "middle-output",
        "last-output",
        "root",
        "job",
        "design",
      ] as const
    ).map((scope) => ({ phase, scope })),
  ),
)(
  "unbound job commit reauthorizes $scope revoked during $phase",
  async ({ phase, scope }) => {
    const f = await setup();
    let record = await claim(f, ["held-resource"]);
    const payloads = ["first output", "middle output", "last output"];
    const outputs: JobCompletion["outputs"] = [];
    for (const payload of payloads) {
      const staged = value(
        await f.store.jobs.stage(
          record.job.id,
          fence(record),
          bytes(payload),
          f.ctx(),
        ),
      );
      record = staged.record;
      outputs.push(staged.staged);
    }
    const rev = revision(
      "late-revocation",
      outputs.map((output) => output.artifact),
    );
    const output: JobCompletion = {
      outputs,
      outputState: "complete",
      diagnosticIds: [],
      revision: { revision: rev, branch: "main", base: null },
    };
    const original = value(await f.store.backup(f.ctx("backup")));
    let entered: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const awaiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const wait = async () => {
      required(entered)();
      await release;
    };
    if (phase === "verifier") f.verifier(wait);
    else f.barrier(wait);
    const kind =
      scope === "job" ? "job" : scope === "design" ? "design" : "artifact";
    const id =
      scope === "root"
        ? "artifact-root"
        : scope === "job"
          ? record.job.id
          : scope === "design"
            ? rev.designId
            : required(
                scope === "first-output"
                  ? outputs[0]
                  : scope === "middle-output"
                    ? outputs[1]
                    : outputs.at(-1),
              ).artifact.id;
    let revoked = false;
    const deniedChecks: string[] = [];
    f.options.authorize = async (_context, requested) => {
      if (
        revoked &&
        requested.resourceKind === kind &&
        requested.resourceId === id &&
        requested.operation === "write"
      ) {
        deniedChecks.push(id);
        throw Object.assign(new Error("Synthetic current-policy revocation."), {
          code: "FORBIDDEN",
        });
      }
    };
    let discarded = 0;
    let removed = 0;
    const discard = f.disk.fs.discard;
    f.disk.fs.discard = async (...args) => {
      discarded++;
      return discard(...args);
    };
    const remove = f.disk.maintenance.removeBlob;
    f.disk.maintenance.removeBlob = async (...args) => {
      removed++;
      return remove(...args);
    };
    const committing = f.store.jobs.commitJob(
      record.job.id,
      fence(record),
      output,
      f.ctx(),
    );
    await awaiting;
    revoked = true;
    required(resume)();
    expect(await committing).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN" },
    });
    expect(deniedChecks).toEqual([id]);
    expect(discarded).toBe(0);
    expect(removed).toBe(0);
    revoked = false;
    expect(value(await f.store.backup(f.ctx("backup")))).toEqual(original);
    expect(
      value(await f.store.jobs.getStages(record.job.id, f.ctx())),
    ).toHaveLength(3);
    for (const [index, staged] of outputs.entries())
      expect(
        value(
          await f.disk.fs.read(
            { artifactRootId: "artifact-root", path: staged.artifact.path },
            f.ctx(),
          ),
        ),
      ).toEqual(bytes(required(payloads[index])));
    f.store.close();
    const db = new Database(f.options.databasePath, { nativeBinding });
    try {
      for (const staged of outputs) {
        expect(
          db
            .prepare("SELECT 1 FROM artifacts WHERE id=?")
            .get(staged.artifact.id),
        ).toBeUndefined();
        expect(
          db
            .prepare("SELECT 1 FROM artifact_refs WHERE artifact_id=?")
            .get(staged.artifact.id),
        ).toBeUndefined();
      }
      expect(
        db
          .prepare(
            "SELECT 1 FROM receipts WHERE json_extract(data,'$.jobId')=?",
          )
          .get(record.job.id),
      ).toBeUndefined();
      for (const table of ["revisions", "heads", "artifact_bindings"])
        expect(
          db.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      const stored = db
        .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
        .get(record.job.id);
      expect(JSON.parse(required(stored).data)).toEqual(record);
    } finally {
      db.close();
    }
  },
);

test("reused unbound outputs still require live write authority even without a new publication barrier", async () => {
  const f = await setup();
  const running = await claim(f);
  const stage = value(
    await f.store.jobs.stage(
      running.job.id,
      fence(running),
      bytes("immutable input"),
      f.ctx(),
    ),
  );
  const before = value(await f.store.backup(f.ctx("backup")));
  let revoked = false;
  let barriers = 0;
  f.options.authorize = async (_context, scope) => {
    if (
      revoked &&
      scope.resourceKind === "artifact" &&
      scope.resourceId === stage.staged.artifact.id &&
      scope.operation === "write"
    )
      throw Object.assign(new Error("Revoked reused output"), {
        code: "FORBIDDEN",
      });
  };
  f.verifier(async () => {
    revoked = true;
  });
  f.barrier(async () => {
    barriers++;
  });
  expect(
    await f.store.jobs.commitJob(
      running.job.id,
      fence(stage.record),
      {
        outputs: [stage.staged],
        outputState: "complete",
        diagnosticIds: [],
      },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(barriers).toBe(0);
  revoked = false;
  expect(value(await f.store.backup(f.ctx("backup")))).toEqual(before);
  expect(
    value(await f.store.jobs.getJobReceipt(running.job.id, f.ctx())),
  ).toBeNull();
});

test("exact completed job replay verifies reads without adding fresh output-write checks", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  const committed = value(
    await f.store.jobs.commitJob(record.job.id, fence(record), output, f.ctx()),
  );
  const artifactId = required(output.outputs[0]).artifact.id;
  let outputWrites = 0;
  f.options.authorize = async (_context, scope) => {
    if (scope.resourceId === artifactId && scope.operation === "write") {
      outputWrites++;
      throw Object.assign(new Error("No new writes permitted"), {
        code: "FORBIDDEN",
      });
    }
  };
  const noNewPublication = async () => {
    throw new Error("Replay must not publish/verify new completion.");
  };
  f.verifier(noNewPublication);
  f.barrier(noNewPublication);
  expect(
    value(
      await f.store.jobs.commitJob(
        record.job.id,
        fence(record),
        output,
        f.ctx(),
      ),
    ),
  ).toEqual(committed);
  expect(outputWrites).toBe(0);
});

test("trusted owner discovery bootstraps bounded exact grants without reading artifact bytes", async () => {
  const f = await setup();
  const first = value(await f.store.jobs.create(f.submission(), f.ctx()));
  value(await f.store.jobs.create(f.submission("job-other"), f.ctx("other")));
  f.disk.fs.read = async () => {
    throw new Error("Discovery must not read bytes.");
  };
  const ctx = f.ctx("discovery");
  ctx.authorization.grants = [];
  const page = value(await f.store.jobs.discoverOwned({ limit: 1 }, ctx));
  expect(page.descriptors).toHaveLength(1);
  expect(page.nextCursor).not.toBeNull();
  const second = value(
    await f.store.jobs.discoverOwned(
      { limit: 1, cursor: required(page.nextCursor) },
      ctx,
    ),
  );
  expect(second.descriptors).toHaveLength(1);
  const exact = value(
    await f.store.jobs.discoverOwned({ jobId: first.job.id, limit: 1 }, ctx),
  );
  expect(exact.descriptors[0]).toMatchObject({
    jobId: first.job.id,
    actorId: "actor1",
    requestId: "work",
    handlerId: "synthetic",
    physicalInputs: [
      { reference: first.job.input, artifact: first.job.input },
      { reference: first.job.input, artifact: first.job.input },
    ],
  });
  expect(exact.descriptors[0]).not.toHaveProperty("budget");
  expect(exact.descriptors[0]).not.toHaveProperty("lease");
  expect(
    value(await f.store.jobs.discoverOwned({ jobId: "missing", limit: 1 }, ctx))
      .descriptors,
  ).toEqual([]);
  const foreign = {
    ...ctx,
    authorization: { ...ctx.authorization, actorId: "other-owner" },
  };
  expect(
    value(await f.store.jobs.discoverOwned({ limit: 1 }, foreign)).descriptors,
  ).toEqual([]);
  await f.reopen();
  expect(
    value(
      await f.store.jobs.discoverOwned({ jobId: first.job.id, limit: 1 }, ctx),
    ),
  ).toEqual(exact);
});

test("discovery requires dedicated current owner policy before existing or missing lookups", async () => {
  const missing = await setup(1, null);
  for (const id of ["job-work", "absent"])
    expect(
      await missing.store.jobs.discoverOwned(
        { jobId: id, limit: 1 },
        missing.ctx(),
      ),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  let revoked = false;
  const f = await setup(1, {
    authorizeOwner: async (ctx, scope) => {
      expect(scope).toEqual({
        projectId: "project1",
        artifactRootId: "artifact-root",
        permissionScope: "permission1",
      });
      if (revoked || ctx.authorization.actorId !== "actor1")
        throw Object.assign(new Error("owner denied"), { code: "FORBIDDEN" });
    },
  });
  value(await f.store.jobs.create(f.submission(), f.ctx()));
  const foreign = f.ctx("observer");
  foreign.authorization.actorId = "actor2";
  expect(await f.store.jobs.discoverOwned({ limit: 1 }, foreign)).toMatchObject(
    { error: { code: "FORBIDDEN" } },
  );
  expect(
    await f.store.jobs.discoverOwned(
      { limit: 1 },
      { ...f.ctx(), projectId: "wrong" },
    ),
  ).toMatchObject({ status: "failed" });
  revoked = true;
  expect(await f.store.jobs.discoverOwned({ limit: 1 }, f.ctx())).toMatchObject(
    { error: { code: "FORBIDDEN" } },
  );
});

test("discovery owns query/context and rechecks revocation before returning descriptors", async () => {
  let enter: (() => void) | undefined;
  let proceed: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let calls = 0;
  let revoked = false;
  let revokeAfterLookup = false;
  const f = await setup(1, {
    authorizeOwner: async () => {
      if (++calls === 1) {
        required(enter)();
        await gate;
      }
      if (revoked || (revokeAfterLookup && calls === 4))
        throw Object.assign(new Error("revoked"), { code: "FORBIDDEN" });
    },
  });
  value(await f.store.jobs.create(f.submission(), f.ctx()));
  const query = { jobId: "job-work", limit: 1 };
  const ctx = f.ctx("observer");
  const pending = f.store.jobs.discoverOwned(query, ctx);
  await entered;
  query.jobId = "unknown";
  ctx.requestId = "mutated";
  ctx.budget.maxOutputBytes = 1;
  required(proceed)();
  const response = await pending;
  expect(response.requestId).toBe("observer");
  expect(value(response).descriptors[0]?.jobId).toBe("job-work");
  expect(calls).toBe(2);
  revokeAfterLookup = true;
  expect(await f.store.jobs.discoverOwned({ limit: 1 }, f.ctx())).toMatchObject(
    { error: { code: "FORBIDDEN" } },
  );
  expect(calls).toBe(4);
  revoked = true;
  expect(await f.store.jobs.discoverOwned({ limit: 1 }, f.ctx())).toMatchObject(
    { error: { code: "FORBIDDEN" } },
  );
  expect(
    await f.store.jobs.discoverOwned({ limit: 101 }, f.ctx()),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
});

test.each(["reject", "expire", "mutate-auth", "revoke"] as const)(
  "tracked job binding verifier %s preserves fencing and uncommitted evidence",
  async (failure) => {
    const f = await setup();
    const { record, output } = await completion(f, await claim(f));
    const physical = required(output.outputs[0]).artifact;
    const ctx = f.ctx();
    let revoked = false;
    f.options.authorize = async (_ctx, scope) => {
      if (revoked && scope.operation === "write")
        throw Object.assign(new Error("revoked"), { code: "FORBIDDEN" });
    };
    f.options.authorizeArtifactBinding = async () => {
      if (failure === "reject") throw new Error("semantic denial");
      if (failure === "expire") f.advance(1000);
      if (failure === "mutate-auth") ctx.authorization.actorId = "mutated";
      if (failure === "revoke") revoked = true;
    };
    output.referenceBindings = [
      {
        reference: { id: "logical-result", sha256: physical.sha256 },
        artifact: { id: physical.id, sha256: physical.sha256 },
      },
    ];
    expect(
      await f.store.jobs.commitJob(record.job.id, fence(record), output, ctx),
    ).toMatchObject({ status: "failed" });
    revoked = false;
    expect(
      value(await f.store.jobs.getJobReceipt(record.job.id, f.ctx())),
    ).toBeNull();
    expect(
      value(await f.store.jobs.get(record.job.id, f.ctx())).rowVersion,
    ).toBe(record.rowVersion);
    expect(
      value(await f.store.jobs.getStages(record.job.id, f.ctx())),
    ).toHaveLength(1);
    expect(value(await f.store.collectGarbage(f.ctx())).deleted).toEqual([]);
  },
);

test("tracked completion binds logical output atomically and discovery verifies output metadata only", async () => {
  const f = await setup();
  f.options.authorizeArtifactBinding = async () => {};
  const { record, output } = await completion(f, await claim(f));
  const physical = required(output.outputs[0]).artifact;
  output.referenceBindings = [
    {
      reference: { id: "logical-result", sha256: physical.sha256 },
      artifact: { id: physical.id, sha256: physical.sha256 },
    },
  ];
  const complete = value(
    await f.store.jobs.commitJob(record.job.id, fence(record), output, f.ctx()),
  );
  expect(
    value(
      await f.store.verify(
        required(output.referenceBindings[0]).reference,
        f.ctx(),
      ),
    ),
  ).toEqual(physical);
  f.disk.fs.read = async () => {
    throw new Error("corrupt bytes, discovery not success");
  };
  const page = value(await f.store.jobs.discoverOwned({ limit: 1 }, f.ctx()));
  expect(page.descriptors[0]?.outputs).toEqual([
    { id: physical.id, sha256: physical.sha256 },
  ]);
  expect(
    await f.store.jobs.getJobReceipt(record.job.id, f.ctx()),
  ).toMatchObject({ status: "failed" });
  expect(complete.record.job.status).toBe("completed");
});
test.each([
  { path: "worker", expired: false },
  { path: "worker", expired: true },
  { path: "recovery", expired: false },
  { path: "recovery", expired: true },
] as const)(
  "$path interruption retains a worker slot until confirmed stop (expired=$expired)",
  async ({ path, expired }) => {
    const f = await setup(1);
    const first = await claim(f, ["resource-a"]);
    const next = value(
      await f.store.jobs.create(
        f.submission("job-other", ["resource-b"]),
        f.ctx("other"),
      ),
    );
    const claimNext = () =>
      f.store.jobs.claim(
        next.job.id,
        { state: "queued", rowVersion: next.rowVersion },
        "worker2",
        1000,
        f.ctx("other"),
      );
    expect(await claimNext()).toMatchObject({ error: { code: "CONFLICT" } });
    if (path === "recovery" && expired) f.advance(1000);
    const interrupted = value(
      path === "worker"
        ? await f.store.jobs.update(
            first.job.id,
            fence(first),
            { kind: "interrupt", error },
            f.ctx(),
          )
        : await f.store.jobs.reconcile(
            first.job.id,
            first.rowVersion,
            { kind: "interrupt", error },
            f.ctx("recovery"),
          ),
    );
    if (path === "worker" && expired) f.advance(1000);
    expect(interrupted.job.lease).toEqual(first.job.lease);
    expect(await claimNext()).toMatchObject({ error: { code: "CONFLICT" } });
    await f.reopen();
    expect(await claimNext()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(value(await f.store.jobs.get(next.job.id, f.ctx("other")))).toEqual(
      next,
    );
    const resolved = value(
      await f.store.jobs.reconcile(
        first.job.id,
        interrupted.rowVersion,
        {
          kind: "resolved",
          decision: "cancelled",
          evidenceRef: "confirmed-worker-stopped",
          stoppedLeaseId: required(first.job.lease).id,
          effects: [],
          abandonedStageIds: [],
        },
        f.ctx("recovery"),
      ),
    );
    expect(resolved.job.lease).toBeUndefined();
    expect(value(await claimNext()).job.status).toBe("running");
  },
);

test("restored leases remain historical quarantine, not destination worker slots", async () => {
  const f = await setup(1);
  const first = await claim(f, ["resource-a"]);
  const backup = value(await f.store.backup(f.ctx("backup")));
  const destination = await mkdtemp(join(tmpdir(), "historical worker slots "));
  roots.push(destination);
  const disk = await diskFixture(destination);
  const options = {
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  };
  let store = await LocalStore.open(options);
  stores.push(store);
  value(await store.restore(backup, f.ctx("restore")));
  const historical = value(await store.jobs.get(first.job.id, f.ctx()));
  expect(historical.job.lease).toEqual(first.job.lease);
  expect(historical).toMatchObject({ restoredLease: true });
  expect(historical.generation).toBeGreaterThan(first.generation);
  const exported = value(await store.backup(f.ctx("backup")));
  expect(decodeBackup(encodeBackup(exported, 26214400), 26214400)).toEqual(
    exported,
  );
  for (const invalid of [
    { ...historical, restoredLease: false },
    { ...historical, generation: required(historical.job.lease).fencingToken },
    { ...historical, job: { ...historical.job, lease: undefined } },
    { ...first, restoredLease: true },
  ])
    expect(() => storedJob(invalid)).toThrow();
  store.close();
  store = await LocalStore.open(options);
  stores.push(store);
  const blocked = value(
    await store.jobs.create(
      f.submission("job-blocked", ["resource-a"]),
      f.ctx("blocked"),
    ),
  );
  expect(
    await store.jobs.claim(
      blocked.job.id,
      { state: "queued", rowVersion: blocked.rowVersion },
      "worker2",
      1000,
      f.ctx("blocked"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const next = value(
    await store.jobs.create(
      f.submission("job-other", ["resource-b"]),
      f.ctx("other"),
    ),
  );
  const destinationWorker = value(
    await store.jobs.claim(
      next.job.id,
      { state: "queued", rowVersion: next.rowVersion },
      "worker2",
      1000,
      f.ctx("other"),
    ),
  );
  expect(destinationWorker.job.status).toBe("running");
  const resolved = value(
    await store.jobs.reconcile(
      first.job.id,
      historical.rowVersion,
      {
        kind: "resolved",
        decision: "queued",
        evidenceRef: "confirmed-historical-stop",
        stoppedLeaseId: required(first.job.lease).id,
        effects: [],
        abandonedStageIds: [],
      },
      f.ctx("recovery"),
    ),
  );
  expect(resolved).not.toHaveProperty("restoredLease");
  expect(resolved.job.lease).toBeUndefined();
  expect(
    await store.jobs.claim(
      first.job.id,
      { state: "queued", rowVersion: resolved.rowVersion },
      "worker1",
      1000,
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  value(
    await store.jobs.update(
      next.job.id,
      fence(destinationWorker),
      { kind: "wait", error },
      f.ctx("other"),
    ),
  );
  const newExecution = value(
    await store.jobs.claim(
      first.job.id,
      { state: "queued", rowVersion: resolved.rowVersion },
      "worker1",
      1000,
      f.ctx(),
    ),
  );
  expect(newExecution).not.toHaveProperty("restoredLease");
  expect(newExecution.job.status).toBe("running");
  expect(
    await store.jobs.claim(
      blocked.job.id,
      { state: "queued", rowVersion: blocked.rowVersion },
      "worker3",
      1000,
      f.ctx("blocked"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  // The source execution is still unconfirmed: destination restore did not free its slot.
  const sourceNext = value(
    await f.store.jobs.create(f.submission("job-source"), f.ctx("source")),
  );
  expect(
    await f.store.jobs.claim(
      sourceNext.job.id,
      { state: "queued", rowVersion: sourceNext.rowVersion },
      "worker3",
      1000,
      f.ctx("source"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("interrupted workers without resource keys also retain their global slot", async () => {
  const f = await setup(1);
  const running = await claim(f);
  value(
    await f.store.jobs.update(
      running.job.id,
      fence(running),
      { kind: "interrupt", error },
      f.ctx(),
    ),
  );
  const next = value(
    await f.store.jobs.create(f.submission("job-other"), f.ctx("other")),
  );
  expect(
    await f.store.jobs.claim(
      next.job.id,
      { state: "queued", rowVersion: next.rowVersion },
      "worker2",
      1000,
      f.ctx("other"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("conditional cancellation replays a durable control key after response loss and restart", async () => {
  const f = await setup();
  const running = await claim(f, ["resource-a"]);
  f.fault("after-commit");
  const accepted = value(
    await f.store.jobs.cancelWithReceipt(
      running.job.id,
      running.rowVersion,
      f.ctx("cancel-key"),
    ),
  );
  f.fault();
  expect(accepted.record.job.status).toBe("cancel-requested");
  expect(accepted.record.rowVersion).toBe(running.rowVersion + 1);
  expect(accepted.record.job.lease).toEqual(running.job.lease);
  expect(accepted.record.resources).toEqual(running.resources);
  expect(accepted.record.job.idempotency).toEqual(running.job.idempotency);
  expect(accepted.record.requestId).toBe("work");
  expect(accepted.control).toMatchObject({
    version: 1,
    operation: "job-cancel",
    jobId: running.job.id,
    actorId: "actor1",
    projectId: "project1",
    key: "cancel-key",
    expectedVersion: running.rowVersion,
    resultVersion: accepted.record.rowVersion,
    resultStatus: "cancel-requested",
  });
  await f.reopen();
  expect(
    value(
      await f.store.jobs.cancelWithReceipt(
        running.job.id,
        running.rowVersion,
        f.ctx("cancel-key"),
      ),
    ),
  ).toEqual(accepted);
  const settled = value(
    await f.store.jobs.update(
      running.job.id,
      fence(accepted.record),
      { kind: "acknowledge-cancel" },
      f.ctx(),
    ),
  );
  const replay = value(
    await f.store.jobs.cancelWithReceipt(
      running.job.id,
      running.rowVersion,
      f.ctx("cancel-key"),
    ),
  );
  expect(replay.control).toEqual(accepted.control);
  expect(replay.record).toEqual(settled);
});

test("cancel-control key conflicts on changed precondition or target even when target completed", async () => {
  const f = await setup();
  const queued = value(
    await f.store.jobs.create(f.submission("job-queued"), f.ctx("queued")),
  );
  const accepted = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  );
  expect(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      accepted.record.rowVersion,
      f.ctx("cancel"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const { record, output } = await completion(f, await claim(f));
  const completed = value(
    await f.store.jobs.commitJob(record.job.id, fence(record), output, f.ctx()),
  );
  expect(
    await f.store.jobs.cancelWithReceipt(
      record.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const won = value(
    await f.store.jobs.cancelWithReceipt(record.job.id, 1, f.ctx("new-cancel")),
  );
  expect(won.record.job.receipt).toEqual(completed.receipt);
  expect(won.control.resultStatus).toBe("completed");
  expect(
    await f.store.jobs.cancelWithReceipt(record.job.id, 2, f.ctx("new-cancel")),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(won.record.job.idempotency).toEqual(record.job.idempotency);
});

test.each([
  "job-cancel-after-state",
  "job-cancel-after-control",
  "before-commit",
])(
  "cancel fault %s rolls back control receipt, cancellation and version atomically",
  async (point) => {
    const f = await setup();
    const running = await claim(f, ["resource-a"]);
    const baseline = value(await f.store.backup(f.ctx("backup")));
    f.fault(point);
    expect(
      await f.store.jobs.cancelWithReceipt(
        running.job.id,
        running.rowVersion,
        f.ctx("cancel"),
      ),
    ).toMatchObject({ status: "failed" });
    f.fault();
    expect(value(await f.store.backup(f.ctx("backup")))).toEqual(baseline);
    expect(
      value(
        await f.store.jobs.cancelWithReceipt(
          running.job.id,
          running.rowVersion,
          f.ctx("cancel"),
        ),
      ).record.rowVersion,
    ).toBe(running.rowVersion + 1);
  },
);

test("control authorization precedes replay and actor/project scopes cannot leak or overwrite", async () => {
  const f = await setup();
  const queued = value(await f.store.jobs.create(f.submission(), f.ctx()));
  const accepted = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  );
  f.options.authorize = async (ctx) => {
    if (ctx.authorization.actorId !== "actor1")
      throw Object.assign(new Error("Denied synthetic actor"), {
        code: "FORBIDDEN",
      });
  };
  const denied = f.ctx("cancel");
  denied.authorization.actorId = "actor2";
  expect(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      denied,
    ),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(
    await f.store.jobs.cancelWithReceipt(queued.job.id, queued.rowVersion, {
      ...f.ctx("cancel"),
      projectId: "project2",
    }),
  ).toMatchObject({ status: "failed" });
  f.options.authorize = async () => {};
  const other = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      accepted.record.rowVersion,
      denied,
    ),
  );
  expect(other.control.actorId).toBe("actor2");
  expect(other.control.key).toBe(accepted.control.key);
  const first = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  );
  expect(first.control).toEqual(accepted.control);
  expect(first.record.rowVersion).toBe(other.record.rowVersion);
});

test("cancel controls survive authenticated backup/restore without reapplying old preconditions", async () => {
  const f = await setup();
  const queued = value(await f.store.jobs.create(f.submission(), f.ctx()));
  const accepted = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  );
  const backup = decodeBackup(
    encodeBackup(value(await f.store.backup(f.ctx("backup"))), 26214400),
    26214400,
  );
  const destination = await mkdtemp(join(tmpdir(), "cancel-control restore "));
  roots.push(destination);
  const disk = await diskFixture(destination);
  const store = await LocalStore.open({
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  });
  stores.push(store);
  value(await store.restore(backup, f.ctx("restore")));
  const before = value(await store.jobs.get(queued.job.id, f.ctx()));
  const replay = value(
    await store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  );
  expect(replay.control).toEqual(accepted.control);
  expect(replay.record).toEqual(before);
  expect(replay.record.rowVersion).toBeGreaterThan(accepted.record.rowVersion);
});

test("cancel admission snapshots control identity before queueing", async () => {
  const f = await setup();
  const record = value(await f.store.jobs.create(f.submission(), f.ctx()));
  const ctx = f.ctx("cancel0");
  const pending = f.store.jobs.cancelWithReceipt(
    record.job.id,
    record.rowVersion,
    ctx,
  );
  ctx.requestId = "mutated";
  const first = value(await pending);
  expect(first.control.key).toBe("cancel0");
  expect(first.control.expectedVersion).toBe(record.rowVersion);
  expect(first.record.rowVersion).toBe(record.rowVersion + 1);
  expect(first.record.cancelControls).toEqual([first.control]);
  expect(first.record.job.budget).toEqual(record.job.budget);
  expect(first.record.usage).toEqual(record.usage);
});

function prepareCancelCapacity(signal: AbortSignal) {
  const scope = new AsyncTestScope(signal);
  seedScopes.push(scope);
  let phase = "setup";
  let completedControls = 0;
  const started = performance.now();
  const report = () =>
    console.error(
      JSON.stringify({
        scope: "synthetic cancel-capacity setup aborted",
        phase,
        completedControls,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  signal.addEventListener("abort", report, { once: true });
  const pending = scope.track(
    inStorageTest(scope.signal, async () => {
      scope.signal.throwIfAborted();
      const f = await setup();
      scope.signal.throwIfAborted();
      phase = "create-job";
      let record = value(await f.store.jobs.create(f.submission(), f.ctx()));
      const initial = structuredClone(record);
      phase = "seed-controls";
      for (let index = 0; index < 127; index++) {
        scope.signal.throwIfAborted();
        record = value(
          await f.store.jobs.cancelWithReceipt(
            record.job.id,
            record.rowVersion,
            f.ctx(`cancel${index}`),
          ),
        ).record;
        completedControls++;
      }
      scope.signal.throwIfAborted();
      expect(record.cancelControls).toHaveLength(127);
      return { f, initial, record };
    }),
  );
  void pending.then(
    () => signal.removeEventListener("abort", report),
    () => signal.removeEventListener("abort", report),
  );
  return { scope, pending };
}

describe("cancel-control capacity from genuine bounded preparation", () => {
  let prepared:
    | Awaited<ReturnType<typeof prepareCancelCapacity>["pending"]>
    | undefined;
  beforeEach(async ({ signal }) => {
    prepared = undefined;
    prepared = await prepareCancelCapacity(signal).pending;
  });
  test("admits exactly control 128, rejects 129 without mutation, and replays at capacity", async () => {
    const { f, initial, record: seeded } = required(prepared);
    const before = value(await f.store.jobs.get(seeded.job.id, f.ctx()));
    expect(before).toEqual(seeded);
    expect(before.cancelControls).toHaveLength(127);
    expect(before.cancelControls?.map((control) => control.key)).toEqual(
      Array.from({ length: 127 }, (_, index) => `cancel${index}`),
    );
    const admitted = value(
      await f.store.jobs.cancelWithReceipt(
        before.job.id,
        before.rowVersion,
        f.ctx("cancel127"),
      ),
    );
    const full = admitted.record;
    expect(full.rowVersion).toBe(before.rowVersion + 1);
    expect(full.cancelControls).toHaveLength(128);
    expect(
      new Set(full.cancelControls?.map((control) => control.key)).size,
    ).toBe(128);
    expect(full.cancelControls?.slice(0, 127)).toEqual(before.cancelControls);
    expect(admitted.control.key).toBe("cancel127");
    expect(admitted.control.expectedVersion).toBe(before.rowVersion);
    expect(
      await f.store.jobs.cancelWithReceipt(
        full.job.id,
        full.rowVersion,
        f.ctx("overflow"),
      ),
    ).toMatchObject({ status: "failed", error: { code: "INPUT_LIMIT" } });
    expect(value(await f.store.jobs.get(full.job.id, f.ctx()))).toEqual(full);
    const first = required(full.cancelControls?.[0]);
    expect(first.expectedVersion).toBe(initial.rowVersion);
    const replay = value(
      await f.store.jobs.cancelWithReceipt(
        full.job.id,
        first.expectedVersion,
        f.ctx("cancel0"),
      ),
    );
    expect(replay.control).toEqual(first);
    expect(replay.record).toEqual(full);
    expect(value(await f.store.jobs.get(full.job.id, f.ctx()))).toEqual(full);
    expect(full.job.budget).toEqual(initial.job.budget);
    expect(full.usage).toEqual(initial.usage);
  });
});

test.each(["setup", "write"] as const)(
  "cancelled capacity preparation joins original %s before SQLite cleanup",
  async (kind) => {
    const signal = storageTestSignal();
    const runner = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancel = () => {
      runner.abort();
      release();
    };
    signal.addEventListener("abort", cancel, { once: true });
    let opened: LocalStore | undefined;
    let root: string | undefined;
    const controls = new Set<string>();
    let signalObserved: AbortSignal | undefined;
    const original = LocalStore.open.bind(LocalStore);
    const opening = vi
      .spyOn(LocalStore, "open")
      .mockImplementationOnce(async (options) => {
        const authorize = options.authorize;
        opened = await original({
          ...options,
          authorize: async (...args) => {
            const ctx = args[0];
            if (/^cancel\d+$/.test(ctx.requestId)) controls.add(ctx.requestId);
            if (
              kind === "write" &&
              ctx.requestId === "cancel3" &&
              !signalObserved
            ) {
              signalObserved = ctx.signal;
              entered();
              await gate;
            }
            return authorize(...args);
          },
        });
        root = options.databasePath;
        if (kind === "setup") {
          entered();
          await gate;
        }
        return opened;
      });
    const seed = prepareCancelCapacity(runner.signal);
    const rejected = expect(seed.pending).rejects.toThrow();
    try {
      await entry;
      if (!opened || !root) throw new Error("Missing owned capacity database.");
      const closingStore = vi.spyOn(opened, "close");
      runner.abort();
      let joined = false;
      const joinedSeed = seed.scope.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      expect(closingStore).not.toHaveBeenCalled();
      expect(controls.has("cancel4")).toBe(false);
      if (kind === "write") expect(signalObserved).toBe(seed.scope.signal);
      release();
      await rejected;
      await joinedSeed;
      expect(controls.has("cancel4")).toBe(false);
      expect(joined).toBe(true);
      if (kind === "write") {
        const store = opened;
        const persisted = value(
          await inStorageTest(new AbortController().signal, () =>
            store.jobs.get("job-work", context("inspect-cancelled-seed")),
          ),
        );
        expect(persisted.cancelControls?.map((control) => control.key)).toEqual(
          ["cancel0", "cancel1", "cancel2"],
        );
      }
      const directory = dirname(root);
      onTestFinished(async () => {
        try {
          expect(closingStore).toHaveBeenCalled();
          await expect(lstat(directory)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          closingStore.mockRestore();
        }
      });
    } finally {
      release();
      await rejected;
      await seed.scope.close();
      opening.mockRestore();
      signal.removeEventListener("abort", cancel);
    }
  },
);

test("fixture cancellation stays bound to its original async scope and cleanup joins SQLite work", async () => {
  const f = await setup();
  const old = new AbortController();
  const next = new AbortController();
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.disk.fs.read;
  f.disk.fs.read = async (...args) => {
    entered?.();
    await ready;
    expect(context("late-original").signal).toBe(old.signal);
    return read(...args);
  };
  const pending = inStorageTest(old.signal, () =>
    f.store.verify(f.submission().input, f.ctx()),
  );
  await reading;
  old.abort();
  let closed = false;
  const closing = closeSettledStores([f.store]).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(inStorageTest(next.signal, () => context("next").signal)).toBe(
    next.signal,
  );
  release?.();
  expect(await pending).toMatchObject({ status: "cancelled" });
  await closing;
  expect(closed).toBe(true);
  expect(next.signal.aborted).toBe(false);
});

async function prepareCancellationRestore() {
  const source = await phase("prepare-source", async () => {
    const f = await setup();
    storageTestSignal().throwIfAborted();
    const first = value(await f.store.jobs.create(f.submission(), f.ctx()));
    value(
      await f.store.jobs.cancelWithReceipt(
        first.job.id,
        first.rowVersion,
        f.ctx("cancel"),
      ),
    );
    const second = value(
      await f.store.jobs.create(f.submission("job-other"), f.ctx("other")),
    );
    value(
      await f.store.jobs.requestCancel(
        second.job.id,
        second.rowVersion,
        f.ctx("cancel-other"),
      ),
    );
    const backup = value(await f.store.backup(f.ctx("backup")));
    if (backup.metadata.storageVersion !== 4) throw new Error("Expected v4.");
    storageTestSignal().throwIfAborted();
    return { f, first, second, backup };
  });
  return phase("prepare-destination", async () => {
    storageTestSignal().throwIfAborted();
    const destination = await mkdtemp(
      join(tmpdir(), "invalid cancel control "),
    );
    roots.push(destination);
    storageTestSignal().throwIfAborted();
    const disk = await diskFixture(destination);
    storageTestSignal().throwIfAborted();
    const store = await LocalStore.open({
      ...source.f.options,
      databasePath: join(destination, "state.sqlite"),
      fileSystem: disk.fs,
      maintenance: disk.maintenance,
    });
    stores.push(store);
    storageTestSignal().throwIfAborted();
    return { ...source, store, disk, destination };
  });
}
describe("cancellation-control restore from independently prepared fixtures", () => {
  let prepared:
    | Awaited<ReturnType<typeof prepareCancellationRestore>>
    | undefined;
  beforeEach(async () => {
    prepared = undefined;
    prepared = await ownTestWork(prepareCancellationRestore)();
  });
  test.each([
    "digest",
    "target",
    "version",
    "status",
    "duplicate-scope",
  ] as const)(
    "restore rejects cancellation-control %s graph tampering",
    async (kind) => {
      const { f, first, second, backup, store } = required(prepared);
      await phase("tamper", async () => {
        if (backup.metadata.storageVersion !== 4)
          throw new Error("Expected v4.");
        const record = required(
          backup.metadata.jobs.find((r) => r.job.id === first.job.id),
        );
        const control = required(record.cancelControls?.[0]);
        if (kind === "digest") control.payloadSha256 = "a".repeat(64);
        else if (kind === "target") control.jobId = second.job.id;
        else if (kind === "version")
          control.resultVersion = record.rowVersion + 1;
        else if (kind === "status") control.resultStatus = "completed";
        else {
          const other = required(
            backup.metadata.jobs.find((r) => r.job.id === second.job.id),
          );
          other.cancelControls = [
            {
              ...control,
              jobId: second.job.id,
              payloadSha256: hash(
                f.options.canonicalBytes({
                  jobId: second.job.id,
                  expectedVersion: control.expectedVersion,
                }),
              ),
            },
          ];
        }
        backup.sha256 = hash(f.options.canonicalBytes(backup.metadata));
      });
      expect(
        await phase("restore-reject", () =>
          store.restore(backup, f.ctx("restore")),
        ),
      ).toMatchObject({
        error: { code: "ARTIFACT_INTEGRITY" },
      });
      expect(
        value(await phase("verify-empty", () => store.backup(f.ctx("backup"))))
          .metadata.artifacts,
      ).toEqual([]);
    },
  );
});

describe("aggregate cancellation metadata from independently prepared fixture", () => {
  let prepared:
    | { f: Awaited<ReturnType<typeof setup>>; queued: StoredJob }
    | undefined;
  beforeEach(async () => {
    prepared = undefined;
    prepared = await ownTestWork(async () => {
      const source = await phase("prepare-source", async () => {
        const f = await setup();
        const queued = value(
          await f.store.jobs.create(f.submission(), f.ctx()),
        );
        value(
          await f.store.jobs.cancelWithReceipt(
            queued.job.id,
            queued.rowVersion,
            f.ctx("cancel"),
          ),
        );
        return { f, queued };
      });
      await phase("prepare-oversized-row", async () => {
        const { f, queued } = source;
        storageTestSignal().throwIfAborted();
        f.store.close();
        const db = new Database(f.options.databasePath, { nativeBinding });
        rawDatabases.add(db);
        const errors: unknown[] = [];
        try {
          // Precondition only: the unchanged timed request below must reject before JSON lookup.
          db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)").run(
            "capacity",
            "capacity",
            "cancelled",
            queued.createdAt,
            null,
            JSON.stringify({ evidence: "x".repeat(26214400) }),
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          db.close();
          rawDatabases.delete(db);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            "Oversized-row fixture preparation or close failed.",
          );
        await f.reopen();
        storageTestSignal().throwIfAborted();
      });
      return source;
    })();
  });
  test("aggregate cancellation metadata is bounded before idempotency lookup materializes rows", async () => {
    const { f, queued } = required(prepared);
    const preparing = vi.spyOn(Database.prototype, "prepare");
    try {
      expect(
        await phase("aggregate-reject", () =>
          f.store.jobs.cancelWithReceipt(
            queued.job.id,
            queued.rowVersion,
            f.ctx("cancel"),
          ),
        ),
      ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
      const queries = preparing.mock.calls.map(([sql]) => sql);
      expect(
        queries.some((sql) => sql.includes("sum(length(cast(data AS BLOB)))")),
      ).toBe(true);
      expect(
        queries.some((sql) => /json_each|json_array_length/.test(sql)),
      ).toBe(false);
    } finally {
      preparing.mockRestore();
    }
  });
});

test.each(["setup-hook", "restore-body"] as const)(
  "runner abort joins original %s and real SQLite ownership before teardown",
  async (kind) => {
    const original = new AbortController();
    const scope = new AsyncTestScope(original.signal);
    const events: string[] = [];
    const observed: CancelPhaseEvent[] = [];
    const trace = cancellationTelemetry(
      "restore-control",
      original.signal,
      (event) => observed.push(event),
    );
    telemetry.set(scope, trace);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    testScope().releaseOnEnd(() => {
      original.abort();
      release();
    });
    let database: LocalStore | undefined;
    let directory: string | undefined;
    let bodySettled = false;
    let queueSettled = false;
    let queueJoined: Promise<void> | undefined;
    let closeStarted: Promise<void> | undefined;
    const open = LocalStore.open.bind(LocalStore);
    const opening = vi.spyOn(LocalStore, "open");
    if (kind === "setup-hook") {
      opening.mockImplementationOnce(async (options) => {
        database = await open(options);
        directory = dirname(options.databasePath);
        events.push("setup-database-open");
        entered();
        await gate;
        return database;
      });
    }
    const close = LocalStore.prototype.close;
    const closing = vi
      .spyOn(LocalStore.prototype, "close")
      .mockImplementation(function (this: LocalStore) {
        close.call(this);
        if (this === database) events.push("database-closed");
      });
    const own = <T>(work: () => Promise<T>) =>
      inTestScope(scope, () =>
        inStorageTest(scope.signal, () => ownTestWork(work)()),
      );
    const pending = own(async () => {
      try {
        if (kind === "setup-hook") {
          await phase("prepare-source", () => setup());
          throw new Error("Aborted setup unexpectedly admitted its body.");
        }
        const prepared = await prepareCancellationRestore();
        database = prepared.store;
        directory = prepared.destination;
        const stage = prepared.disk.fs.stage;
        prepared.disk.fs.stage = async (...args) => {
          const result = await stage(...args);
          events.push("restore-stage-owned");
          entered();
          await gate;
          return result;
        };
        const outcome = await phase("restore-reject", () =>
          prepared.store.restore(prepared.backup, prepared.f.ctx("restore")),
        );
        expect(outcome.status).toBe("cancelled");
        events.push("restore-returned");
      } finally {
        bodySettled = true;
        events.push("original-body-settled");
      }
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        entry,
        pending.then(() => {
          throw new Error("Original work settled before the owned gate.");
        }),
      ]);
      expect(database).toBeDefined();
      expect(directory).toBeDefined();
      expect(bodySettled).toBe(false);
      expect((await lstat(required(directory))).isDirectory()).toBe(true);
      if (kind === "restore-body") {
        const queue: unknown = Reflect.get(required(database), "queue");
        expect(queue).toBeInstanceOf(Promise);
        if (!(queue instanceof Promise))
          throw new Error("Missing actual SQLite work queue.");
        queueJoined = queue.then(() => {
          queueSettled = true;
        });
      }
      original.abort();
      expect(
        observed.filter((event) => event.event === "runner-abort"),
      ).toMatchObject([
        {
          phase: kind === "setup-hook" ? "prepare-source" : "restore-reject",
          runnerAborted: true,
        },
      ]);
      closeStarted = (async () => {
        await scope.close();
        events.push("scope-joined");
        await closeFixtureResources();
        events.push("root-removed");
        trace.close();
      })();
      await Promise.resolve();
      expect(bodySettled).toBe(false);
      if (kind === "restore-body") expect(queueSettled).toBe(false);
      expect(events).not.toContain("database-closed");
      expect(events).not.toContain("root-removed");
      expect(vi.isMockFunction(LocalStore.open)).toBe(true);
      await expect(own(() => setup())).rejects.toThrow(/cancelled/i);
    } finally {
      release();
      original.abort();
      await pending;
      await queueJoined;
      await (closeStarted ?? scope.close().then(closeFixtureResources));
      trace.close();
      opening.mockRestore();
      closing.mockRestore();
    }
    expect(events.indexOf("original-body-settled")).toBeLessThan(
      events.indexOf("database-closed"),
    );
    expect(events.indexOf("database-closed")).toBeLessThan(
      events.indexOf("root-removed"),
    );
    await expect(lstat(required(directory))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (kind === "setup-hook") expect(await pending).toBeInstanceOf(Error);
    else {
      expect(events).toContain("restore-returned");
      expect(queueSettled).toBe(true);
    }
    const count = observed.length;
    original.signal.dispatchEvent(new Event("abort"));
    expect(observed).toHaveLength(count);
  },
);

test("global cancellation-control admission cap rejects additional evidence without truncation", async () => {
  const f = await setup();
  const queued = value(await f.store.jobs.create(f.submission(), f.ctx()));
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    // Synthetic capacity sentinels target aggregate COUNT, never parsed as authoritative control evidence.
    const insert = db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 157; i++)
        insert.run(
          `capacity${i}`,
          `capacity${i}`,
          "cancelled",
          queued.createdAt,
          null,
          JSON.stringify({
            cancelControls: Array.from(
              { length: i === 156 ? 32 : 128 },
              () => ({ key: "capacity" }),
            ),
          }),
        );
    })();
  } finally {
    db.close();
  }
  await f.reopen();
  expect(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx("cancel"),
    ),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  expect(value(await f.store.jobs.get(queued.job.id, f.ctx())).rowVersion).toBe(
    queued.rowVersion,
  );
});

test("cancellation control wins before guarded completion and never releases unconfirmed worker resources", async () => {
  const f = await setup();
  const { record, output } = await completion(
    f,
    await claim(f, ["resource-a"]),
  );
  const cancel = value(
    await f.store.jobs.cancelWithReceipt(
      record.job.id,
      record.rowVersion,
      f.ctx("cancel"),
    ),
  );
  expect(
    await f.store.jobs.commitJob(record.job.id, fence(record), output, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(
    await f.store.jobs.commitJob(
      record.job.id,
      fence(cancel.record),
      output,
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(cancel.record.job.lease).toEqual(record.job.lease);
  expect(cancel.record.resources).toEqual(record.resources);
  expect(cancel.record.job.budget).toEqual(record.job.budget);
});

test("cancellation-control keys do not collide with original job submission or legacy write keys", async () => {
  const f = await setup();
  const queued = value(await f.store.jobs.create(f.submission(), f.ctx()));
  const original = value(await f.store.getReceipt("seed", f.ctx("seed")));
  const sameSubmissionKey = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      queued.rowVersion,
      f.ctx(),
    ),
  );
  const sameLegacyKey = value(
    await f.store.jobs.cancelWithReceipt(
      queued.job.id,
      sameSubmissionKey.record.rowVersion,
      f.ctx("seed"),
    ),
  );
  expect(sameSubmissionKey.control.key).toBe(queued.requestId);
  expect(sameLegacyKey.control.key).toBe("seed");
  expect(sameLegacyKey.record.submission).toEqual(queued.submission);
  expect(sameLegacyKey.record.job.idempotency).toEqual(queued.job.idempotency);
  expect(value(await f.store.getReceipt("seed", f.ctx("seed")))).toEqual(
    original,
  );
  expect(value(await f.store.jobs.create(f.submission(), f.ctx()))).toEqual(
    sameLegacyKey.record,
  );
});

test("competing cancellation controls serialize exact retries without duplicate accepted versions", async () => {
  const f = await setup();
  const running = await claim(f);
  const retries = await Promise.all(
    [0, 1].map(() =>
      f.store.jobs.cancelWithReceipt(
        running.job.id,
        running.rowVersion,
        f.ctx("same-key"),
      ),
    ),
  );
  const first = value(required(retries[0]));
  expect(value(required(retries[1]))).toEqual(first);
  expect(first.record.cancelControls).toHaveLength(1);
  const differentKeys = await Promise.all(
    ["second-key", "third-key"].map((key) =>
      f.store.jobs.cancelWithReceipt(
        running.job.id,
        first.record.rowVersion,
        f.ctx(key),
      ),
    ),
  );
  expect(
    differentKeys.filter((result) => result.status === "complete"),
  ).toHaveLength(1);
  expect(
    differentKeys.filter((result) => result.status === "failed"),
  ).toHaveLength(1);
  const latest = value(await f.store.jobs.get(running.job.id, f.ctx()));
  expect(latest.rowVersion).toBe(first.record.rowVersion + 1);
  expect(latest.cancelControls).toHaveLength(2);
  expect(latest.job.lease).toEqual(running.job.lease);
});

test("creates authoritative jobs, owns snapshots, deduplicates by logical operation and protects inputs", async () => {
  const f = await setup();
  const input = f.submission();
  const ctx = f.ctx();
  const pending = f.store.jobs.create(input, ctx);
  input.resourceKeys.push("mutated");
  ctx.requestId = "mutated";
  ctx.budget.maxAttempts = 99;
  const original = value(await pending);
  expect(original.resourceKeys).toEqual([]);
  expect(original.requestId).toBe("work");
  expect(original.job.budget.maxAttempts).toBe(3);
  expect(validateContract("Job", original.job).success).toBe(true);
  expect(value(await f.store.jobs.create(f.submission(), f.ctx()))).toEqual(
    original,
  );
  expect(
    await f.store.jobs.create(
      { ...f.submission(), handlerVersion: "v2" },
      f.ctx(),
    ),
  ).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
  expect(
    value(
      await f.store.jobs.create(
        { ...f.submission("job-compare"), operation: "compare" },
        { ...f.ctx(), jobId: "job-compare" },
      ),
    ).job.operation,
  ).toBe("compare");
  await f.reopen();
  expect(value(await f.store.jobs.get("job-work", f.ctx()))).toEqual(original);
});

test("claims all sorted resources or none; competing claims and concurrency are atomic", async () => {
  const f = await setup(2);
  const first = await claim(f, ["b", "a"]);
  const ctx = f.ctx("other");
  const queued = value(
    await f.store.jobs.create(f.submission("job-other", ["b", "c"]), ctx),
  );
  const expected = { state: queued.job.status, rowVersion: queued.rowVersion };
  expect(
    await f.store.jobs.claim("job-other", expected, "worker2", 1000, ctx),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const third = value(
    await f.store.jobs.create(f.submission("job-third", ["c"]), f.ctx("third")),
  );
  const races = await Promise.all(
    [1, 2].map((n) =>
      f.store.jobs.claim(
        "job-third",
        { state: third.job.status, rowVersion: third.rowVersion },
        `worker${n}`,
        1000,
        f.ctx("third"),
      ),
    ),
  );
  expect(races.filter((r) => r.status === "complete")).toHaveLength(1);
  expect(first.resources.map((r) => r.key)).toEqual(["a", "b"]);
});

test("expired leases never resurrect or release quarantined resources; reconciliation prevents ABA", async () => {
  const f = await setup(2);
  const first = await claim(f, ["device1"]);
  f.advance(1000);
  expect(
    await f.store.jobs.heartbeat("job-work", fence(first), 1000, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const interrupted = value(
    await f.store.jobs.reconcile(
      "job-work",
      first.rowVersion,
      { kind: "interrupt", error },
      f.ctx(),
    ),
  );
  const other = value(
    await f.store.jobs.create(
      f.submission("job-other", ["device1"]),
      f.ctx("other"),
    ),
  );
  expect(
    await f.store.jobs.claim(
      "job-other",
      { state: "queued", rowVersion: other.rowVersion },
      "worker2",
      1000,
      f.ctx("other"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const resolved = value(
    await f.store.jobs.reconcile(
      "job-work",
      interrupted.rowVersion,
      {
        kind: "resolved",
        decision: "queued",
        evidenceRef: "stopped1",
        stoppedLeaseId: required(first.job.lease).id,
        effects: [],
        abandonedStageIds: [],
      },
      f.ctx(),
    ),
  );
  const second = value(
    await f.store.jobs.claim(
      "job-work",
      { state: "queued", rowVersion: resolved.rowVersion },
      "worker1",
      1000,
      f.ctx(),
    ),
  );
  expect(required(second.resources[0]).generation).toBeGreaterThan(
    required(first.resources[0]).generation,
  );
  expect(
    await f.store.jobs.update(
      "job-work",
      fence(first),
      { kind: "progress", sequence: 1, progress: 0.5 },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("guarded commit atomically stores job, receipt, refs, revision and head; legacy paths refuse tracked jobs", async () => {
  const f = await setup();
  const running = await claim(f);
  const staged = [];
  let record = running;
  for (const text of ["content", "provenance", "resources"]) {
    const result = value(
      await f.store.jobs.stage("job-work", fence(record), bytes(text), f.ctx()),
    );
    record = result.record;
    staged.push(result.staged);
  }
  const rev = revision(
    "rev-job",
    staged.map((s) => s.artifact),
  );
  const output: JobCompletion = {
    outputs: staged,
    outputState: "complete",
    diagnosticIds: [],
    revision: { revision: rev, base: null, branch: "main" },
  };
  expect(await f.store.commit(staged, f.ctx())).toMatchObject({
    error: { code: "CONFLICT" },
  });
  expect(
    await f.store.commitRevision(
      { ...required(output.revision), outputs: staged },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  f.fault("before-commit");
  expect(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  ).toMatchObject({ status: "failed" });
  expect(value(await f.store.jobs.get("job-work", f.ctx())).job.status).toBe(
    "running",
  );
  expect(
    value(await f.store.jobs.getJobReceipt("job-work", f.ctx())),
  ).toBeNull();
  expect(value(await f.store.getHead("design1", "main", f.ctx()))).toBeNull();
  f.fault();
  const done = value(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  );
  expect(done.record.job.receipt).toEqual(done.receipt);
  expect(done.receipt.idempotency.operation).toBe("render");
  expect(done.record.finalOutputSha256).toBe(
    done.receipt.idempotency.payloadSha256,
  );
  expect(done.record.job.idempotency.payloadSha256).not.toBe(
    done.record.finalOutputSha256,
  );
  expect(value(await f.store.getReceipt("work", f.ctx()))).toBeNull();
  expect(
    value(
      await f.store.jobs.requestCancel("job-work", record.rowVersion, f.ctx()),
    ).job.status,
  ).toBe("completed");
  await f.reopen();
  expect(value(await f.store.jobs.getJobReceipt("job-work", f.ctx()))).toEqual(
    done.receipt,
  );
});

test.each(["receipt", "output-protection"] as const)(
  "capture job snapshots reject changed authoritative %s before proof reuse",
  async (corrupt) => {
    const f = await setup();
    const queued = value(
      await f.store.jobs.create(
        { ...f.submission(), operation: "capture" },
        f.ctx(),
      ),
    );
    const running = value(
      await f.store.jobs.claim(
        queued.job.id,
        {
          state: queued.job.status,
          rowVersion: queued.rowVersion,
        },
        "worker1",
        1000,
        f.ctx(),
      ),
    );
    const { record, output } = await completion(f, running);
    const done = value(
      await f.store.jobs.commitJob(
        record.job.id,
        fence(record),
        output,
        f.ctx(),
      ),
    );
    expect(
      value(await f.store.jobs.get(record.job.id, f.ctx())).job.receipt,
    ).toEqual(done.receipt);
    f.store.close();
    const db = new Database(f.options.databasePath, { nativeBinding });
    try {
      if (corrupt === "receipt")
        db.prepare(
          "UPDATE receipts SET data=? WHERE json_extract(data,'$.jobId')=?",
        ).run(
          JSON.stringify({ ...done.receipt, id: "changed-receipt" }),
          record.job.id,
        );
      else
        db.prepare(
          "DELETE FROM artifact_refs WHERE owner_kind='job' AND owner_id=?",
        ).run(done.receipt.id);
    } finally {
      db.close();
    }
    await f.reopen();
    expect(await f.store.jobs.get(record.job.id, f.ctx())).toMatchObject({
      status: "failed",
      error: { code: "ARTIFACT_INTEGRITY" },
    });
  },
);

test("live fence is checked after the async publication barrier inside the commit transaction", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f, ["device1"]));
  f.barrier(async () => {
    f.advance(1000);
  });
  expect(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(
    value(await f.store.jobs.getJobReceipt("job-work", f.ctx())),
  ).toBeNull();
  expect(value(await f.store.jobs.get("job-work", f.ctx())).job.status).toBe(
    "running",
  );
});

test("cancellation before commit blocks completion; committed receipt wins response loss", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  const cancelled = value(
    await f.store.jobs.requestCancel("job-work", record.rowVersion, f.ctx()),
  );
  expect(cancelled.job.status).toBe("cancel-requested");
  expect(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(
    await f.store.jobs.commitJob("job-work", fence(cancelled), output, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("backup roundtrip retains jobs and stages but invalidates live leases and host staging authority", async () => {
  const f = await setup();
  const { record } = await completion(f, await claim(f, ["device1"]));
  const backup = value(await f.store.backup(f.ctx("backup")));
  expect(backup.metadata.storageVersion).toBe(4);
  const destination = await mkdtemp(join(tmpdir(), "restored jobs "));
  roots.push(destination);
  const disk = await diskFixture(destination);
  const store = await LocalStore.open({
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  });
  stores.push(store);
  value(await store.restore(backup, f.ctx("restore")));
  const restored = value(await store.jobs.get("job-work", f.ctx()));
  expect(restored.job.status).toBe("interrupted");
  expect(restored.generation).toBeGreaterThan(record.generation);
  expect(
    await store.jobs.heartbeat("job-work", fence(record), 1000, f.ctx()),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("v2 migration retains a verified backup and rolls back transactional schema changes", async () => {
  const f = await setup();
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    db.exec(
      "DROP TABLE artifact_bindings; DROP TABLE job_stages; DROP TABLE job_resources; DROP TABLE jobs; PRAGMA user_version=2",
    );
  } finally {
    db.close();
  }
  f.fault("migration-before-commit");
  await expect(LocalStore.open(f.options)).rejects.toThrow();
  const check = new Database(f.options.databasePath, { nativeBinding });
  expect(check.pragma("user_version", { simple: true })).toBe(2);
  check.close();
  expect(
    (await readdir(f.root)).some((name) => name.includes(".migration-v2-")),
  ).toBe(true);
  f.fault();
  await f.reopen();
  expect(value(await f.store.getReceipt("seed", f.ctx("seed")))).not.toBeNull();
});

test("scans are bounded and usage reservations remain cumulative across retries", async () => {
  const f = await setup();
  const running = await claim(f);
  expect(
    await f.store.jobs.scan({ states: ["queued"], limit: 1001 }, f.ctx()),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  expect(
    await f.store.jobs.update(
      "job-work",
      fence(running),
      {
        kind: "reserve-usage",
        id: "effect1",
        usage: {
          inputBytes: 0,
          outputBytes: 0,
          externalCalls: 1,
          modelTokens: 0,
          costMicros: 0,
        },
      },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  const reserved = value(
    await f.store.jobs.update(
      "job-work",
      fence(running),
      {
        kind: "reserve-usage",
        id: "effect2",
        usage: {
          inputBytes: 1,
          outputBytes: 2,
          externalCalls: 0,
          modelTokens: 0,
          costMicros: 0,
        },
      },
      f.ctx(),
    ),
  );
  expect(
    await f.store.jobs.update(
      "job-work",
      fence(reserved),
      {
        kind: "retry",
        error: { ...error, retryable: true },
        nextEligibleAttempt: "2026-09-17T00:00:00.010Z",
      },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test.each([
  "job-after-artifacts",
  "job-after-receipt",
  "job-after-state",
  "before-commit",
])(
  "fault %s rolls back every authoritative job output row and reference",
  async (point) => {
    const f = await setup();
    const { record, output } = await completion(f, await claim(f, ["device1"]));
    const baseline = value(await f.store.backup(f.ctx("backup")));
    f.fault(point);
    expect(
      await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
    ).toMatchObject({ status: "failed" });
    f.fault();
    expect(value(await f.store.backup(f.ctx("backup")))).toEqual(baseline);
    await f.reopen();
    expect(
      value(await f.store.jobs.getJobReceipt("job-work", f.ctx())),
    ).toBeNull();
  },
);

test("staging reserves cumulative bytes before I/O and retains returned identity on expiry", async () => {
  const f = await setup();
  const running = await claim(f);
  const stage = f.disk.fs.stage;
  f.disk.fs.stage = async (...args) => {
    const result = await stage(...args);
    f.advance(1000);
    return result;
  };
  expect(
    await f.store.jobs.stage(
      "job-work",
      fence(running),
      bytes("output"),
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const record = value(await f.store.jobs.get("job-work", f.ctx()));
  expect(record.usage.outputBytes).toBe(6);
  expect(record.rowVersion).toBeGreaterThan(running.rowVersion);
  const backup = value(await f.store.backup(f.ctx("backup")));
  if (backup.metadata.storageVersion !== 4) throw new Error("Expected v4.");
  expect(backup.metadata.jobStages).toHaveLength(1);
  expect(backup.metadata.jobStages[0]?.disposition).toBe("recovery-needed");
  expect(
    value(
      await f.store.jobs.canDiscardStage(
        required(backup.metadata.jobStages[0]).stagingId,
        f.ctx(),
      ),
    ),
  ).toBe(false);
});

test("host stage interruption before journaling retains unknown evidence and reserved bytes", async () => {
  const f = await setup();
  const running = await claim(f);
  f.fault("job-after-stage");
  expect(
    await f.store.jobs.stage(
      "job-work",
      fence(running),
      bytes("orphan stage"),
      f.ctx(),
    ),
  ).toMatchObject({ status: "failed" });
  f.fault();
  expect(
    value(await f.store.jobs.get("job-work", f.ctx())).usage.outputBytes,
  ).toBe(12);
  const stages = await readdir(join(f.root, "staged"));
  expect(stages).toHaveLength(1);
  expect(
    value(await f.store.jobs.canDiscardStage(required(stages[0]), f.ctx())),
  ).toBe(false);
});

test("cancellation may be requested during an unresolved effect but never acknowledges an unknown stop", async () => {
  const f = await setup();
  const running = await claim(f);
  const record = value(
    await f.store.jobs.update(
      "job-work",
      fence(running),
      {
        kind: "reserve-usage",
        id: "effect",
        usage: {
          inputBytes: 1,
          outputBytes: 0,
          externalCalls: 0,
          modelTokens: 0,
          costMicros: 0,
        },
      },
      f.ctx(),
    ),
  );
  const cancelled = value(
    await f.store.jobs.requestCancel("job-work", record.rowVersion, f.ctx()),
  );
  expect(cancelled.job.status).toBe("cancel-requested");
  expect(
    await f.store.jobs.update(
      "job-work",
      fence(cancelled),
      { kind: "acknowledge-cancel" },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("both directions of legacy logical write key reuse conflict; other operations remain independent", async () => {
  const f = await setup();
  expect(
    await f.store.jobs.create(
      { ...f.submission("job-new"), operation: "write" },
      { ...f.ctx("seed"), jobId: "job-new" },
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  const queued = value(
    await f.store.jobs.create(
      { ...f.submission(), operation: "write" },
      f.ctx(),
    ),
  );
  expect(queued.job.operation).toBe("write");
  const staged = value(await f.store.stage(bytes("legacy"), f.ctx("legacy")));
  expect(
    await f.store.commit([staged], { ...f.ctx(), jobId: "job-legacy" }),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("authorization precedes job lookup and completion validates outputs before publication acceptance", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  let checks = 0;
  f.options.authorize = async (_context, scope) => {
    if (scope.resourceKind === "job") {
      checks++;
      throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
    }
  };
  expect(await f.store.jobs.getJobReceipt("missing", f.ctx())).toMatchObject({
    error: { code: "FORBIDDEN" },
  });
  expect(checks).toBe(1);
  expect(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
});

test("immutable submission proof survives backup roundtrip and tampered private usage fails graph validation", async () => {
  const f = await setup();
  await claim(f);
  const backup = value(await f.store.backup(f.ctx("backup")));
  if (backup.metadata.storageVersion !== 4) throw new Error("Expected v4.");
  required(backup.metadata.jobs[0]).usage.externalCalls = 10;
  backup.sha256 = hash(f.options.canonicalBytes(backup.metadata));
  const destination = await mkdtemp(join(tmpdir(), "tampered jobs "));
  roots.push(destination);
  const disk = await diskFixture(destination);
  const store = await LocalStore.open({
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  });
  stores.push(store);
  expect(await store.restore(backup, f.ctx("restore"))).toMatchObject({
    status: "failed",
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});

test("authorized bounded stage enumeration survives restart without granting cleanup authority", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  expect(
    value(await f.store.jobs.getStages("job-work", f.ctx()))[0]?.staged,
  ).toEqual(output.outputs[0]);
  await f.reopen();
  const stages = value(await f.store.jobs.getStages("job-work", f.ctx()));
  expect(stages).toHaveLength(1);
  expect(
    value(
      await f.store.jobs.canDiscardStage(
        required(stages[0]).stagingId,
        f.ctx(),
      ),
    ),
  ).toBe(false);
  expect(record.job.attempt).toBe(1);
});

test("worker contexts cannot substitute an untrusted clock reference", async () => {
  const f = await setup();
  const record = await claim(f);
  const ctx = f.ctx();
  expect(
    await f.store.jobs.heartbeat("job-work", fence(record), 1000, {
      ...ctx,
      clock: { ...ctx.clock },
    }),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
});

test("receipt-first replay resolves original owner for an authorized different reader and lost response", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  f.fault("after-commit");
  const done = value(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  );
  f.fault();
  const observer = f.ctx("observer");
  observer.authorization.actorId = "reviewer";
  expect(value(await f.store.jobs.getJobReceipt("job-work", observer))).toEqual(
    done.receipt,
  );
  expect(
    value(await f.store.jobs.requestCancel("job-work", 1, observer)).job
      .receipt,
  ).toEqual(done.receipt);
  expect(
    value(
      await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
    ).receipt,
  ).toEqual(done.receipt);
});

test("progress, retry due time and cumulative usage persist without retry budget reset", async () => {
  const f = await setup();
  let record = await claim(f);
  record = value(
    await f.store.jobs.update(
      "job-work",
      fence(record),
      { kind: "progress", sequence: 1, progress: 0.2 },
      f.ctx(),
    ),
  );
  expect(
    await f.store.jobs.update(
      "job-work",
      fence(record),
      { kind: "progress", sequence: 2, progress: 0.3 },
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  record = value(
    await f.store.jobs.update(
      "job-work",
      fence(record),
      {
        kind: "reserve-usage",
        id: "effect",
        usage: {
          inputBytes: 3,
          outputBytes: 0,
          externalCalls: 0,
          modelTokens: 0,
          costMicros: 0,
        },
      },
      f.ctx(),
    ),
  );
  record = value(
    await f.store.jobs.update(
      "job-work",
      fence(record),
      { kind: "settle-usage", id: "effect", result: "no-effect" },
      f.ctx(),
    ),
  );
  record = value(
    await f.store.jobs.update(
      "job-work",
      fence(record),
      {
        kind: "retry",
        error: { ...error, retryable: true },
        nextEligibleAttempt: "2026-09-17T00:00:00.100Z",
      },
      f.ctx(),
    ),
  );
  await f.reopen();
  expect(
    await f.store.jobs.claim(
      "job-work",
      { state: "retry-wait", rowVersion: record.rowVersion },
      "worker2",
      1000,
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  f.advance(100);
  const next = value(
    await f.store.jobs.claim(
      "job-work",
      { state: "retry-wait", rowVersion: record.rowVersion },
      "worker2",
      1000,
      f.ctx(),
    ),
  );
  expect(next.job.attempt).toBe(2);
  expect(next.usage.inputBytes).toBe(3);
  expect(next.effects[0]?.state).toBe("no-effect");
});

test("completed stage cleanup needs explicit trusted disposition; restored stage authority is never transplanted", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  const done = value(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  );
  const id = required(output.outputs[0]).stagingId;
  expect(value(await f.store.jobs.canDiscardStage(id, f.ctx()))).toBe(false);
  const abandoned = value(
    await f.store.jobs.reconcile(
      "job-work",
      done.record.rowVersion,
      {
        kind: "abandon-stages",
        evidenceRef: "stop-proof",
        abandonedStageIds: [id],
      },
      f.ctx(),
    ),
  );
  expect(abandoned.job.status).toBe("completed");
  expect(value(await f.store.jobs.canDiscardStage(id, f.ctx()))).toBe(true);
  await f.reopen();
  expect(value(await f.store.jobs.canDiscardStage(id, f.ctx()))).toBe(false);
});

test("new jobs cannot appropriate a legacy receipt's historical job identity", async () => {
  const f = await setup();
  expect(
    await f.store.jobs.create(f.submission("job-seed"), {
      ...f.ctx("new-key"),
      jobId: "job-seed",
    }),
  ).toMatchObject({ error: { code: "CONFLICT" } });
  expect(value(await f.store.getReceipt("seed", f.ctx("seed")))).not.toBeNull();
});

test("backup refuses missing authoritative input reference edges", async () => {
  const f = await setup();
  await claim(f);
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    db.exec("DELETE FROM artifact_refs WHERE owner_kind='job-input'");
  } finally {
    db.close();
  }
  await f.reopen();
  expect(await f.store.backup(f.ctx("backup"))).toMatchObject({
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});

test("job backup rejects a running job missing one of its all-or-none reservations", async () => {
  const f = await setup();
  await claim(f, ["key1"]);
  const backup = value(await f.store.backup(f.ctx("backup")));
  if (backup.metadata.storageVersion !== 4) throw new Error("Expected v4.");
  required(backup.metadata.jobs[0]).resources = [];
  backup.metadata.jobResources = [];
  backup.sha256 = hash(f.options.canonicalBytes(backup.metadata));
  const destination = await mkdtemp(
    join(tmpdir(), "invalid reservation jobs "),
  );
  roots.push(destination);
  const disk = await diskFixture(destination);
  const store = await LocalStore.open({
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  });
  stores.push(store);
  expect(await store.restore(backup, f.ctx("restore"))).toMatchObject({
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});

test("claims enforce exact trusted worker ceiling and immutable configuration", async () => {
  const f = await setup(1);
  await claim(f);
  required(f.options.jobs).maxWorkers = 4;
  const next = value(
    await f.store.jobs.create(f.submission("job-other"), f.ctx("other")),
  );
  expect(
    await f.store.jobs.claim(
      "job-other",
      { state: "queued", rowVersion: next.rowVersion },
      "worker2",
      1000,
      f.ctx("other"),
    ),
  ).toMatchObject({ error: { code: "CONFLICT" } });
});

test("bounded scans use explicit authorized IDs, deterministic pages, and persisted due times", async () => {
  const f = await setup();
  for (const id of ["a", "b", "c"])
    value(await f.store.jobs.create(f.submission(`job-${id}`), f.ctx(id)));
  const ctx = f.ctx("observer");
  ctx.authorization.grants = ["a", "b", "c"].map((id) => ({
    resourceKind: "job",
    resourceId: `job-${id}`,
    operations: ["read"],
  }));
  const first = value(
    await f.store.jobs.scan({ states: ["queued"], limit: 2 }, ctx),
  );
  expect(first.records.map((r) => r.job.id)).toEqual(["job-a", "job-b"]);
  expect(first.nextCursor).not.toBeNull();
  const second = value(
    await f.store.jobs.scan(
      { states: ["queued"], limit: 2, cursor: required(first.nextCursor) },
      ctx,
    ),
  );
  expect(second.records.map((r) => r.job.id)).toEqual(["job-c"]);
  expect(second.nextCursor).toBeNull();
  expect(
    await f.store.jobs.scan({ states: ["queued"], limit: 101 }, ctx),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
});

test("hash-correct artifact metadata without committed publication is not accepted as job input", async () => {
  const f = await setup();
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    db.exec("DELETE FROM receipts; DELETE FROM artifact_refs");
  } finally {
    db.close();
  }
  await f.reopen();
  expect(await f.store.jobs.create(f.submission(), f.ctx())).toMatchObject({
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});

test("resource and row counters fail on overflow instead of wrapping", async () => {
  const f = await setup();
  const queued = value(
    await f.store.jobs.create(f.submission("job-work", ["key"]), f.ctx()),
  );
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    db.prepare("INSERT INTO job_resources VALUES (?,?)").run(
      "key",
      JSON.stringify({
        key: "key",
        generation: Number.MAX_SAFE_INTEGER,
        state: "released",
        jobId: null,
        leaseId: null,
        fencingToken: null,
      }),
    );
  } finally {
    db.close();
  }
  await f.reopen();
  expect(
    await f.store.jobs.claim(
      "job-work",
      { state: "queued", rowVersion: queued.rowVersion },
      "worker",
      1000,
      f.ctx(),
    ),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  expect(value(await f.store.jobs.get("job-work", f.ctx())).job.attempt).toBe(
    0,
  );
});

test("due scans compare timestamp instants rather than optional fractional formatting", async () => {
  const f = await setup();
  const running = await claim(f);
  value(
    await f.store.jobs.update(
      "job-work",
      fence(running),
      {
        kind: "retry",
        error: { ...error, retryable: true },
        nextEligibleAttempt: "2026-09-17T00:00:00Z",
      },
      f.ctx(),
    ),
  );
  const ctx = f.ctx("observer");
  ctx.authorization.grants = [
    { resourceKind: "job", resourceId: "job-work", operations: ["read"] },
  ];
  const page = value(
    await f.store.jobs.scan(
      {
        states: ["retry-wait"],
        limit: 1,
        dueBefore: "2026-09-17T00:00:00.100Z",
      },
      ctx,
    ),
  );
  expect(page.records).toHaveLength(1);
  expect(page.records[0]?.job.nextEligibleAttempt).toBe("2026-09-17T00:00:00Z");
});

test("garbage collection preserves uncommitted published bytes owned by retained job staging", async () => {
  const f = await setup();
  const { record, output } = await completion(f, await claim(f));
  f.fault("before-commit");
  expect(
    await f.store.jobs.commitJob("job-work", fence(record), output, f.ctx()),
  ).toMatchObject({ status: "failed" });
  f.fault();
  expect(value(await f.store.collectGarbage(f.ctx("collect"))).deleted).toEqual(
    [],
  );
  const artifact = required(output.outputs[0]).artifact;
  expect(
    value(
      await f.disk.fs.read(
        { artifactRootId: "artifact-root", path: artifact.path },
        f.ctx(),
      ),
    ),
  ).toEqual(bytes("output"));
});

test("v2 migration cannot proceed without the mandatory backup durability acknowledgment", async () => {
  const f = await setup();
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    db.exec(
      "DROP TABLE artifact_bindings; DROP TABLE job_stages; DROP TABLE job_resources; DROP TABLE jobs; PRAGMA user_version=2",
    );
  } finally {
    db.close();
  }
  let requestedBackup: string | undefined;
  f.options.ensureDatabaseBackupDurable = async (path) => {
    requestedBackup = path;
    throw new Error(
      "No physical database-backup durability implementation in this fixture.",
    );
  };
  await expect(LocalStore.open(f.options)).rejects.toMatchObject({
    code: "ACTION_REQUIRED",
  });
  expect(requestedBackup).toContain(".migration-v2-");
  const unchanged = new Database(f.options.databasePath, { nativeBinding });
  try {
    expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
    expect(
      unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='jobs'").get(),
    ).toBeUndefined();
  } finally {
    unchanged.close();
  }
  const copy = new Database(required(requestedBackup), {
    nativeBinding,
    readonly: true,
  });
  try {
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    copy.close();
  }
});

test("v2 backup import preserves legacy receipts without inventing historical jobs", async () => {
  const f = await setup();
  const backup = value(await f.store.backup(f.ctx("backup")));
  const {
    storageVersion: _version,
    jobs: _jobs,
    jobResources: _resources,
    jobStages: _stages,
    artifactBindings: _bindings,
    ...legacy
  } = backup.metadata as Extract<typeof backup.metadata, { storageVersion: 4 }>;
  backup.metadata = { storageVersion: 2, ...legacy };
  backup.sha256 = hash(f.options.canonicalBytes(backup.metadata));
  const destination = await mkdtemp(join(tmpdir(), "legacy backup jobs "));
  roots.push(destination);
  const disk = await diskFixture(destination);
  const store = await LocalStore.open({
    ...f.options,
    databasePath: join(destination, "state.sqlite"),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
  });
  stores.push(store);
  value(await store.restore(backup, f.ctx("restore")));
  expect(value(await store.getReceipt("seed", f.ctx("seed")))).not.toBeNull();
  expect(await store.jobs.get("job-seed", f.ctx("seed"))).toMatchObject({
    error: { code: "NOT_FOUND" },
  });
});

test.each(["heartbeat", "progress"] as const)(
  "worker %s rechecks its original live lease at the synchronous transaction boundary",
  async (kind) => {
    const f = await setup();
    const record = await claim(f);
    f.beforeCommit(() => f.advance(1000));
    const result =
      kind === "heartbeat"
        ? await f.store.jobs.heartbeat("job-work", fence(record), 2000, f.ctx())
        : await f.store.jobs.update(
            "job-work",
            fence(record),
            { kind: "progress", sequence: 1, progress: 0.5 },
            f.ctx(),
          );

    expect(result).toMatchObject({ error: { code: "CONFLICT" } });
    f.beforeCommit();
    expect(value(await f.store.jobs.get("job-work", f.ctx())).rowVersion).toBe(
      record.rowVersion,
    );
  },
);

test("configured product ceiling admits exactly four workers, never a fifth", async () => {
  const f = await setup(4);
  for (let i = 1; i <= 5; i++) {
    const id = `worker${i}`;
    const queued = value(
      await f.store.jobs.create(f.submission(`job-${id}`), f.ctx(id)),
    );
    const result = await f.store.jobs.claim(
      queued.job.id,
      { state: "queued", rowVersion: queued.rowVersion },
      id,
      1000,
      f.ctx(id),
    );
    if (i <= 4) expect(value(result).job.status).toBe("running");
    else expect(result).toMatchObject({ error: { code: "CONFLICT" } });
  }
});

test("fixed retained-job admission limit rejects entry 20001 without deleting history", async () => {
  const f = await setup();
  value(await f.store.jobs.create(f.submission(), f.ctx()));
  f.store.close();
  const db = new Database(f.options.databasePath, { nativeBinding });
  try {
    // Synthetic capacity rows are never read as job evidence; this targets admission COUNT.
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<19999)
                INSERT INTO jobs SELECT 'capacity-'||x,'capacity-'||x,'cancelled','2026-09-17T00:00:00.000Z',NULL,'{}' FROM n`);
  } finally {
    db.close();
  }
  await f.reopen();
  expect(
    await f.store.jobs.create(f.submission("job-overflow"), f.ctx("overflow")),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
});

test.each(["modelTokens", "costMicros"] as const)(
  "default zero %s is an exact reservation limit",
  async (kind) => {
    const f = await setup();
    const record = await claim(f);
    const amount = {
      inputBytes: 0,
      outputBytes: 0,
      externalCalls: 0,
      modelTokens: 0,
      costMicros: 0,
    };
    amount[kind] = 1;
    expect(
      await f.store.jobs.update(
        "job-work",
        fence(record),
        { kind: "reserve-usage", id: "external", usage: amount },
        f.ctx(),
      ),
    ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
    expect(value(await f.store.jobs.get("job-work", f.ctx())).usage[kind]).toBe(
      0,
    );
  },
);
