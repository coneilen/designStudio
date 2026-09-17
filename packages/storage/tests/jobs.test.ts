import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BUDGETS,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { LocalStore, type StorageOptions } from "../src/index.js";
import type {
  JobCompletion,
  JobSubmission,
  JobWorkerExpected,
  StoredJob,
} from "../src/job-types.js";
import { bytes, context, diskFixture, hash, revision } from "./support.js";

const roots: string[] = [];
const stores: LocalStore[] = [];
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
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
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
async function setup(maxWorkers = 1) {
  const root = await mkdtemp(join(tmpdir(), "job transactions "));
  roots.push(root);
  const disk = await diskFixture(root);
  let now = Date.parse("2026-09-17T00:00:00.000Z");
  let fault: string | undefined;
  let beforeCommit: (() => void) | undefined;
  let barrier = async () => {};
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
      verifyCompletion: async () => {},
      authorizeRecovery: async () => {},
    },
    fault: (point) => {
      if (point === "before-commit") beforeCommit?.();
      if (fault === point) throw new Error("Synthetic transaction fault.");
    },
  };
  let store = await LocalStore.open(options);
  stores.push(store);
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
    async reopen() {
      store.close();
      store = await LocalStore.open(options);
      stores.push(store);
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
  expect(backup.metadata.storageVersion).toBe(3);
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
      "DROP TABLE job_stages; DROP TABLE job_resources; DROP TABLE jobs; PRAGMA user_version=2",
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
  if (backup.metadata.storageVersion !== 3) throw new Error("Expected v3.");
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
  if (backup.metadata.storageVersion !== 3) throw new Error("Expected v3.");
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
  if (backup.metadata.storageVersion !== 3) throw new Error("Expected v3.");
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
      "DROP TABLE job_stages; DROP TABLE job_resources; DROP TABLE jobs; PRAGMA user_version=2",
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
    code: "IO_FAILURE",
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
    ...legacy
  } = backup.metadata as Extract<typeof backup.metadata, { storageVersion: 3 }>;
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
    error: { code: "EVIDENCE_MISSING" },
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
