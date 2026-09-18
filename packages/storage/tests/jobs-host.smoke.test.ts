import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AuthorizationContext,
  DEFAULT_BUDGETS,
  type OperationContext,
  type Outcome,
} from "@design-studio/contracts";
import { canonicalBytes } from "@design-studio/design-ir";
import {
  authorizeOperation,
  LocalSessionAuthenticator,
  ProjectFileSystem,
  SystemClock,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { afterEach, expect, test } from "vitest";
import {
  type JobSubmission,
  type JobWorkerExpected,
  LocalStore,
  type StoredJob,
} from "../src/index.js";

const roots: string[] = [];
const connections: { store: LocalStore; files: ProjectFileSystem }[] = [];
const inputBytes = canonicalBytes({ fixture: "synthetic-job-input" });
const outputBytes = canonicalBytes({
  fixture: "synthetic-job-output",
  complete: true,
});
const artifactId = (bytes: Uint8Array) =>
  `sha256_${createHash("sha256").update(bytes).digest("hex")}`;
const projectId = "native-jobs";
const artifactRootId = "native-artifacts";
function value<T>(result: Outcome<T>): T {
  expect(result.status, JSON.stringify(result)).toBe("complete");
  if (result.status !== "complete")
    throw new Error("Native composition failed.");
  return result.value;
}
function expected(record: StoredJob): JobWorkerExpected {
  if (!record.job.lease) throw new Error("Missing lease.");
  return {
    state: record.job.status,
    rowVersion: record.rowVersion,
    leaseId: record.job.lease.id,
    ownerId: record.job.lease.ownerId,
    fencingToken: record.generation,
    resources: record.resources,
  };
}
function issuer() {
  const clock = new SystemClock();
  const auth = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47112"],
    origins: ["http://127.0.0.1:47112"],
  });
  const grants: AuthorizationContext["grants"] = [
    ...[artifactRootId, artifactId(inputBytes), artifactId(outputBytes)].map(
      (id): AuthorizationContext["grants"][number] => ({
        resourceKind: "artifact",
        resourceId: id,
        operations: ["read", "write"],
      }),
    ),
    ...["seed", "one", "two", "backup", "restore"].map(
      (id): AuthorizationContext["grants"][number] => ({
        resourceKind: "job",
        resourceId: `job-${id}`,
        operations: ["read", "write"],
      }),
    ),
  ];
  const session = auth.createSession(
    {
      schemaVersion: "1.0",
      projectId,
      actorId: "actor",
      sessionId: "session",
      expiresAt: new Date(clock.now() + 120000).toISOString(),
      egress: "deny",
      grants,
    },
    "cli",
  );
  const authorization = auth.authenticate({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:47112",
    method: "POST",
    bearer: session.credential,
  });
  return {
    auth,
    clock,
    context(id: string): OperationContext {
      return {
        schemaVersion: "1.0",
        projectId,
        requestId: id,
        jobId: `job-${id}`,
        deadline: new Date(clock.now() + 30000).toISOString(),
        budget: { ...DEFAULT_BUDGETS },
        authorization,
        clock,
        signal: new AbortController().signal,
      };
    },
  };
}
async function open(
  root: string,
  owner: ReturnType<typeof issuer>,
  trustedBackups = new Set<string>(),
) {
  if (!roots.includes(root)) throw new Error("Only test-owned native roots.");
  const artifactPath = join(root, "artifacts");
  const databaseDirectory = join(root, "database");
  await mkdir(artifactPath, { recursive: true });
  await mkdir(databaseDirectory, { recursive: true });
  const databasePath = join(databaseDirectory, "state.sqlite");
  const files = await ProjectFileSystem.create({
    projectId,
    authority: owner.auth.authority,
    publicationProfile: WINDOWS_PUBLICATION_PROFILE,
    roots: [
      {
        id: artifactRootId,
        path: artifactPath,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ],
  });
  const outsideFixture = async (): Promise<never> => {
    throw new Error("Not authorized by this fixture.");
  };
  try {
    const store = await LocalStore.open({
      databasePath,
      nativeBinding: resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      projectId,
      artifactRootId,
      permissionScope: "fixture-owner",
      snapshotOperationContext,
      fileSystem: files,
      maintenance: {
        inventory: async (context, max) =>
          value(await files.inventory(artifactRootId, context, max)),
        removeBlob: outsideFixture,
      },
      authorize: async (context, scope) =>
        authorizeOperation(context, scope, owner.auth.authority),
      attestLocalDatabase: async (candidate) => {
        expect(candidate).toBe(databasePath);
        expect(await realpath(databaseDirectory)).toBe(databaseDirectory);
      },
      ensurePublicationDurable: async (artifacts, context) => {
        expect(
          value(
            await files.ensurePublicationDurable(
              artifactRootId,
              artifacts,
              context,
            ),
          ),
        ).toEqual({ durable: true, profile: WINDOWS_PUBLICATION_PROFILE });
      },
      // Fresh databases only: no simulated acknowledgment of physical migration durability.
      ensureDatabaseBackupDurable: outsideFixture,
      canonicalBytes,
      verifyRevision: outsideFixture,
      assessApproval: outsideFixture,
      authorizeRetention: outsideFixture,
      canDiscardStage: async () => false,
      authorizeRestore: async (backup) => {
        if (!trustedBackups.has(backup.sha256))
          throw new Error("Untrusted backup provenance.");
      },
      jobs: {
        clock: owner.clock,
        verifyCompletion: async (_record, completion, evidence) => {
          expect(completion.outputState).toBe("complete");
          expect(evidence).toHaveLength(1);
          expect(evidence[0]?.bytes).toEqual(outputBytes);
        },
        authorizeRecovery: outsideFixture,
      },
    });
    connections.push({ store, files });
    return { store, files };
  } catch (error) {
    await files.close();
    throw error;
  }
}
async function root() {
  const result = await mkdtemp(join(tmpdir(), "native persistent jobs "));
  roots.push(result);
  return result;
}
afterEach(async () => {
  for (const connection of connections.splice(0).reverse()) {
    connection.store.close();
    await connection.files.close();
  }
  for (const directory of roots.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test.runIf(process.platform === "win32" && process.arch === "x64")(
  "fresh real host/SQLite jobs compose, reuse operation-bound historical publication, and restore under destination barriers",
  async () => {
    const owner = issuer();
    const path = await root();
    let connection = await open(path, owner);
    const seed = value(
      await connection.store.stage(inputBytes, owner.context("seed")),
    );
    value(await connection.store.commit([seed], owner.context("seed")));
    const input = { id: seed.artifact.id, sha256: seed.artifact.sha256 };
    async function run(id: string) {
      const context = owner.context(id);
      const submission: JobSubmission = {
        id: `job-${id}`,
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
        authorityRef: "fixture-approval",
        resourceKeys: ["synthetic-target"],
        deadline: context.deadline,
        budget: { ...DEFAULT_BUDGETS },
      };
      const queued = value(
        await connection.store.jobs.create(submission, context),
      );
      const running = value(
        await connection.store.jobs.claim(
          submission.id,
          { state: "queued", rowVersion: queued.rowVersion },
          "worker",
          30000,
          context,
        ),
      );
      const staged = value(
        await connection.store.jobs.stage(
          submission.id,
          expected(running),
          outputBytes,
          context,
        ),
      );
      return value(
        await connection.store.jobs.commitJob(
          submission.id,
          expected(staged.record),
          {
            outputs: [staged.staged],
            outputState: "complete",
            diagnosticIds: [],
          },
          context,
        ),
      );
    }
    const first = await run("one");
    expect(first.record.job.status).toBe("completed");
    connection.store.close();
    await connection.files.close();
    connection = await open(path, owner);
    expect(
      await connection.files.ensurePublicationDurable(
        artifactRootId,
        first.receipt.outputs,
        owner.context("two"),
      ),
    ).toMatchObject({ status: "unavailable" });
    const second = await run("two");
    expect(second.receipt.outputs).toEqual(first.receipt.outputs);
    expect(second.receipt.idempotency.operation).toBe("render");
    const cancelContext = {
      ...owner.context("one"),
      requestId: "cancel-completed",
    };
    const control = value(
      await connection.store.jobs.cancelWithReceipt(
        "job-one",
        1,
        cancelContext,
      ),
    );
    expect(control.record.job.receipt).toEqual(first.receipt);
    const backup = value(
      await connection.store.backup(owner.context("backup")),
    );
    const destination = await open(
      await root(),
      owner,
      new Set([backup.sha256]),
    );
    value(await destination.store.restore(backup, owner.context("restore")));
    const replay = value(
      await destination.store.jobs.cancelWithReceipt(
        "job-one",
        1,
        cancelContext,
      ),
    );
    expect(replay.control).toEqual(control.control);
    expect(replay.record.job.receipt).toEqual(first.receipt);
    expect(
      value(
        await destination.store.jobs.getJobReceipt(
          "job-one",
          owner.context("one"),
        ),
      ),
    ).toEqual(first.receipt);
    expect(
      value(
        await destination.store.jobs.getJobReceipt(
          "job-two",
          owner.context("two"),
        ),
      ),
    ).toEqual(second.receipt);
    expect(
      value(await destination.store.getReceipt("seed", owner.context("seed"))),
    ).not.toBeNull();
  },
  30000,
);

test.runIf(process.platform === "win32" && process.arch === "x64")(
  "native authority composes conditional cancellation and durable old-precondition replay",
  async () => {
    const owner = issuer();
    const path = await root();
    let connection = await open(path, owner);
    const seed = value(
      await connection.store.stage(inputBytes, owner.context("seed")),
    );
    value(await connection.store.commit([seed], owner.context("seed")));
    const input = { id: seed.artifact.id, sha256: seed.artifact.sha256 };
    const context = owner.context("one");
    const queued = value(
      await connection.store.jobs.create(
        {
          id: "job-one",
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
          authorityRef: "fixture-approval",
          resourceKeys: [],
          deadline: context.deadline,
          budget: { ...DEFAULT_BUDGETS },
        },
        context,
      ),
    );
    const cancelContext = { ...owner.context("one"), requestId: "cancel-key" };
    const accepted = value(
      await connection.store.jobs.cancelWithReceipt(
        queued.job.id,
        queued.rowVersion,
        cancelContext,
      ),
    );
    expect(accepted.record.job.status).toBe("cancelled");
    connection.store.close();
    await connection.files.close();
    connection = await open(path, owner);
    expect(
      value(
        await connection.store.jobs.cancelWithReceipt(
          queued.job.id,
          queued.rowVersion,
          cancelContext,
        ),
      ),
    ).toEqual(accepted);
    expect(
      await connection.store.jobs.cancelWithReceipt(
        queued.job.id,
        accepted.record.rowVersion,
        cancelContext,
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      value(
        await connection.store.jobs.get(queued.job.id, owner.context("one")),
      ).requestId,
    ).toBe("one");
  },
  30000,
);
