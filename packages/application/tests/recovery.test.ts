import { readFile } from "node:fs/promises";
import { parseContract } from "@design-studio/contracts";
import { SystemClock } from "@design-studio/host";
import type { StoredJob } from "@design-studio/storage";
import { expect, it } from "vitest";
import { createFixturePolicy } from "../src/policy.js";
import { RecoveryDecisions } from "../src/recovery.js";

async function fixture() {
  const examples = parseContract(
    "JsonValue",
    await readFile(
      "tests\\fixtures\\foundation\\contract-examples.json",
      "utf8",
    ),
    "json",
  );
  if (
    !examples ||
    typeof examples !== "object" ||
    Array.isArray(examples) ||
    !Array.isArray(examples.artifacts)
  )
    throw new Error("Missing synthetic examples.");
  const entry = examples.artifacts.find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.contract === "Job",
  );
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error("Missing synthetic job.");
  const job = parseContract("Job", JSON.stringify(entry.value), "json");
  job.actorId = "owner";
  job.idempotency.actorId = "owner";
  const clock = new SystemClock();
  let actor = "owner";
  const policy = createFixturePolicy({
    clock,
    expectedActor: actor,
    currentActor: async () => actor,
    onRevoked: () => {},
  });
  const context = await policy.issue({
    requestId: "original",
    jobId: job.id,
    signal: new AbortController().signal,
    grants: [
      policy.rootGrant,
      {
        resourceKind: "job",
        resourceId: job.id,
        operations: ["read", "write"],
      },
    ],
  });
  const record: Pick<StoredJob, "job" | "requestId" | "generation"> = {
    job,
    requestId: "original",
    generation: 0,
  };
  const decisions = new RecoveryDecisions(policy);
  return {
    record,
    context,
    decisions,
    policy,
    revoke: () => {
      actor = "revoked";
    },
  };
}
it("allows only scoped conservative interruption before an evidence-backed resolution", async () => {
  const f = await fixture();
  const error = {
    code: "INTERRUPTED" as const,
    message: "Owned test.",
    retryable: false,
    diagnosticIds: [],
  };
  await expect(
    f.decisions.authorize(f.record, { kind: "interrupt", error }, f.context),
  ).rejects.toThrow();
  f.decisions.register(f.record, f.context);
  await expect(
    f.decisions.authorize(f.record, { kind: "interrupt", error }, f.context),
  ).resolves.toBeUndefined();
  const decision = await f.decisions.decide(
    f.record,
    { reason: "cancel", stoppedLeaseId: null, stopConfirmed: true, error },
    f.context,
  );
  expect(decision).toMatchObject({ kind: "resolved", decision: "cancelled" });
  await expect(
    f.decisions.authorize(f.record, decision, f.context),
  ).resolves.toBeUndefined();
  if (decision.kind !== "resolved") throw new Error("Expected resolution.");
  await expect(
    f.decisions.authorize(
      f.record,
      { ...decision, decision: "queued" },
      f.context,
    ),
  ).rejects.toThrow();
  await expect(
    f.decisions.authorize(
      f.record,
      { kind: "abandon-stages", evidenceRef: "guess", abandonedStageIds: [] },
      f.context,
    ),
  ).rejects.toThrow();
});
it("rejects cloned proof, changed job/request/generation and current principal revocation", async () => {
  const f = await fixture();
  const error = {
    code: "INTERRUPTED" as const,
    message: "Owned test.",
    retryable: false,
    diagnosticIds: [],
  };
  f.decisions.register(f.record, f.context);
  for (const context of [
    { ...f.context, authorization: structuredClone(f.context.authorization) },
    { ...f.context, jobId: "other" },
    { ...f.context, requestId: "other" },
  ])
    await expect(
      f.decisions.authorize(f.record, { kind: "interrupt", error }, context),
    ).rejects.toThrow();
  await expect(
    f.decisions.authorize(
      { ...f.record, generation: 1 },
      { kind: "interrupt", error },
      f.context,
    ),
  ).rejects.toThrow();
  f.revoke();
  await expect(
    f.decisions.authorize(f.record, { kind: "interrupt", error }, f.context),
  ).rejects.toThrow();
});
it("does not resolve missing stop evidence or a mismatched stopped lease", async () => {
  const f = await fixture();
  const error = {
    code: "INTERRUPTED" as const,
    message: "Owned test.",
    retryable: false,
    diagnosticIds: [],
  };
  f.decisions.register(f.record, f.context);
  const result = await f.decisions.decide(
    f.record,
    { reason: "stopped", stoppedLeaseId: null, stopConfirmed: false, error },
    f.context,
  );
  expect(result.kind).toBe("interrupt");
  await expect(
    f.decisions.decide(
      f.record,
      {
        reason: "cancel",
        stoppedLeaseId: "foreign",
        stopConfirmed: true,
        error,
      },
      f.context,
    ),
  ).rejects.toThrow();
});
it("accepts only the exact generation invalidation caused by its authorized conservative interruption", async () => {
  const f = await fixture();
  const error = {
    code: "INTERRUPTED" as const,
    message: "Owned test.",
    retryable: false,
    diagnosticIds: [],
  };
  f.decisions.register(f.record, f.context);
  await f.decisions.authorize(
    f.record,
    { kind: "interrupt", error },
    f.context,
  );
  f.record.generation++;
  f.record.job.status = "interrupted";
  f.record.job.error = error;
  const decision = await f.decisions.decide(
    f.record,
    { reason: "cancel", stoppedLeaseId: null, stopConfirmed: true, error },
    f.context,
  );
  await expect(
    f.decisions.authorize(f.record, decision, f.context),
  ).resolves.toBeUndefined();
  await expect(
    f.decisions.authorize(
      { ...f.record, generation: f.record.generation + 1 },
      decision,
      f.context,
    ),
  ).rejects.toThrow();
});
