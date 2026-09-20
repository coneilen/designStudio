import type {
  CommitReceipt,
  Job,
  OperationContext,
  Outcome,
} from "@design-studio/contracts";
import { canonicalBytes } from "@design-studio/design-ir";
import type { JobSubmission, StoredJob } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import {
  type CaptureServiceOptions,
  createFigmaCaptureJobs,
} from "../src/service.js";
import { CaptureHttpError, FigmaHttpsTransport } from "../src/transport.js";
import { type CaptureFixture, captureFixture, digest } from "./support.js";

const success = <T>(context: OperationContext, value: T): Outcome<T> => ({
  schemaVersion: "1.0",
  projectId: context.projectId,
  requestId: context.requestId,
  status: "complete",
  value,
  diagnosticIds: [],
});
function serviceFixture(f: CaptureFixture) {
  const records = new Map<string, StoredJob>();
  const receipts = new Map<string, CommitReceipt>();
  const repository: CaptureServiceOptions["repository"] = {
    get: async (id, context) => {
      const value = records.get(id);
      return value
        ? success(context, structuredClone(value))
        : {
            schemaVersion: "1.0",
            projectId: context.projectId,
            requestId: context.requestId,
            status: "failed",
            error: {
              code: "RESOURCE_UNRESOLVED",
              message: "Synthetic missing job.",
              retryable: false,
              diagnosticIds: [],
            },
            diagnosticIds: [],
          };
    },
    getJobReceipt: async (id, context) =>
      success(context, receipts.get(id) ?? null),
    discoverOwned: async (query, context) =>
      success(context, {
        descriptors: [...records.values()]
          .filter((record) => !query.jobId || record.job.id === query.jobId)
          .map((record) => ({
            jobId: record.job.id,
            projectId: record.job.projectId,
            actorId: record.job.actorId,
            requestId: record.requestId,
            operation: record.job.operation,
            status: record.job.status,
            rowVersion: record.rowVersion,
            input: record.job.input,
            resources: record.job.resources,
            handlerId: record.handlerId,
            handlerVersion: record.handlerVersion,
            authorityRef: record.authorityRef,
            physicalInputs: [],
            outputs: receipts.get(record.job.id)?.outputs ?? [],
          })),
        nextCursor: null,
      }),
  };
  const api = createFigmaCaptureJobs({
    ...f,
    repository,
    readArtifact: async (reference, _context, maximum) => {
      const bytes = f.blobs.get(reference.sha256);
      if (!bytes || bytes.length > maximum)
        throw new Error("Synthetic missing artifact");
      return {
        artifact: {
          id: reference.id,
          sha256: reference.sha256,
          byteLength: bytes.length,
          path: `blobs/${reference.sha256}`,
          mediaType: "application/octet-stream",
        },
        bytes: Buffer.from(bytes),
      };
    },
  });
  return { api, records, receipts };
}
it("submits once using existing job identity, and replay never repeats capture or returns past evidence after revocation", async () => {
  const f = captureFixture();
  const fixture = serviceFixture(f);
  let submissions = 0;
  const queue = {
    async submit(
      input: JobSubmission,
      context: OperationContext,
    ): Promise<Outcome<Job>> {
      submissions++;
      const record = structuredClone(f.record);
      record.submission = input;
      record.job.status = "queued";
      fixture.records.set(input.id, record);
      return success(context, record.job);
    },
  };
  const input = f.record.job.input;
  await fixture.api.submit(
    queue,
    f.request,
    input,
    f.record.job.resources,
    "capture_authority",
    f.context,
  );
  await fixture.api.submit(
    queue,
    f.request,
    input,
    f.record.job.resources,
    "capture_authority",
    f.context,
  );
  expect(submissions).toBe(1);
  expect(f.reads()).toBe(0);
  f.revoke();
  await expect(
    fixture.api.submit(
      queue,
      f.request,
      input,
      f.record.job.resources,
      "capture_authority",
      f.context,
    ),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  await expect(
    fixture.api.readResult(f.request.captureId, f.context),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});
it("verifies exact prepared bytes at commit and persists cooldown in private immutable outputs", async () => {
  const f = captureFixture();
  const fixture = serviceFixture(f);
  const network = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockRejectedValue(new CaptureHttpError("RATE_LIMITED", 429, "3600"));
  try {
    const handler = fixture.api.handlers[0];
    if (!handler) throw new Error("Missing capture handler");
    const completed = await handler.run(f.execution);
    expect(completed.kind).toBe("complete");
    if (completed.kind !== "complete")
      throw new Error("Capture preparation failed");
    expect(completed.completion.outputState).toBe("partial-inspection");
    const evidence = completed.completion.outputs.map((stage) => ({
      artifact: stage.artifact,
      bytes: Buffer.from(f.blobs.get(stage.artifact.sha256) ?? []),
    }));
    await fixture.api.verifyCompletion(
      f.record,
      completed.completion,
      evidence,
      f.context,
    );
    const damaged = evidence.map((entry) => ({
      ...entry,
      bytes: Buffer.from(entry.bytes),
    }));
    damaged[0]?.bytes.fill(1);
    await expect(
      fixture.api.verifyCompletion(
        f.record,
        completed.completion,
        damaged,
        f.context,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY" });
    f.record.job.status = "completed";
    fixture.records.set(f.record.job.id, structuredClone(f.record));
    fixture.receipts.set(f.record.job.id, {
      schemaVersion: "1.0",
      id: "capture_receipt",
      projectId: f.policy.projectId,
      jobId: f.record.job.id,
      idempotency: f.record.job.idempotency,
      committedAt: new Date(f.context.clock.now()).toISOString(),
      outputs: completed.completion.outputs.map((stage) => stage.artifact),
      integrity: "verified",
      publication: "atomic",
    });
    const result = await fixture.api.readResult(f.record.job.id, f.context);
    expect(result).toMatchObject({
      completeness: "unavailable",
      errorCode: "RATE_LIMITED",
    });
    expect(result?.nextEligibleAt).toBeDefined();
    const next = { ...f.request, captureId: "next_capture" };
    const bytes = canonicalBytes(next);
    const reference = { id: `sha256_${digest(bytes)}`, sha256: digest(bytes) };
    f.blobs.set(reference.sha256, Buffer.from(bytes));
    const context = {
      ...f.context,
      jobId: next.captureId,
      requestId: "next_request",
    };
    const queue = { submit: vi.fn(async () => success(context, f.record.job)) };
    await expect(
      fixture.api.submit(
        queue,
        next,
        reference,
        f.record.job.resources,
        "capture_authority",
        context,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(queue.submit).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
    expect(f.reads()).toBe(1);
  } finally {
    network.mockRestore();
  }
});
it("an interrupted prior network effect without a committed result blocks a fresh capture", async () => {
  const f = captureFixture();
  const fixture = serviceFixture(f);
  f.record.usage.externalCalls = 1;
  f.record.job.status = "interrupted";
  fixture.records.set(f.record.job.id, f.record);
  const next = { ...f.request, captureId: "next_capture" };
  const bytes = canonicalBytes(next);
  const reference = { id: `sha256_${digest(bytes)}`, sha256: digest(bytes) };
  const context = { ...f.context, jobId: next.captureId };
  const queue = { submit: vi.fn(async () => success(context, f.record.job)) };
  await expect(
    fixture.api.submit(
      queue,
      next,
      reference,
      f.record.job.resources,
      "capture_authority",
      context,
    ),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  expect(queue.submit).not.toHaveBeenCalled();
  expect(f.reads()).toBe(0);
});
