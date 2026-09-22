import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AuthorizationContext,
  type Clock,
  DEFAULT_BUDGETS,
  type OperationContext,
  type Outcome,
} from "@design-studio/contracts";
import { createFakeClock } from "@design-studio/contracts/testing";
import { canonicalBytes } from "@design-studio/design-ir";
import {
  authorizeOperation,
  HostBoundaryError,
  LocalSessionAuthenticator,
  ProjectFileSystem,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import {
  type JobReconciliation,
  type JobSubmission,
  LocalStore,
  type StorageOptions,
  type StoredJob,
} from "@design-studio/storage";
import { afterEach } from "vitest";
import { diskFixture } from "../../storage/tests/support.js";
import { createJobService } from "../src/index.js";
import type {
  ExecutionAuthority,
  JobServiceOptions,
  RecoveryAuthority,
  RecoveryFacts,
  TrustedJobHandler,
} from "../src/types.js";

export const output = Uint8Array.of(1, 3, 7);
const inputBytes = Uint8Array.of(4, 8, 12);
export function value<T>(result: Outcome<T>): T {
  if (result.status !== "complete") throw new Error(JSON.stringify(result));
  return result.value;
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
export function ownCleanup(close: () => Promise<void>) {
  cleanup.push(close);
}
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

export async function fixture(
  options: {
    native?: boolean;
    workers?: number;
    clock?: Clock;
    seed?: boolean;
  } = {},
) {
  const clock =
    options.clock ?? createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const root = await mkdtemp(join(tmpdir(), "jobs service synthetic "));
  let store: LocalStore | undefined;
  let host: ProjectFileSystem | undefined;
  ownCleanup(async () => {
    store?.close();
    if (host) await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifactRootId = "artifacts";
  const actors = new Set(["actor", "supervisor"]);
  const jobs = new Set([
    "job-seed",
    "job-work",
    "job-other",
    "job-third",
    "job-fourth",
    "job-fifth",
    "job-backup",
    "job-restore",
  ]);
  const artifactId = (bytes: Uint8Array) =>
    `${options.native ? "sha256_" : "blob-"}${createHash("sha256").update(bytes).digest("hex")}`;
  const artifacts = new Set([
    artifactRootId,
    artifactId(inputBytes),
    artifactId(output),
  ]);
  const trustedBackups = new Set<string>();
  const authenticator = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47115"],
    origins: ["http://127.0.0.1:47115"],
  });
  let sessionNumber = 0;
  function context(
    id = "work",
    signal = new AbortController().signal,
    actor = "actor",
  ): OperationContext {
    if (!actors.has(actor))
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Unknown/revoked fixture actor.",
      );
    const grants: AuthorizationContext["grants"] = [
      ...Array.from(artifacts, (resourceId) => ({
        resourceKind: "artifact" as const,
        resourceId,
        operations: ["read", "write"] as ["read", "write"],
      })),
      ...Array.from(jobs, (resourceId) => ({
        resourceKind: "job" as const,
        resourceId,
        operations: ["read", "write"] as ["read", "write"],
      })),
    ];
    const credentials = authenticator.createSession(
      {
        schemaVersion: "1.0",
        projectId: "project",
        actorId: actor,
        sessionId: `session-${++sessionNumber}`,
        expiresAt: new Date(clock.now() + 60000).toISOString(),
        grants,
        egress: "deny",
      },
      "cli",
    );
    return {
      schemaVersion: "1.0",
      projectId: "project",
      requestId: id,
      jobId: `job-${id}`,
      deadline: new Date(clock.now() + 30000).toISOString(),
      budget: { ...DEFAULT_BUDGETS },
      authorization: authenticator.authenticate({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:47115",
        method: "POST",
        bearer: credentials.credential,
      }),
      clock,
      signal,
    };
  }
  const verify = (auth: AuthorizationContext) =>
    actors.has(auth.actorId) && authenticator.authority(auth);
  const recoveryEvidence = new WeakSet<JobReconciliation>();
  const evidenceIds = new Set<string>();
  let recovered = 0;
  const recoveryAuthority: RecoveryAuthority = {
    async issue(record, signal) {
      // A current owner policy may reconcile a revoked execution without reviving it.
      const ctx = context("recovery", signal, "supervisor");
      return { ...ctx, jobId: record.job.id };
    },
    async decide(record, facts, _ctx) {
      const evidence: JobReconciliation = facts.stopConfirmed
        ? {
            kind: "resolved",
            decision:
              facts.reason === "cancel"
                ? "cancelled"
                : facts.reason === "authority"
                  ? "waiting-for-user"
                  : "failed",
            evidenceRef: `recovery-${++recovered}`,
            stoppedLeaseId: record.job.lease?.id ?? null,
            effects: [],
            abandonedStageIds: [],
            error: facts.error,
          }
        : { kind: "interrupt", error: facts.error };
      recoveryEvidence.add(evidence);
      if (evidence.kind === "resolved") evidenceIds.add(evidence.evidenceRef);
      return evidence;
    },
  };
  const executionAuthority: ExecutionAuthority = {
    verify,
    async observe(signal) {
      return context("observer", signal, "supervisor");
    },
    async issue(record, signal) {
      if (record.authorityRef !== "policy" || !jobs.has(record.job.id))
        throw new HostBoundaryError("FORBIDDEN", "Unknown fixture policy.");
      const ctx = context(record.requestId, signal, record.job.actorId);
      return {
        ...ctx,
        jobId: record.job.id,
        deadline: record.job.deadline,
        budget: { ...record.job.budget },
      };
    },
  };
  const disk = options.native ? undefined : await diskFixture(root);
  const artifactPath = join(root, "native-artifacts");
  if (options.native) {
    await mkdir(artifactPath);
    host = await ProjectFileSystem.create({
      projectId: "project",
      authority: verify,
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
  }
  const fs = host ?? disk?.fs;
  if (!fs) throw new Error("Fixture filesystem missing.");
  let fault: StorageOptions["fault"];
  const outside = async (): Promise<never> => {
    throw new Error("Outside explicitly owned fixture policy.");
  };
  const settings: StorageOptions = {
    databasePath: join(root, "state.sqlite"),
    nativeBinding: resolve(
      ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
    ),
    projectId: "project",
    artifactRootId,
    permissionScope: "private-fixture",
    snapshotOperationContext,
    fileSystem: fs,
    maintenance: {
      inventory: async (ctx, limit) =>
        host
          ? value(await host.inventory(artifactRootId, ctx, limit))
          : disk
            ? disk.maintenance.inventory()
            : outside(),
      removeBlob: outside,
    },
    ensurePublicationDurable: async (artifacts, ctx) => {
      if (host)
        value(
          await host.ensurePublicationDurable(artifactRootId, artifacts, ctx),
        );
      // diskFixture acknowledges only a synthetic test boundary, never native durability.
    },
    ensureDatabaseBackupDurable: outside,
    authorize: async (ctx, scope) => authorizeOperation(ctx, scope, verify),
    attestLocalDatabase: async (path) => {
      if (
        path !== join(root, "state.sqlite") ||
        (await realpath(root)) !== root
      )
        throw new Error("Unowned fixture.");
    },
    canonicalBytes,
    verifyRevision: outside,
    assessApproval: outside,
    authorizeRestore: async (backup) => {
      if (!trustedBackups.has(backup.sha256))
        throw new Error(
          "Backup not registered from the owned trusted source fixture.",
        );
    },
    authorizeRetention: outside,
    canDiscardStage: async () => false,
    jobs: {
      clock,
      maxWorkers: options.workers ?? 1,
      verifyCompletion: async (_record, completion, evidence) => {
        if (
          completion.outputs.length !== evidence.length ||
          evidence.some((e) => !Buffer.from(e.bytes).equals(output))
        )
          throw new Error("Synthetic output schema invalid.");
      },
      authorizeRecovery: async (_record, evidence) => {
        if (evidence.kind === "interrupt") return;
        if (!evidenceIds.has(evidence.evidenceRef))
          throw new Error("Unknown recovery decision.");
      },
    },
    fault: (point) => fault?.(point),
  };
  store = await LocalStore.open(settings);
  const input = {
    id: artifactId(inputBytes),
    sha256: createHash("sha256").update(inputBytes).digest("hex"),
  };
  if (options.seed !== false) {
    const seedCtx = context("seed");
    const inputStage = value(await store.stage(inputBytes, seedCtx));
    value(await store.commit([inputStage], seedCtx));
  }
  return {
    clock,
    root,
    context,
    actors,
    ownCleanup,
    authenticator,
    executionAuthority,
    recoveryAuthority,
    artifactRootId,
    trustBackup(sha256: string) {
      trustedBackups.add(sha256);
    },
    get store() {
      if (!store) throw new Error("Fixture store was not initialized");
      return store;
    },
    setFault(callback: StorageOptions["fault"]) {
      fault = callback;
    },
    async reopen() {
      if (!store) throw new Error("Fixture store was not initialized");
      store.close();
      store = await LocalStore.open(settings);
    },
    submission(id = "work", keys: string[] = []): JobSubmission {
      return {
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
        authorityRef: "policy",
        resourceKeys: keys,
        deadline: context(id).deadline,
        budget: { ...DEFAULT_BUDGETS },
      };
    },
    async evidence(record: StoredJob, facts: RecoveryFacts) {
      return recoveryAuthority.decide(record, facts, context("recovery"));
    },
  };
}

export function makeService(
  f: Awaited<ReturnType<typeof fixture>>,
  run: TrustedJobHandler["run"],
  overrides: Partial<JobServiceOptions> = {},
) {
  return createJobService({
    projectId: "project",
    repository: f.store.jobs,
    clock: f.clock,
    artifactRootId: f.artifactRootId,
    ownerId: "worker",
    handlers: [{ id: "synthetic", version: "v1", operation: "render", run }],
    executionAuthority: f.executionAuthority,
    recoveryAuthority: f.recoveryAuthority,
    leaseMs: 1000,
    heartbeatMs: 300,
    pollMs: 50,
    ...overrides,
  });
}
