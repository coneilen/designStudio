import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { decodeBackup, encodeBackup, LocalStore } from "@design-studio/storage";
import { afterEach, expect, it } from "vitest";

const projectId = "integration_project";
const artifactRootId = "integration_artifacts";
const permissionScope = "integration_owner_v1";
const nativeBinding = fileURLToPath(
  new URL(
    "../.tools/sqlite-prebuild/build/Release/better_sqlite3.node",
    import.meta.url,
  ),
);
const roots: string[] = [];
const connections: Array<{ store: LocalStore; files: ProjectFileSystem }> = [];
const windows = it.runIf(
  process.platform === "win32" && process.arch === "x64",
);

function value<T>(outcome: Outcome<T>): T {
  if (outcome.status !== "complete") {
    throw new Error(
      `Expected complete outcome, received ${outcome.status}: ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.value;
}

function session() {
  const clock = new SystemClock();
  const authenticator = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47111"],
    origins: ["http://127.0.0.1:47111"],
  });
  const grants: AuthorizationContext["grants"] = [
    {
      resourceKind: "artifact",
      resourceId: artifactRootId,
      operations: ["read", "write"],
    },
    ...["first", "second", "backup", "restore", "verify"].map(
      (id): AuthorizationContext["grants"][number] => ({
        resourceKind: "job",
        resourceId: `job-${id}`,
        operations: ["read", "write"],
      }),
    ),
  ];
  const credentials = authenticator.createSession(
    {
      schemaVersion: "1.0",
      projectId,
      actorId: "integration_actor",
      sessionId: "integration_session",
      expiresAt: new Date(clock.now() + 120_000).toISOString(),
      egress: "deny",
      grants,
    },
    "cli",
  );
  const authorization = authenticator.authenticate({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:47111",
    method: "POST",
    bearer: credentials.credential,
  });
  return {
    authenticator,
    context(id: string): OperationContext {
      return {
        schemaVersion: "1.0",
        projectId,
        requestId: id,
        jobId: `job-${id}`,
        deadline: new Date(clock.now() + 30_000).toISOString(),
        authorization,
        budget: { ...DEFAULT_BUDGETS },
        signal: new AbortController().signal,
        clock,
      };
    },
  };
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "studio native integration "));
  roots.push(root);
  return root;
}

async function openStore(
  root: string,
  owner: ReturnType<typeof session>,
  trustedBackups = new Set<string>(),
) {
  if (!roots.includes(root))
    throw new Error("Only test-owned roots are allowed.");
  const artifacts = path.join(root, "artifacts");
  const databaseDirectory = path.join(root, "database");
  const databasePath = path.join(databaseDirectory, "state.sqlite");
  await mkdir(artifacts, { recursive: true });
  await mkdir(databaseDirectory, { recursive: true });
  let store: LocalStore | undefined;
  const files = await ProjectFileSystem.create({
    projectId,
    authority: owner.authenticator.authority,
    publicationProfile: WINDOWS_PUBLICATION_PROFILE,
    roots: [
      {
        id: artifactRootId,
        path: artifacts,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ],
    authorizeRemoval: async (artifact, context) =>
      store?.hasRemovalReservation(artifact, context) ?? false,
  });
  const outsideFixture = async (): Promise<never> => {
    throw new Error("This policy operation is outside this artifact fixture.");
  };
  try {
    store = await LocalStore.open({
      databasePath,
      nativeBinding,
      projectId,
      artifactRootId,
      permissionScope,
      snapshotOperationContext,
      fileSystem: files,
      maintenance: {
        inventory: async (context, maximum) =>
          value(await files.inventory(artifactRootId, context, maximum)),
        removeBlob: async (artifact, context) => {
          value(
            await files.removeUnreferenced(artifactRootId, artifact, context),
          );
        },
      },
      ensurePublicationDurable: async (artifacts, context) => {
        const proof = value(
          await files.ensurePublicationDurable(
            artifactRootId,
            artifacts,
            context,
          ),
        );
        expect(proof).toEqual({
          durable: true,
          profile: WINDOWS_PUBLICATION_PROFILE,
        });
      },
      ensureDatabaseBackupDurable: outsideFixture,
      authorize: async (context, scope) =>
        authorizeOperation(context, scope, owner.authenticator.authority),
      attestLocalDatabase: async (candidate, scope) => {
        expect(candidate).toBe(databasePath);
        expect(await realpath(databaseDirectory)).toBe(databaseDirectory);
        expect(scope).toEqual({ projectId, artifactRootId, permissionScope });
      },
      canonicalBytes,
      verifyRevision: outsideFixture,
      assessApproval: outsideFixture,
      authorizeRestore: async (backup) => {
        if (!trustedBackups.has(backup.sha256))
          throw new Error("Backup was not registered from our trusted source.");
      },
      authorizeRetention: outsideFixture,
      canDiscardStage: async () => false,
    });
  } catch (error) {
    await files.close();
    throw error;
  }
  const connection = { store, files };
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  for (const { store, files } of connections.splice(0).reverse()) {
    await store.close();
    await files.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

windows(
  "commits through real NTFS publication and reuses trusted bytes after restart",
  async () => {
    const owner = session();
    const root = await newRoot();
    const first = await openStore(root, owner);
    const bytes = Uint8Array.of(0, 255, 13, 10, 42);
    const firstContext = owner.context("first");
    const staged = value(await first.store.stage(bytes, firstContext));
    const original = value(await first.store.commit([staged], firstContext));
    await first.store.close();
    await first.files.close();

    const reopened = await openStore(root, owner);
    const nextContext = owner.context("second");
    expect(
      await reopened.files.ensurePublicationDurable(
        artifactRootId,
        [staged.artifact],
        nextContext,
      ),
    ).toMatchObject({ status: "unavailable" });
    const duplicate = value(await reopened.store.stage(bytes, nextContext));
    const reused = value(await reopened.store.commit([duplicate], nextContext));
    expect(reused.id).not.toBe(original.id);
    expect(reused.outputs).toEqual(original.outputs);
    expect(
      value(
        await reopened.store.verify(
          { id: staged.artifact.id, sha256: staged.artifact.sha256 },
          nextContext,
        ),
      ),
    ).toEqual(staged.artifact);
  },
  30_000,
);

windows(
  "restores an authorized backup only after real destination publication",
  async () => {
    const owner = session();
    const source = await openStore(await newRoot(), owner);
    const context = owner.context("first");
    const staged = value(
      await source.store.stage(
        canonicalBytes({ fixture: "native restore" }),
        context,
      ),
    );
    const receipt = value(await source.store.commit([staged], context));
    const backup = value(await source.store.backup(owner.context("backup")));
    const authorized = new Set([backup.sha256]);
    const decoded = decodeBackup(encodeBackup(backup, 26_214_400), 26_214_400);
    const destination = await openStore(await newRoot(), owner, authorized);
    expect(
      value(await destination.store.restore(decoded, owner.context("restore"))),
    ).toEqual({ restored: true });
    expect(
      value(
        await destination.store.verify(
          { id: staged.artifact.id, sha256: staged.artifact.sha256 },
          owner.context("verify"),
        ),
      ),
    ).toEqual(staged.artifact);
    expect(
      value(
        await destination.store.getReceipt("first", owner.context("verify")),
      ),
    ).toEqual(receipt);
  },
  30_000,
);
