import { readFile } from "node:fs/promises";
import type {
  Artifact,
  OperationContext,
  RenderResult,
} from "@design-studio/contracts";
import { DEFAULT_BUDGETS, parseContract } from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import { renderStaged, type StagedRender } from "@design-studio/renderer";
import type { StoredJob } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import { createRenderJobs } from "../src/render-jobs.js";

vi.mock("@design-studio/renderer", async (original) => ({
  ...(await original<typeof import("@design-studio/renderer")>()),
  renderStaged: vi.fn(),
}));
async function fixture() {
  const raw = parseContract(
    "JsonValue",
    await readFile(
      "tests\\fixtures\\foundation\\contract-examples.json",
      "utf8",
    ),
    "json",
  );
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Array.isArray(raw.artifacts)
  )
    throw new Error("Missing examples.");
  const entries = raw.artifacts;
  const example = (name: string) => {
    const entry = entries.find(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.contract === name,
    );
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Missing example.");
    return JSON.stringify(entry.value);
  };
  const job = parseContract("Job", example("Job"), "json");
  const clock = new SystemClock();
  const controller = new AbortController();
  const sessions = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47119"],
    origins: [],
  });
  const credential = sessions.createSession(
    {
      schemaVersion: "1.0",
      projectId: job.projectId,
      actorId: job.actorId,
      sessionId: "completion_session",
      expiresAt: new Date(clock.now() + 30000).toISOString(),
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
    projectId: job.projectId,
    requestId: "original",
    jobId: job.id,
    authorization: sessions.authenticate({
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:47119",
      method: "POST",
      bearer: credential.credential,
    }),
    clock,
    signal: controller.signal,
    deadline: new Date(clock.now() + 30000).toISOString(),
    budget: { ...DEFAULT_BUDGETS },
  };
  job.deadline = context.deadline;
  job.status = "running";
  job.attempt = 1;
  job.lease = {
    id: "lease",
    ownerId: "owner",
    resourceId: job.id,
    fencingToken: 1,
    heartbeatAt: new Date(clock.now()).toISOString(),
    expiresAt: context.deadline,
  };
  const record: StoredJob = {
    job,
    requestId: context.requestId,
    generation: 1,
    rowVersion: 2,
    resources: [],
    resourceKeys: [],
    handlerId: "fixture-render-strict",
    handlerVersion: "1.0.0",
    authorityRef: "policy",
    createdAt: context.deadline,
    updatedAt: context.deadline,
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
      input: job.input,
      resources: job.resources,
      handlerId: "fixture-render-strict",
      handlerVersion: "1.0.0",
      authorityRef: "policy",
      resourceKeys: [],
      deadline: job.deadline,
      budget: job.budget,
    },
  };
  const bytes = Array.from({ length: 6 }, (_, index) => Uint8Array.of(index));
  const outputs = bytes.map((value, index) => ({
    stagingId: `stage_${index}`,
    artifact: {
      id: `sha256_${hashBytes(value)}`,
      sha256: hashBytes(value),
      byteLength: value.length,
      mediaType: "application/octet-stream",
      path: `blobs/${hashBytes(value)}`,
    } satisfies Artifact,
  }));
  const preview = outputs[0]?.artifact;
  if (!preview) throw new Error("Missing preview.");
  const result: RenderResult = {
    renderId: "render_owned",
    preview,
    boundsMap: parseContract("BoundsMap", example("BoundsMap"), "json"),
    profile: parseContract("RenderProfile", example("RenderProfile"), "json"),
    diagnostics: parseContract(
      "DiagnosticReport",
      await readFile(
        "tests\\fixtures\\foundation\\settings-screen.diagnostics.json",
        "utf8",
      ),
      "json",
    ),
  };
  const prepared: StagedRender = {
    outcome: {
      schemaVersion: "1.0",
      projectId: job.projectId,
      requestId: context.requestId,
      status: "complete",
      value: result,
      diagnosticIds: [],
    },
    staged: outputs,
    recoveryRequired: false,
    evidence: {
      version: 1,
      artifactRootId: "foundation_artifacts",
      revision: job.input,
      acceptedDesignSha256: job.input.sha256,
      resourceSnapshotSha256: job.resources.sha256,
      artifacts: [],
    },
    cleanup: {
      schemaVersion: "1.0",
      projectId: job.projectId,
      requestId: context.requestId,
      status: "complete",
      value: {
        workerExitObserved: true,
        jobEmptyObserved: true,
        mode: "graceful",
        exitCode: 0,
        signal: null,
      },
      diagnosticIds: [],
    },
  };
  vi.mocked(renderStaged).mockResolvedValue(prepared);
  const unavailable = async (): Promise<never> => {
    throw new Error("No real worker/stage in this unit fixture.");
  };
  const execution: JobExecution = {
    context,
    record,
    checkpoint: unavailable,
    progress: unavailable,
    reserve: unavailable,
    settle: unavailable,
    stage: unavailable,
    filesystem: { stage: unavailable },
  };
  const service = createRenderJobs({
    loadRequest: unavailable,
    options: {
      projectId: job.projectId,
      providerId: "renderer_static",
      artifactRootId: "foundation_artifacts",
      authority: sessions.authority,
      rightsAuthority: () => false,
      resolveInputs: unavailable,
      worker: { open: unavailable },
    },
  });
  // The staged renderer itself is mocked; no browser or forged production publication is involved.
  const request = {
    design: parseContract(
      "DesignIR",
      await readFile(
        "tests\\fixtures\\foundation\\settings-screen.design.json",
        "utf8",
      ),
      "json",
    ),
    resources: parseContract(
      "ResourceSnapshot",
      await readFile("tests\\fixtures\\foundation\\resources.json", "utf8"),
      "json",
    ),
    revision: job.input,
    profile: result.profile,
    mode: "strict" as const,
  };
  const jobs = createRenderJobs({
    loadRequest: async () => request,
    options: {
      projectId: job.projectId,
      providerId: "renderer_static",
      artifactRootId: "foundation_artifacts",
      authority: sessions.authority,
      rightsAuthority: () => false,
      resolveInputs: unavailable,
      worker: { open: unavailable },
    },
  });
  const handler = jobs.handlers[0];
  if (!handler) throw new Error("No handler.");
  const completion = await handler.run(execution);
  if (completion.kind !== "complete")
    throw new Error("Expected prepared mocked completion.");
  return {
    jobs,
    service,
    handler,
    execution,
    record,
    context,
    sessions,
    controller,
    prepared,
    completion: completion.completion,
    evidence: outputs.map((item, index) => ({
      artifact: item.artifact,
      bytes: bytes[index] ?? new Uint8Array(),
    })),
  };
}
it("validates only current original preparation proof and rejects copied/revoked authority", async () => {
  const f = await fixture();
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, f.context),
  ).resolves.toBeUndefined();
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, {
      ...f.context,
      authorization: structuredClone(f.context.authorization),
    }),
  ).rejects.toThrow();
  f.sessions.revoke(f.context.authorization);
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, f.context),
  ).rejects.toThrow();
});
it("does not finalize after cancellation or uncertain cleanup even with previously derived stages", async () => {
  const f = await fixture();
  f.controller.abort();
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, f.context),
  ).rejects.toThrow();
  const g = await fixture();
  g.prepared.cleanup = {
    schemaVersion: "1.0",
    projectId: g.context.projectId,
    requestId: g.context.requestId,
    status: "interrupted",
    error: {
      code: "INTERRUPTED",
      message: "Owned cleanup uncertainty.",
      retryable: false,
      diagnosticIds: [],
    },
    diagnosticIds: [],
  };
  g.prepared.recoveryRequired = true;
  expect((await g.handler.run(g.execution)).kind).toBe("interrupt");
  await expect(
    g.jobs.verifyCompletion(g.record, g.completion, g.evidence, g.context),
  ).rejects.toThrow();
});
it("does not promote a partial unconfirmed stage as inspection completion", async () => {
  const f = await fixture();
  const staged = f.prepared.staged[0];
  if (!staged) throw new Error("Missing stage.");
  f.prepared.stageFailure = {
    schemaVersion: "1.0",
    projectId: f.context.projectId,
    requestId: f.context.requestId,
    status: "partial",
    value: staged,
    missing: ["journal-confirmation"],
    error: {
      code: "OUTPUT_UNCERTAIN",
      message: "Partial stage.",
      retryable: false,
      diagnosticIds: [],
    },
    diagnosticIds: [],
  };
  expect((await f.handler.run(f.execution)).kind).toBe("interrupt");
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, f.context),
  ).rejects.toThrow();
});
it("retains a private preparation snapshot when returned completion descriptors are changed", async () => {
  const f = await fixture();
  const output = f.completion.outputs[0];
  if (!output) throw new Error("Missing output.");
  output.artifact.path = `blobs/${"a".repeat(64)}`;
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, f.evidence, f.context),
  ).rejects.toThrow();
});
it("rejects extra binding/source authority and altered bytes even after a valid preparation", async () => {
  const f = await fixture();
  await expect(
    f.jobs.verifyCompletion(
      f.record,
      { ...f.completion, referenceBindings: [] },
      f.evidence,
      f.context,
    ),
  ).rejects.toThrow();
  const changed = f.evidence.map((entry) => ({
    ...entry,
    bytes: Uint8Array.of(255),
  }));
  await expect(
    f.jobs.verifyCompletion(f.record, f.completion, changed, f.context),
  ).rejects.toThrow();
});
