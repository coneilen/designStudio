import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AuthorizationContext,
  OperationContext,
  Outcome,
  ResourceSnapshot,
} from "@design-studio/contracts";
import { createFakeClock } from "@design-studio/contracts/testing";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  authorizeOperation,
  LocalSessionAuthenticator,
  Redactor,
  ScopedCredentialStore,
  snapshotOperationContext,
} from "@design-studio/host";
import { createJobService, type JobService } from "@design-studio/jobs";
import { LocalStore, type StorageOptions } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import { diskFixture } from "../../storage/tests/support.js";
import { CAPTURE_LIMITS, ownPolicy } from "../src/boundary.js";
import { createFigmaCaptureJobs } from "../src/service.js";
import { CaptureHttpError, FigmaHttpsTransport } from "../src/transport.js";
import { PAT } from "./support.js";

const value = <T>(outcome: Outcome<T>): T => {
  if (outcome.status !== "complete")
    throw new Error("Synthetic persistence operation failed");
  return outcome.value;
};
it.skipIf(process.platform !== "win32")(
  "commits immutable rate-limit evidence through real jobs/SQLite and enforces cooldown after restart",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ds-capture-store-"));
    const originalRoot = await realpath(root);
    const disk = await diskFixture(root);
    const clock = createFakeClock(Date.now());
    const sessions = new LocalSessionAuthenticator({
      clock,
      hosts: ["127.0.0.1:1235"],
      origins: [],
    });
    const policy = ownPolicy({
      id: "policy_one",
      projectId: "capture_project",
      sourceId: "source_one",
      artifactRootId: "artifacts",
      fileKey: "SyntheticFile",
      nodeId: "1:2",
      imageOrigins: [],
      credential: {
        id: "credential_one",
        providerId: "figma_rest",
        store: "windows-credential-manager",
      },
    });
    const ids = ["capture_one", "capture_two", "seed", "observer"];
    let serial = 0;
    const context = (
      jobId: string,
      requestId = jobId,
      signal = new AbortController().signal,
    ): OperationContext => {
      const grants: AuthorizationContext["grants"] = [
        {
          resourceKind: "source",
          resourceId: policy.sourceId,
          operations: ["capture"],
        },
        {
          resourceKind: "provider",
          resourceId: "figma_rest",
          operations: ["read"],
        },
        {
          resourceKind: "credential",
          resourceId: policy.credential.id,
          operations: ["credential-use"],
        },
        {
          resourceKind: "artifact",
          resourceId: policy.artifactRootId,
          operations: ["read", "write"],
        },
        ...ids.map((resourceId) => ({
          resourceKind: "job" as const,
          resourceId,
          operations: ["read", "write"] as ["read", "write"],
        })),
      ];
      const token = sessions.createSession(
        {
          schemaVersion: "1.0",
          projectId: policy.projectId,
          actorId: "capture_actor",
          sessionId: `capture_session_${++serial}`,
          expiresAt: new Date(clock.now() + 60000).toISOString(),
          grants,
          egress: "explicit-grant-required",
        },
        "cli",
      );
      return {
        schemaVersion: "1.0",
        projectId: policy.projectId,
        requestId,
        jobId,
        deadline: new Date(clock.now() + 30000).toISOString(),
        budget: { ...CAPTURE_LIMITS },
        clock,
        signal,
        authorization: sessions.authenticate({
          remoteAddress: "127.0.0.1",
          host: "127.0.0.1:1235",
          method: "POST",
          bearer: token.credential,
        }),
      };
    };
    const credentials = new ScopedCredentialStore({
      projectId: policy.projectId,
      authority: sessions.authority,
      references: [policy.credential],
      redactor: new Redactor(),
      budgetLimits: CAPTURE_LIMITS,
      backend: {
        store: "windows-credential-manager",
        capability: "native-binding",
        read: async () => Buffer.from(PAT),
      },
    });
    let api: ReturnType<typeof createFigmaCaptureJobs> | undefined;
    const outside = async (): Promise<never> => {
      throw new Error("Outside synthetic capture fixture");
    };
    const settings: StorageOptions = {
      databasePath: path.join(root, "capture.sqlite"),
      nativeBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      projectId: policy.projectId,
      artifactRootId: policy.artifactRootId,
      permissionScope: "synthetic-private-capture",
      snapshotOperationContext,
      fileSystem: disk.fs,
      maintenance: {
        inventory: async () => disk.maintenance.inventory(),
        removeBlob: outside,
      },
      ensurePublicationDurable: async () => {},
      ensureDatabaseBackupDurable: outside,
      authorize: async (ctx, scope) =>
        authorizeOperation(
          ctx,
          scope.resourceKind === "artifact"
            ? { ...scope, resourceId: policy.artifactRootId }
            : scope,
          sessions.authority,
        ),
      attestLocalDatabase: async (filename) => {
        if (
          filename !== path.join(root, "capture.sqlite") ||
          (await realpath(root)) !== originalRoot
        )
          throw new Error("Foreign test root");
      },
      canonicalBytes,
      verifyRevision: outside,
      assessApproval: outside,
      authorizeRestore: outside,
      authorizeRetention: outside,
      canDiscardStage: async () => false,
      jobs: {
        clock,
        limits: CAPTURE_LIMITS,
        discovery: {
          authorizeOwner: async (ctx) => {
            if (!sessions.authority(ctx.authorization))
              throw new Error("Untrusted synthetic owner");
          },
        },
        verifyCompletion: async (...args) => {
          if (!api) throw new Error("No capture completion policy");
          await api.verifyCompletion(...args);
        },
        authorizeRecovery: outside,
      },
    };
    let store: LocalStore | undefined;
    let service: JobService | undefined;
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new CaptureHttpError("RATE_LIMITED", 429, "60"));
    const errors: unknown[] = [];
    const cleanupRoot = async () => {
      if ((await realpath(root)) !== originalRoot)
        throw new Error("Synthetic capture root changed");
      await rm(root, { recursive: true });
    };
    try {
      store = await LocalStore.open(settings);
      const compose = () => {
        if (!store) throw new Error("No synthetic store");
        const opened = store;
        api = createFigmaCaptureJobs({
          policy,
          authority: sessions.authority,
          credentials,
          repository: opened.jobs,
          readArtifact: async (reference, ctx, maximum) => {
            const artifact = value(await opened.verify(reference, ctx));
            if (artifact.byteLength > maximum)
              throw new Error("Synthetic read bound");
            return {
              artifact,
              bytes: value(
                await disk.fs.read(
                  {
                    artifactRootId: policy.artifactRootId,
                    path: artifact.path,
                  },
                  ctx,
                ),
              ),
            };
          },
        });
        return createJobService({
          projectId: policy.projectId,
          repository: opened.jobs,
          clock,
          artifactRootId: policy.artifactRootId,
          ownerId: "capture_worker",
          handlers: api.handlers,
          executionAuthority: {
            verify: sessions.authority,
            observe: async (signal) => context("observer", "observe", signal),
            issue: async (record, signal) => ({
              ...context(record.job.id, record.requestId, signal),
              deadline: record.job.deadline,
              budget: record.job.budget,
            }),
          },
          recoveryAuthority: {
            issue: async (record, signal) =>
              context(record.job.id, "recovery", signal),
            decide: outside,
          },
        });
      };
      service = compose();
      const resources: ResourceSnapshot = {
        schemaVersion: "1.0",
        id: "capture_resources",
        projectId: policy.projectId,
        components: {
          schemaVersion: "1.0",
          projectId: policy.projectId,
          revision: "none",
          definitions: [],
          mappings: [],
        },
        tokens: {
          schemaVersion: "1.0",
          projectId: policy.projectId,
          revision: "none",
          collections: [],
          selectedModes: {},
          definitions: [],
          resolved: [],
          adapters: [],
        },
        assets: [],
        fonts: [],
      };
      const makeRequest = (captureId: string) => ({
        schemaVersion: "1.0",
        captureId,
        projectId: policy.projectId,
        policyId: policy.id,
        policySha256: canonicalDigest(policy),
        selectionUrl:
          "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
        credential: policy.credential,
      });
      const seed = context("seed");
      const resource = value(
        await store.stage(canonicalBytes(resources), seed),
      );
      const input = value(
        await store.stage(canonicalBytes(makeRequest("capture_one")), seed),
      );
      value(await store.commit([resource, input], seed));
      const lock = {
        snapshotId: resource.artifact.id,
        sha256: resource.artifact.sha256,
        componentRegistryRevision: "none",
        tokenRegistryRevision: "none",
        selectedModes: {},
      };
      if (!api) throw new Error("No capture policy");
      const submit = context("capture_one");
      value(
        await api.submit(
          service,
          makeRequest("capture_one"),
          input.artifact,
          lock,
          "capture_authority",
          submit,
        ),
      );
      value(await service.runOnce());
      const done = value(
        await service.waitForAttempt("capture_one", context("capture_one")),
      );
      expect(done.status).toBe("completed");
      expect(done.outputState).toBe("partial-inspection");
      expect(
        await api.readResult("capture_one", context("capture_one")),
      ).toMatchObject({
        errorCode: "RATE_LIMITED",
        completeness: "unavailable",
      });
      value(await service.stop());
      service = undefined;
      store.close();
      store = await LocalStore.open(settings);
      service = compose();
      const next = value(
        await store.stage(
          canonicalBytes(makeRequest("capture_two")),
          context("seed", "next-input"),
        ),
      );
      value(await store.commit([next], context("seed", "next-input-commit")));
      if (!api) throw new Error("No restarted policy");
      await expect(
        api.submit(
          service,
          makeRequest("capture_two"),
          next.artifact,
          lock,
          "capture_authority",
          context("capture_two"),
        ),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(network).toHaveBeenCalledTimes(1);
      clock.advance(60001);
      network.mockImplementation(
        async (operation, _version, _secret, budget) => {
          if (operation !== "metadata")
            throw new CaptureHttpError("PROVIDER_UNAVAILABLE");
          const bytes = Buffer.from('{"file":{"version":"synthetic_version"}}');
          budget.dnsQuery();
          budget.receive(bytes.length);
          budget.decoded(bytes.length);
          return { status: 200, bytes, mediaType: "application/json" };
        },
      );
      value(
        await api.submit(
          service,
          makeRequest("capture_two"),
          next.artifact,
          lock,
          "capture_authority",
          context("capture_two"),
        ),
      );
      value(await service.runOnce());
      const interrupted = value(
        await service.waitForAttempt("capture_two", context("capture_two")),
      );
      expect(interrupted.status).toBe("interrupted");
      const effects = value(
        await store.jobs.get("capture_two", context("capture_two")),
      );
      expect(effects.effects.some((effect) => effect.state === "unknown")).toBe(
        true,
      );
      const retained = value(
        await store.jobs.getStages("capture_two", context("capture_two")),
      );
      expect(retained).toHaveLength(1);
      const recovered = value(
        await store.recover(context("seed", "recover-stages")),
      );
      expect(recovered.stagedRetained).toContain(retained[0]?.stagingId);
      expect(
        await api.readResult("capture_two", context("capture_two")),
      ).toBeUndefined();
      expect(network).toHaveBeenCalledTimes(3);
      value(await service.stop());
      service = undefined;
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (service) value(await service.stop());
      } catch (error) {
        errors.push(error);
      }
      try {
        store?.close();
      } catch (error) {
        errors.push(error);
      }
      network.mockRestore();
      try {
        await cleanupRoot();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Capture persistence operation/cleanup failed.",
      );
  },
  20_000,
);
