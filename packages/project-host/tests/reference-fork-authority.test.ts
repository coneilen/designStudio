import { expect, it, vi } from "vitest";
import { nativeCapturePolicy } from "../src/capture-authority.js";
import type { CaptureWork } from "../src/capture-work.js";

// Synthetic current-work admission isolates grant construction; no native project is opened.
vi.mock("../src/capture-work.js", () => ({ assertCaptureWork: vi.fn() }));

function setup() {
  const work = {
    actorId: "synthetic_actor",
    project: { projectId: "synthetic_project", artifactRootId: "blobs" },
    isCurrent: () => true,
    current: vi.fn(async () => {}),
    referenceForkAuthority: vi.fn(async () => "fork-authority"),
    referenceOfflineAuthority: vi.fn(async () => "offline-authority"),
  };
  const policy = nativeCapturePolicy(work as unknown as CaptureWork);
  Object.assign(work, { policy });
  const controller = new AbortController();
  const input = {
    jobId: `fork_reference_${"a".repeat(64)}`,
    requestId: `fork_reference_${"a".repeat(64)}`,
    jobReads: [`convert_reference_${"b".repeat(64)}`],
    write: true,
    deadline: new Date(Date.now() + 60000).toISOString(),
    signal: controller.signal,
  };
  return { work, policy, input, controller };
}

