import {
  DEFAULT_BUDGETS,
  type Job,
  type OperationContext,
} from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import type { StoredJob } from "@design-studio/storage";
import { expect, it } from "vitest";
import { OutputCapabilities } from "../src/output-capabilities.js";

function fixture() {
  const clock = new SystemClock();
  const sessions = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47119"],
    origins: [],
  });
  const expiresAt = new Date(clock.now() + 30000).toISOString();
  const issued = sessions.createSession(
    {
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      actorId: "owner",
      sessionId: "session",
      expiresAt,
      egress: "deny",
      grants: [
        {
          resourceKind: "artifact",
          resourceId: "foundation_artifacts",
          operations: ["read", "write"],
        },
      ],
    },
    "cli",
  );
  const context: OperationContext = {
    schemaVersion: "1.0",
    projectId: "project_synthetic",
    jobId: "job_1",
    requestId: "request",
    authorization: sessions.authenticate({
      host: "127.0.0.1:47119",
      remoteAddress: "127.0.0.1",
      method: "POST",
      bearer: issued.credential,
    }),
    budget: { ...DEFAULT_BUDGETS },
    deadline: expiresAt,
    clock,
    signal: new AbortController().signal,
  };
  const input = { id: "input", sha256: "a".repeat(64) };
  const resources = {
    snapshotId: "resources",
    sha256: "b".repeat(64),
    componentRegistryRevision: "1",
    tokenRegistryRevision: "1",
    selectedModes: {},
  };
  const job: Job = {
    schemaVersion: "1.0",
    id: "job_1",
    projectId: "project_synthetic",
    actorId: "owner",
    operation: "render",
    status: "running",
    input,
    resources,
    idempotency: {
      key: "request",
      actorId: "owner",
      projectId: "project_synthetic",
      operation: "render",
      payloadSha256: "c".repeat(64),
    },
    attempt: 1,
    deadline: expiresAt,
    budget: { ...DEFAULT_BUDGETS },
    progress: 0,
    diagnosticIds: [],
    lease: {
      id: "lease",
      ownerId: "worker",
      resourceId: "job_1",
      fencingToken: 1,
      heartbeatAt: new Date(clock.now()).toISOString(),
      expiresAt,
    },
  };
  const record: StoredJob = {
    job,
    requestId: "request",
    handlerId: "fixture-render-strict",
    handlerVersion: "1.0.0",
    authorityRef: "policy",
    resourceKeys: [],
    rowVersion: 2,
    generation: 1,
    resources: [],
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    progressSequence: 0,
    lastProgressAt: null,
    effects: [],
    usage: {
      inputBytes: 0,
      outputBytes: 0,
      externalCalls: 0,
      modelTokens: 0,
      costMicros: 0,
    },
    submission: {
      id: job.id,
      operation: "render",
      input,
      resources,
      handlerId: "fixture-render-strict",
      handlerVersion: "1.0.0",
      authorityRef: "policy",
      resourceKeys: [],
      deadline: expiresAt,
      budget: { ...DEFAULT_BUDGETS },
    },
  };
  const execution: JobExecution = {
    context,
    record,
    async checkpoint() {},
    async progress() {},
    async reserve() {},
    async settle() {},
    async stage() {
      throw new Error("Use the journaled filesystem adapter.");
    },
    filesystem: {
      async stage(request, bytes) {
        return {
          schemaVersion: "1.0",
          projectId: context.projectId,
          requestId: context.requestId,
          status: "complete",
          value: {
            stagingId: "confirmed_stage",
            artifact: {
              id: `sha256_${hashBytes(bytes)}`,
              sha256: hashBytes(bytes),
              path: request.path,
              mediaType: "application/octet-stream",
              byteLength: bytes.length,
            },
          },
          diagnosticIds: [],
        };
      },
    },
  };
  return {
    context,
    record,
    execution,
    sessions,
    caps: new OutputCapabilities("foundation_artifacts", sessions.authority),
  };
}
it("invalidates already-returned adapters after settlement or shutdown", async () => {
  for (const release of ["drop", "clear"] as const) {
    const f = fixture();
    const adapter = f.caps.wrap(f.execution);
    if (release === "drop") f.caps.dropJob("job_1");
    else f.caps.clear();
    const bytes = Uint8Array.of(9);
    await expect(
      adapter.stage(
        {
          artifactRootId: "foundation_artifacts",
          path: `blobs/${hashBytes(bytes)}`,
        },
        bytes,
        f.context,
      ),
    ).rejects.toThrow();
  }
});
it("bounds stage attempts independently of repeated content and denies a mismatched persisted project", async () => {
  const f = fixture();
  const bytes = Uint8Array.of(9);
  const adapter = f.caps.wrap(f.execution);
  const request = {
    artifactRootId: "foundation_artifacts",
    path: `blobs/${hashBytes(bytes)}`,
  };
  for (let index = 0; index < 6; index++)
    await adapter.stage(request, bytes, f.context);
  await expect(adapter.stage(request, bytes, f.context)).rejects.toThrow();
  f.record.job.projectId = "other_project";
  expect(
    f.caps.authorize(f.context, {
      projectId: "project_synthetic",
      resourceKind: "artifact",
      resourceId: `sha256_${hashBytes(bytes)}`,
      operation: "write",
    }),
  ).toBe(false);
});
it.each(["lease", "deadline", "cancel", "owner"] as const)(
  "denies current outputs after %s changes",
  async (change) => {
    const f = fixture();
    const bytes = Uint8Array.of(8);
    await f.caps.wrap(f.execution).stage(
      {
        artifactRootId: "foundation_artifacts",
        path: `blobs/${hashBytes(bytes)}`,
      },
      bytes,
      f.context,
    );
    if (!f.record.job.lease) throw new Error("Test lease missing.");
    if (change === "lease")
      f.record.job.lease.expiresAt = new Date(0).toISOString();
    if (change === "deadline")
      f.record.job.deadline = new Date(0).toISOString();
    if (change === "owner") f.record.job.lease.ownerId = "different_worker";
    if (change === "cancel") f.record.job.status = "cancel-requested";
    expect(
      f.caps.authorize(f.context, {
        projectId: "project_synthetic",
        resourceKind: "artifact",
        resourceId: `sha256_${hashBytes(bytes)}`,
        operation: "write",
      }),
    ).toBe(false);
  },
);
it("does not carry output authority across changed resource reservation generations", async () => {
  const f = fixture();
  f.record.resources = [{ key: "fixture-renderer", generation: 1 }];
  const bytes = Uint8Array.of(7);
  await f.caps.wrap(f.execution).stage(
    {
      artifactRootId: "foundation_artifacts",
      path: `blobs/${hashBytes(bytes)}`,
    },
    bytes,
    f.context,
  );
  f.record.resources = [{ key: "fixture-renderer", generation: 2 }];
  expect(
    f.caps.authorize(f.context, {
      projectId: "project_synthetic",
      resourceKind: "artifact",
      resourceId: `sha256_${hashBytes(bytes)}`,
      operation: "write",
    }),
  ).toBe(false);
});
it("authorizes only actual successful journaled output writes under the original live proof", async () => {
  const f = fixture();
  const bytes = Uint8Array.of(1, 2);
  const scope = {
    projectId: "project_synthetic",
    resourceKind: "artifact" as const,
    resourceId: `sha256_${hashBytes(bytes)}`,
    operation: "write" as const,
  };
  expect(f.caps.authorize(f.context, scope)).toBe(false);
  await f.caps.wrap(f.execution).stage(
    {
      artifactRootId: "foundation_artifacts",
      path: `blobs/${hashBytes(bytes)}`,
    },
    bytes,
    f.context,
  );
  expect(f.caps.authorize(f.context, scope)).toBe(true);
  expect(
    f.caps.authorize(
      { ...f.context, authorization: structuredClone(f.context.authorization) },
      scope,
    ),
  ).toBe(false);
  expect(f.caps.authorize({ ...f.context, jobId: "another" }, scope)).toBe(
    false,
  );
  expect(f.caps.authorize({ ...f.context, requestId: "another" }, scope)).toBe(
    false,
  );
  expect(f.caps.authorize(f.context, { ...scope, operation: "read" })).toBe(
    false,
  );
  expect(
    f.caps.authorize(f.context, { ...scope, resourceId: "unrelated" }),
  ).toBe(false);
  f.record.generation = 2;
  expect(f.caps.authorize(f.context, scope)).toBe(false);
});
it("refuses wrong root/path, revoked proofs and partial stage promotion", async () => {
  const f = fixture();
  const bytes = Uint8Array.of(1, 2);
  await expect(
    f.caps
      .wrap(f.execution)
      .stage(
        { artifactRootId: "other", path: `blobs/${hashBytes(bytes)}` },
        bytes,
        f.context,
      ),
  ).rejects.toThrow();
  await expect(
    f.caps
      .wrap(f.execution)
      .stage(
        { artifactRootId: "foundation_artifacts", path: "wrong.bin" },
        bytes,
        f.context,
      ),
  ).rejects.toThrow();
  f.sessions.revoke(f.context.authorization);
  expect(() => f.caps.wrap(f.execution)).toThrow();
});
it("never promotes a partial stage or a successful callback followed by revocation", async () => {
  const f = fixture();
  const bytes = Uint8Array.of(3, 4);
  const source = f.execution.filesystem.stage.bind(f.execution.filesystem);
  f.execution.filesystem.stage = async (request, input, context) => {
    const result = await source(request, input, context);
    if (result.status !== "complete")
      throw new Error("Owned test expected complete source.");
    return {
      ...result,
      status: "partial",
      missing: ["journal-confirmation"],
      error: {
        code: "OUTPUT_UNCERTAIN",
        message: "Owned partial test.",
        retryable: false,
        diagnosticIds: [],
      },
    };
  };
  const request = {
    artifactRootId: "foundation_artifacts",
    path: `blobs/${hashBytes(bytes)}`,
  };
  const result = await f.caps
    .wrap(f.execution)
    .stage(request, bytes, f.context);
  expect(result.status).toBe("partial");
  const scope = {
    projectId: "project_synthetic",
    resourceKind: "artifact" as const,
    resourceId: `sha256_${hashBytes(bytes)}`,
    operation: "write" as const,
  };
  expect(f.caps.authorize(f.context, scope)).toBe(false);
  const g = fixture();
  const successful = g.execution.filesystem.stage.bind(g.execution.filesystem);
  g.execution.filesystem.stage = async (...args) => {
    const staged = await successful(...args);
    g.sessions.revoke(g.context.authorization);
    return staged;
  };
  await expect(
    g.caps.wrap(g.execution).stage(request, bytes, g.context),
  ).rejects.toThrow();
  expect(g.caps.authorize(g.context, scope)).toBe(false);
});
it.each(["sha256", "path"] as const)(
  "rejects forged physical %s and drops settled capabilities",
  async (field) => {
    const f = fixture();
    const bytes = Uint8Array.of(5, 6);
    const source = f.execution.filesystem.stage.bind(f.execution.filesystem);
    f.execution.filesystem.stage = async (...args) => {
      const result = await source(...args);
      if (result.status !== "complete")
        throw new Error("Owned test source failed.");
      result.value.artifact[field] =
        field === "sha256" ? "a".repeat(64) : "wrong.bin";
      return result;
    };
    await expect(
      f.caps.wrap(f.execution).stage(
        {
          artifactRootId: "foundation_artifacts",
          path: `blobs/${hashBytes(bytes)}`,
        },
        bytes,
        f.context,
      ),
    ).rejects.toThrow();
    const g = fixture();
    await g.caps.wrap(g.execution).stage(
      {
        artifactRootId: "foundation_artifacts",
        path: `blobs/${hashBytes(bytes)}`,
      },
      bytes,
      g.context,
    );
    g.caps.dropJob("job_1");
    expect(
      g.caps.authorize(g.context, {
        projectId: "project_synthetic",
        resourceKind: "artifact",
        resourceId: `sha256_${hashBytes(bytes)}`,
        operation: "write",
      }),
    ).toBe(false);
  },
);
