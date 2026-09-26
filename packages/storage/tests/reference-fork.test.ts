import {
  link,
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
import type {
  Artifact,
  OperationContext,
  Outcome,
} from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import { ProjectFileSystem } from "@design-studio/host";
import Database from "better-sqlite3";
import { afterEach, aroundEach, expect, test as vitestTest } from "vitest";
import {
  AsyncTestScope,
  inTestScope,
  ownTests,
  testScope,
} from "../../jobs/tests/test-scope.js";
import { initializeImmutableSqlite } from "../src/immutable-sqlite.js";
import {
  LocalStore,
  type ReferenceForkReservation,
  type StorageOptions,
} from "../src/index.js";
import { closeSettledStores, inStorageTest } from "./lifetime.js";
import { bytes, context, hash, syntheticImmutableSnapshot } from "./support.js";

initializeImmutableSqlite(
  path.resolve(".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node"),
);

const test = ownTests(vitestTest);
const roots: string[] = [];
const stores: LocalStore[] = [];
const files: ProjectFileSystem[] = [];
aroundEach((run, ctx) =>
  inTestScope(new AsyncTestScope(ctx.signal), () =>
    inStorageTest(ctx.signal, run),
  ),
);
afterEach(async () => {
  await testScope().close();
  await closeSettledStores(stores);
  for (const fs of files.splice(0)) await fs.closePreservingStages();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function value<T>(outcome: Outcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  if (outcome.status !== "complete")
    throw new Error("Expected complete fixture operation.");
  return outcome.value;
}
const describeBytes = (b: Uint8Array): Artifact => ({
  id: `sha256_${hash(b)}`,
  sha256: hash(b),
  path: `blobs/${hash(b)}`,
  byteLength: b.length,
  mediaType: "application/octet-stream",
});
async function fixture(fault?: StorageOptions["fault"]) {
  const root = await mkdtemp(path.join(tmpdir(), "reference-fork-test-"));
  roots.push(root);
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts);
  const ctx: OperationContext = context(`fork_reference_${"a".repeat(64)}`);
  ctx.jobId = ctx.requestId;
  ctx.authorization.grants = [
    {
      resourceKind: "artifact",
      resourceId: "artifact-root",
      operations: ["read", "write"],
    },
    {
      resourceKind: "job",
      resourceId: ctx.jobId,
      operations: ["read", "write"],
    },
  ];
  let reservation: ReferenceForkReservation | undefined;
  let stageFault:
    | "before-create"
    | "partial-write"
    | "after-create"
    | "link"
    | "copy"
    | undefined;
  let stageCalls = 0;
  let pauseStage: (() => Promise<void>) | undefined;
  const fs = await ProjectFileSystem.create({
    projectId: ctx.projectId,
    authority: () => true,
    roots: [
      {
        id: "artifact-root",
        path: artifacts,
        access: "read-write",
        managedBlobs: true,
        trustedExclusiveAccess: true,
      },
    ],
    reservedStaging: {
      authorize: async (selected) => {
        expect(reservation?.hostId).toBe(selected.hostId);
        expect(reservation?.stages).toContainEqual({
          stagingId: selected.stagingId,
          artifact: selected.artifact,
        });
      },
    },
  });
  files.push(fs);
  const deny = async (): Promise<never> => {
    throw new Error("Unrelated operation");
  };
  const opts: StorageOptions = {
    databasePath: path.join(root, "state.sqlite"),
    nativeBinding: path.resolve(
      ".tools/sqlite-prebuild/build/Release/better_sqlite3.node",
    ),
    projectId: "project1",
    artifactRootId: "artifact-root",
    permissionScope: "permission1",
    canonicalBytes,
    fileSystem: fs,
    authorize: async () => {},
    attestLocalDatabase: async () => {},
    ensurePublicationDurable: async () => {},
    ensureDatabaseBackupDurable: deny,
    verifyRevision: deny,
    assessApproval: deny,
    authorizeRestore: deny,
    authorizeRetention: deny,
    canDiscardStage: deny,
    maintenance: { inventory: deny, removeBlob: deny },
    ...(fault ? { fault } : {}),
    referenceFork: {
      authorize: async (c) => {
        expect(c.jobId).toBe(ctx.jobId);
      },
      stage: async (r, index, b, c) => {
        stageCalls++;
        const db: unknown = Reflect.get(store, "db");
        if (!(db instanceof Database))
          throw new Error("Missing owned SQLite connection.");
        {
          // The exclusive connection has committed the reservation before physical creation.
          expect(db.inTransaction).toBe(false);
          const row = db
            .prepare<[], { data: string }>("SELECT data FROM reference_fork")
            .get();
          expect(row).toBeDefined();
          const persisted = JSON.parse(row!.data);
          expect(persisted.hostId).toBe(r.hostId);
          expect(persisted.stages).toEqual(r.stages);
          expect(persisted.staged).toBe(index);
        }
        const s = r.stages[index]!;
        const host = path.join(artifacts, `.host-${r.hostId}`);
        const stage = path.join(host, s.stagingId);
        if (stageFault === "before-create")
          throw new Error("Synthetic precreate interruption");
        if (stageFault === "partial-write" || stageFault === "copy") {
          await mkdir(host);
          await writeFile(stage, stageFault === "copy" ? b : b.subarray(0, 1), {
            flag: "wx",
          });
          if (stageFault === "partial-write")
            throw new Error("Synthetic partial write");
        }
        const out = value(
          await fs.stageReserved(
            { ...s, hostId: r.hostId },
            "artifact-root",
            b,
            c,
          ),
        );
        await pauseStage?.();
        if (stageFault === "after-create")
          throw new Error("Synthetic lost stage return");
        if (stageFault === "link")
          await link(stage, path.join(root, "second-link"));
        return out;
      },
    },
  };
  const store = await LocalStore.open(opts);
  stores.push(store);
  const data = [bytes("origin evidence"), bytes("destination output")];
  const binding = {
    version: 1 as const,
    operationId: ctx.jobId,
    projectId: "project1",
    artifactRootId: "artifact-root",
    actorId: "actor1",
    sourceProjectId: "origin-project",
    originSha256: hash(data[0]!),
    resultSha256: hash(data[1]!),
    policySha256: "b".repeat(64),
  };
  return {
    root,
    artifacts,
    ctx,
    opts,
    store,
    data,
    binding,
    fs,
    get reservation() {
      if (!reservation) throw new Error("Missing reservation");
      return reservation;
    },
    get stageCalls() {
      return stageCalls;
    },
    faultStage(value: typeof stageFault) {
      stageFault = value;
    },
    pauseStage(value: () => Promise<void>) {
      pauseStage = value;
    },
    async reserve() {
      reservation = value(
        await store.reserveReferenceFork(binding, data.map(describeBytes), ctx),
      );
      return reservation;
    },
  };
}
test("fork stages have durable reserved IDs before create and commit fresh destination receipt atomically", async () => {
  const f = await fixture();
  const r = await f.reserve();
  expect(await readdir(f.artifacts)).toEqual([]);
  for (const [i, b] of f.data.entries())
    value(await f.store.stageReferenceFork(r, i, b, f.ctx));
  const receipt = value(await f.store.commitReferenceFork(r, f.ctx));
  expect(receipt.projectId).toBe("project1");
  expect(receipt.jobId).toBe(f.binding.operationId);
  expect(receipt.outputs).toEqual(f.data.map(describeBytes));
  for (const a of receipt.outputs)
    expect(hash(await readFile(path.join(f.artifacts, a.path)))).toBe(a.sha256);
  expect(await f.store.commitReferenceFork(r, f.ctx)).toMatchObject({
    status: "failed",
    error: { code: "CONFLICT" },
  });
  expect(await f.store.stage(f.data[0]!, f.ctx)).toMatchObject({
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });
});
test.each([
  "before-create",
  "partial-write",
  "after-create",
  "copy",
  "link",
] as const)(
  "fork %s interruption retains reserved identity and cannot publish or cold-replay",
  async (fault) => {
    const f = await fixture();
    const r = await f.reserve();
    f.faultStage(fault);
    const staged = await f.store.stageReferenceFork(r, 0, f.data[0]!, f.ctx);
    if (fault !== "link") expect(staged.status).toBe("failed");
    else expect(staged.status).toBe("complete");
    if (fault === "link")
      expect((await f.fs.publish(r.stages[0]!, f.ctx)).status).toBe("failed");
    expect((await f.store.commitReferenceFork(r, f.ctx)).status).toBe("failed");
    f.store.close();
    await expect(LocalStore.open(f.opts)).rejects.toThrow(/fresh destination/);
    const { referenceFork: _fork, ...ordinary } = f.opts;
    await expect(LocalStore.open(ordinary)).rejects.toThrow(
      /fresh destination/,
    );
    const db = new Database(f.opts.databasePath, {
      nativeBinding: f.opts.nativeBinding,
      readonly: true,
    });
    try {
      const row = db
        .prepare<[], { data: string }>("SELECT data FROM reference_fork")
        .get()!;
      expect(JSON.parse(row.data).stages).toEqual(r.stages);
      expect(db.prepare("SELECT scope FROM receipts").all()).toEqual([]);
    } finally {
      db.close();
    }
  },
);
test.each([
  "fork-after-reservation",
  "fork-after-stage",
  "fork-before-receipt",
] as const)(
  "fork durable boundary %s never loses reserved ownership",
  async (fault) => {
    const f = await fixture((point) => {
      if (point === fault) throw new Error("Synthetic crash");
    });
    if (fault === "fork-after-reservation")
      expect(
        (
          await f.store.reserveReferenceFork(
            f.binding,
            f.data.map(describeBytes),
            f.ctx,
          )
        ).status,
      ).toBe("failed");
    else {
      const r = await f.reserve();
      const first = await f.store.stageReferenceFork(r, 0, f.data[0]!, f.ctx);
      if (fault === "fork-after-stage") expect(first.status).toBe("failed");
      else {
        value(first);
        value(await f.store.stageReferenceFork(r, 1, f.data[1]!, f.ctx));
        expect((await f.store.commitReferenceFork(r, f.ctx)).status).toBe(
          "failed",
        );
      }
    }
    f.store.close();
    const db = new Database(f.opts.databasePath, {
      nativeBinding: f.opts.nativeBinding,
      readonly: true,
    });
    try {
      expect(db.prepare("SELECT data FROM reference_fork").all()).toHaveLength(
        1,
      );
      expect(db.prepare("SELECT scope FROM receipts").all()).toEqual([]);
    } finally {
      db.close();
    }
    await expect(LocalStore.open(f.opts)).rejects.toThrow(/fresh destination/);
  },
);
test("fork rejects changed origin, duplicate outputs and changed reserved stage before physical work", async () => {
  const f = await fixture();
  expect(
    (
      await f.store.reserveReferenceFork(
        { ...f.binding, sourceProjectId: "project1" },
        f.data.map(describeBytes),
        f.ctx,
      )
    ).status,
  ).toBe("failed");
  expect(
    (
      await f.store.reserveReferenceFork(
        f.binding,
        [describeBytes(f.data[0]!), describeBytes(f.data[0]!)],
        f.ctx,
      )
    ).status,
  ).toBe("failed");
  const r = await f.reserve();
  expect(
    (
      await f.store.stageReferenceFork(r, 0, f.data[0]!, {
        ...f.ctx,
        budget: { ...f.ctx.budget, maxInputBytes: 1 },
      })
    ).status,
  ).toBe("failed");
  expect(
    (
      await f.store.stageReferenceFork(
        { ...r, hostId: "00000000-0000-4000-8000-000000000001" },
        0,
        f.data[0]!,
        f.ctx,
      )
    ).status,
  ).toBe("failed");
  expect(
    (await f.store.stageReferenceFork(r, 0, bytes("wrong"), f.ctx)).status,
  ).toBe("failed");
  expect(f.stageCalls).toBe(0);
});
test("fork cancellation joins the original stage write before SQLite owner closure", async () => {
  const f = await fixture();
  const r = await f.reserve();
  const abort = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pauseStage(async () => {
    entered();
    await wait;
  });
  const pending = f.store.stageReferenceFork(r, 0, f.data[0]!, {
    ...f.ctx,
    signal: abort.signal,
  });
  try {
    await started;
    abort.abort();
    expect(() => f.store.close()).toThrow(/in-flight/);
  } finally {
    release();
  }
  expect(await pending).toMatchObject({
    status: "cancelled",
    error: { code: "CANCELLED" },
  });
  f.store.close();
  await expect(LocalStore.open(f.opts)).rejects.toThrow(/fresh destination/);
});
test("fork rejects same-content stage substitution, unreserved duplicates and wrong root", async () => {
  const f = await fixture();
  const r = await f.reserve();
  value(await f.store.stageReferenceFork(r, 0, f.data[0]!, f.ctx));
  const descriptors = r.stages.map((s) => ({ ...s, hostId: r.hostId }));
  value(await f.fs.checkReservedNamespace("artifact-root", descriptors, f.ctx));
  expect(
    (await f.fs.checkReservedNamespace("wrong-root", descriptors, f.ctx))
      .status,
  ).toBe("failed");
  const duplicate = path.join(
    f.artifacts,
    `.host-${r.hostId}`,
    "00000000-0000-4000-8000-000000000001",
  );
  await writeFile(duplicate, f.data[0]!, { flag: "wx" });
  expect(
    (await f.fs.checkReservedNamespace("artifact-root", descriptors, f.ctx))
      .status,
  ).toBe("failed");
  await rm(duplicate);
  const stage = path.join(
    f.artifacts,
    `.host-${r.hostId}`,
    r.stages[0]!.stagingId,
  );
  await rm(stage);
  await writeFile(stage, f.data[0]!, { flag: "wx" });
  expect(
    (await f.fs.checkReservedNamespace("artifact-root", descriptors, f.ctx))
      .status,
  ).toBe("failed");
});
test("fork rejects a reparse replacement of its reserved staging directory", async () => {
  const f = await fixture();
  const r = await f.reserve();
  value(await f.store.stageReferenceFork(r, 0, f.data[0]!, f.ctx));
  const host = path.join(f.artifacts, `.host-${r.hostId}`);
  const moved = path.join(f.root, "moved-host");
  await rename(host, moved);
  await symlink(moved, host, "junction");
  expect(
    (
      await f.fs.checkReservedNamespace(
        "artifact-root",
        r.stages.map((s) => ({ ...s, hostId: r.hostId })),
        f.ctx,
      )
    ).status,
  ).toBe("failed");
});
test("fork deadline after physical stage leaves durable reservation without progress or receipt", async () => {
  const f = await fixture();
  const r = await f.reserve();
  let now = f.ctx.clock.now();
  const ctx = { ...f.ctx, clock: { ...f.ctx.clock, now: () => now } };
  f.pauseStage(async () => {
    now += 30001;
  });
  expect(await f.store.stageReferenceFork(r, 0, f.data[0]!, ctx)).toMatchObject(
    { status: "failed", error: { code: "DEADLINE_EXCEEDED" } },
  );
  f.store.close();
  const db = new Database(f.opts.databasePath, {
    nativeBinding: f.opts.nativeBinding,
    readonly: true,
  });
  try {
    const row = db
      .prepare<[], { data: string }>("SELECT data FROM reference_fork")
      .get();
    expect(JSON.parse(row!.data).staged).toBe(0);
  } finally {
    db.close();
  }
});
test("completed fork reads require exact receipt and reject partial or altered protection graph", async () => {
  const f = await fixture();
  const r = await f.reserve();
  for (const [i, b] of f.data.entries())
    value(await f.store.stageReferenceFork(r, i, b, f.ctx));
  const receipt = value(await f.store.commitReferenceFork(r, f.ctx));
  f.store.close();
  const { referenceFork: _write, ...base } = f.opts;
  const pin = await syntheticImmutableSnapshot(f.opts.databasePath);
  const readOptions = {
    ...base,
    access: "read-only" as const,
    readonlySnapshot: pin,
    referenceForkRead: {
      expectedReceiptSha256: canonicalDigest(receipt),
      authorize: async () => {},
    },
  };
  await expect(
    LocalStore.open({
      ...readOptions,
      referenceForkRead: {
        ...readOptions.referenceForkRead,
        expectedReceiptSha256: "0".repeat(64),
      },
    }),
  ).rejects.toThrow(/exact completed/);
  const reader = await LocalStore.open(readOptions);
  stores.push(reader);
  expect(value(await reader.referenceForkResult(f.ctx)).receipt).toEqual(
    receipt,
  );
  expect((await reader.commitReferenceFork(r, f.ctx)).status).toBe("failed");
  reader.close();
  pin.close();
  const db = new Database(f.opts.databasePath, {
    nativeBinding: f.opts.nativeBinding,
  });
  try {
    db.prepare("DELETE FROM artifact_refs").run();
  } finally {
    db.close();
  }
  const changedPin = await syntheticImmutableSnapshot(f.opts.databasePath);
  const changed = await LocalStore.open({
    ...readOptions,
    readonlySnapshot: changedPin,
  });
  stores.push(changed);
  expect((await changed.referenceForkResult(f.ctx)).status).toBe("failed");
  changed.close();
  changedPin.close();
});
test("partial fork cannot open through completed-result read admission", async () => {
  const f = await fixture();
  await f.reserve();
  f.store.close();
  const { referenceFork: _write, ...base } = f.opts;
  const pin = await syntheticImmutableSnapshot(f.opts.databasePath);
  await expect(
    LocalStore.open({
      ...base,
      access: "read-only",
      readonlySnapshot: pin,
      referenceForkRead: {
        expectedReceiptSha256: "a".repeat(64),
        authorize: async () => {},
      },
    }),
  ).rejects.toThrow(/Partial fork/);
  pin.close();
});