it("issues closed-shape fork-result grants with only the selected job readable", async () => {
  const { work, policy, input, controller } = setup();
  const resultInput = {
    jobId: input.jobId,
    requestId: "result_request",
    deadline: input.deadline,
    signal: input.signal,
  };
  try {
    for (const extra of [
      { write: false },
      { write: true },
      { jobReads: [] },
      { output: false },
      { output: true },
    ])
      await expect(
        policy.issueReferenceForkResult({ ...resultInput, ...extra }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      policy.issueReferenceForkResult({
        ...resultInput,
        jobId: `convert_reference_${"a".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    work.referenceForkAuthority.mockClear();
    const context = await policy.issueReferenceForkResult(resultInput);
    expect(work.referenceForkAuthority).toHaveBeenCalledOnce();
    expect(work.referenceOfflineAuthority).not.toHaveBeenCalled();
    expect(context.authorization.egress).toBe("deny");
    expect(context.budget.maxExternalCalls).toBe(0);
    expect(context.authorization.grants).toEqual([
      { resourceKind: "artifact", resourceId: "blobs", operations: ["read"] },
      {
        resourceKind: "artifact",
        resourceId: "outputs_synthetic_project",
        operations: ["read"],
      },
      {
        resourceKind: "job",
        resourceId: input.jobId,
        operations: ["read"],
      },
    ]);
    controller.abort();
    expect(policy.verify(context.authorization)).toBe(false);
    await expect(
      policy.issueReferenceForkResult(resultInput),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    Object.assign(work, { referenceForkAuthority: undefined });
    await expect(
      policy.issueReferenceForkResult(resultInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    policy.close();
  }
});

it("issues independent deny-egress fork grants with writes only to the owning job and artifact root", async () => {
  const { work, policy, input, controller } = setup();
  try {
    const context = await policy.issueReferenceFork(input);
    expect(work.referenceForkAuthority).toHaveBeenCalledOnce();
    expect(work.referenceOfflineAuthority).not.toHaveBeenCalled();
    expect(context.authorization.egress).toBe("deny");
    expect(context.budget).toMatchObject({
      maxExternalCalls: 0,
      maxDurationMs: 30000,
      maxInputBytes: 26214400,
      maxRasterPixels: 6553600,
    });
    expect(Date.parse(context.deadline)).toBeLessThanOrEqual(
      context.clock.now() + 30000,
    );
    expect(
      context.authorization.grants.filter((grant) =>
        grant.operations.includes("write"),
      ),
    ).toEqual([
      {
        resourceKind: "artifact",
        resourceId: "blobs",
        operations: ["read", "write"],
      },
      {
        resourceKind: "job",
        resourceId: input.jobId,
        operations: ["read", "write"],
      },
    ]);
    expect(
      context.authorization.grants.every((grant) =>
        ["artifact", "job"].includes(grant.resourceKind),
      ),
    ).toBe(true);
    expect(policy.verify(context.authorization)).toBe(true);
    controller.abort();
    expect(policy.verify(context.authorization)).toBe(false);
  } finally {
    policy.close();
  }
});

it("supports historical proof reads but neither issuer can widen its writer namespace", async () => {
  const { policy, input } = setup();
  try {
    for (const jobId of [
      `reference_${"b".repeat(64)}`,
      `offline_reference_${"b".repeat(64)}`,
      `convert_reference_${"b".repeat(64)}`,
    ]) {
      const context = await policy.issueReferenceFork({
        ...input,
        jobId,
        write: false,
      });
      expect(
        context.authorization.grants.every((grant) =>
          grant.operations.every((operation) => operation === "read"),
        ),
      ).toBe(true);
      await expect(
        policy.issueReferenceFork({ ...input, jobId, requestId: jobId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(policy.issueReferenceOffline(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    for (const jobId of [
      `fork_reference_${"a".repeat(63)}`,
      `fork_reference_${"A".repeat(64)}`,
      `${input.jobId}_extra`,
    ])
      await expect(
        policy.issueReferenceFork({ ...input, jobId, requestId: jobId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    policy.close();
  }
});

it("binds write requests to the exact own job without promoting any requested read", async () => {
  const { policy, input } = setup();
  const otherFork = `fork_reference_${"c".repeat(64)}`;
  try {
    const sourceJobId = input.jobReads[0];
    if (sourceJobId === undefined)
      throw new Error("Synthetic source job is missing.");
    for (const requestId of ["synthetic_request", otherFork, sourceJobId, ""])
      await expect(
        policy.issueReferenceFork({ ...input, requestId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const context = await policy.issueReferenceFork({
      ...input,
      jobReads: [...input.jobReads, otherFork, input.jobId, otherFork],
    });
    expect(context.requestId).toBe(context.jobId);
    expect(
      context.authorization.grants.filter(
        (grant) => grant.resourceKind === "job",
      ),
    ).toEqual([
      {
        resourceKind: "job",
        resourceId: input.jobId,
        operations: ["read", "write"],
      },
      {
        resourceKind: "job",
        resourceId: sourceJobId,
        operations: ["read"],
      },
      { resourceKind: "job", resourceId: otherFork, operations: ["read"] },
    ]);
    expect(
      context.authorization.grants.find(
        (grant) => grant.resourceId === "outputs_synthetic_project",
      )?.operations,
    ).toEqual(["read"]);
    const source = await policy.issueReferenceFork({
      ...input,
      jobId: sourceJobId,
      requestId: "independent_source_read",
      write: false,
    });
    expect(
      source.authorization.grants.every((grant) =>
        grant.operations.every((operation) => operation === "read"),
      ),
    ).toBe(true);
  } finally {
    policy.close();
  }
});

it("refuses missing supplement, invalid options, exhausted reads, cancellation and expired deadlines", async () => {
  const { work, policy, input, controller } = setup();
  try {
    await expect(
      policy.issueReferenceFork(Object.assign({}, input, { extra: true })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      policy.issueReferenceFork({
        ...input,
        jobReads: Array(1001).fill("job"),
      }),
    ).rejects.toMatchObject({ code: "INPUT_LIMIT" });
    await expect(
      policy.issueReferenceFork({ ...input, deadline: "not-a-date" }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await expect(
      policy.issueReferenceFork({
        ...input,
        deadline: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    work.referenceForkAuthority.mockRejectedValueOnce(new Error("denied"));
    await expect(policy.issueReferenceFork(input)).rejects.toThrow("denied");
    controller.abort();
    await expect(policy.issueReferenceFork(input)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    Object.assign(work, { referenceForkAuthority: undefined });
    await expect(policy.issueReferenceFork(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  } finally {
    policy.close();
  }
});

it("owns requested job reads before admission awaits and revokes them on close", async () => {
  const { work, policy, input } = setup();
  let resume!: () => void;
  work.current.mockImplementationOnce(
    () => new Promise<void>((resolve) => (resume = resolve)),
  );
  const originalRead = input.jobReads[0];
  const pending = policy.issueReferenceFork(input);
  input.jobReads[0] = "unrequested_job";
  input.jobId = "unrequested_writer";
  input.requestId = "unrequested_request";
  resume();
  try {
    const context = await pending;
    expect(context.jobId).toBe(`fork_reference_${"a".repeat(64)}`);
    expect(context.requestId).toBe(context.jobId);
    expect(
      context.authorization.grants.some(
        (grant) => grant.resourceId === originalRead,
      ),
    ).toBe(true);
    expect(
      context.authorization.grants.some((grant) =>
        grant.resourceId.startsWith("unrequested"),
      ),
    ).toBe(false);
    policy.close();
    expect(policy.verify(context.authorization)).toBe(false);
    await expect(policy.issueReferenceFork(input)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  } finally {
    policy.close();
  }
});
