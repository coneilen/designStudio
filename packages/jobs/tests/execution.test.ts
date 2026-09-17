import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import { fence } from "../src/execution.js";
import type { HandlerResult, JobExecution } from "../src/types.js";
import { deferred, fixture, makeService, output, value } from "./support.js";

const completed = async (ex: JobExecution): Promise<HandlerResult> => ({
  kind: "complete",
  completion: {
    outputs: [value(await ex.stage(output))],
    outputState: "complete",
    diagnosticIds: [],
  },
});

test("required authorities and runtime worker ceiling reject invalid configuration", async () => {
  const f = await fixture();
  expect(() =>
    makeService(f, completed, { executionAuthority: undefined as never }),
  ).toThrow();
  expect(() =>
    makeService(f, completed, { recoveryAuthority: undefined as never }),
  ).toThrow();
  for (const maxWorkers of [0, 5, Infinity, 1.5])
    expect(() => makeService(f, completed, { maxWorkers })).toThrow();
});
test("a missing current execution policy waits without invoking the handler", async () => {
  const f = await fixture();
  let calls = 0;
  const s = makeService(f, async (ex) => {
    calls++;
    return completed(ex);
  });
  value(await s.submit(f.submission(), f.context()));
  f.actors.delete("actor");
  value(await s.runOnce());
  expect(
    value(
      await s.get("job-work", f.context("observer", undefined, "supervisor")),
    ).status,
  ).toBe("waiting-for-user");
  expect(calls).toBe(0);
});
test("revoked authority during an attempt requires action after actual stop", async () => {
  const f = await fixture();
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  await started.promise;
  f.actors.delete("actor");
  value(await s.runOnce());
  release.resolve({ kind: "fail", error: detail("AUTH_REQUIRED") });
  const observer = f.context("observer", undefined, "supervisor");
  expect(value(await s.waitForAttempt("job-work", observer)).status).toBe(
    "waiting-for-user",
  );
});
test("issuer cannot enlarge persisted job budgets", async () => {
  const f = await fixture();
  let calls = 0;
  const s = makeService(
    f,
    async (ex) => {
      calls++;
      return completed(ex);
    },
    {
      executionAuthority: {
        ...f.executionAuthority,
        async issue(record, signal) {
          const context = await f.executionAuthority.issue(record, signal);
          return {
            ...context,
            budget: { ...context.budget, maxExternalCalls: 1 },
          };
        },
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  expect(calls).toBe(0);
  expect(value(await s.get("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
});
test("failed stage retains cumulative reservation and adopts its new row version", async () => {
  const f = await fixture();
  const s = makeService(f, async (ex) => {
    const before = ex.record.rowVersion;
    f.setFault((point) => {
      if (point === "job-after-stage") throw new Error("private-design-secret");
    });
    expect(await ex.stage(output)).toMatchObject({ status: "failed" });
    expect(ex.record.rowVersion).toBe(before + 1);
    expect(ex.record.usage.outputBytes).toBe(output.length);
    f.setFault(undefined);
    return { kind: "fail", error: detail("INTERNAL_ERROR") };
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const job = value(await s.waitForAttempt("job-work", f.context()));
  expect(job.status).not.toBe("completed");
  expect(JSON.stringify(job)).not.toContain("private-design-secret");
  expect(
    value(await f.store.jobs.get("job-work", f.context())).usage.outputBytes,
  ).toBe(output.length);
});
test("failed final publication/transaction remains interrupted, not automatically resolved", async () => {
  const f = await fixture();
  const s = makeService(f, async (ex) => {
    const result = await completed(ex);
    f.setFault((point) => {
      if (point === "before-commit") {
        f.setFault(undefined);
        throw new Error("publication response lost");
      }
    });
    return result;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const job = value(await s.waitForAttempt("job-work", f.context()));
  expect(job.status).toBe("interrupted");
  expect(
    value(await f.store.jobs.getJobReceipt("job-work", f.context())),
  ).toBeNull();
  expect(
    value(await f.store.jobs.getStages("job-work", f.context())),
  ).toHaveLength(1);
});
test("completed receipt wins cancellation queued at commit and response loss", async () => {
  const f = await fixture();
  let cancellation:
    | ReturnType<ReturnType<typeof makeService>["cancel"]>
    | undefined;
  const s = makeService(f, async (ex) => {
    const result = await completed(ex);
    f.setFault((point) => {
      if (point === "after-commit") {
        cancellation = s.cancel(
          "job-work",
          ex.record.rowVersion,
          f.context("cancel"),
        );
        throw new Error("lost response");
      }
    });
    return result;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const job = value(await s.waitForAttempt("job-work", f.context()));
  expect(job.status).toBe("completed");
  expect(cancellation).toBeDefined();
  if (!cancellation) throw new Error("Cancellation was not submitted.");
  expect(value(await cancellation).job.receipt).toEqual(job.receipt);
});
test("progress coalesces, heartbeat adopts versions, reservation budgets never reset", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const ex = await started.promise;
  await ex.progress(0.1);
  await ex.progress(0.2);
  expect(
    value(await f.store.jobs.get("job-work", f.context())).job.progress,
  ).toBe(0.1);
  clock.advance(300);
  value(await s.runOnce());
  expect(ex.record.job.progress).toBe(0.2);
  expect(ex.record.job.lease?.heartbeatAt).toBe(
    new Date(clock.now()).toISOString(),
  );
  await expect(ex.progress(0.1)).rejects.toThrow();
  await expect(
    ex.reserve("paid", {
      inputBytes: 0,
      outputBytes: 0,
      externalCalls: 1,
      modelTokens: 0,
      costMicros: 0,
    }),
  ).rejects.toThrow();
  await ex.reserve("local", {
    inputBytes: 1,
    outputBytes: 0,
    externalCalls: 0,
    modelTokens: 0,
    costMicros: 0,
  });
  await ex.settle("local", "no-effect");
  expect(ex.record.usage.inputBytes).toBe(1);
  release.resolve({ kind: "wait", error: detail("ACTION_REQUIRED") });
  expect(value(await s.waitForAttempt("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
});
test("unknown effects retain interruption, slots and reservations without retry", async () => {
  const f = await fixture();
  const s = makeService(f, async (ex) => {
    await ex.reserve("uncertain", {
      inputBytes: 1,
      outputBytes: 0,
      externalCalls: 0,
      modelTokens: 0,
      costMicros: 0,
    });
    await ex.settle("uncertain", "unknown");
    return { kind: "retry", error: detail("PROVIDER_UNAVAILABLE", true) };
  });

  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  expect(value(await s.waitForAttempt("job-work", f.context())).status).toBe(
    "interrupted",
  );
  const record = value(await f.store.jobs.get("job-work", f.context()));
  expect(record.effects[0]?.state).toBe("unknown");
  expect(record.job.lease).toBeDefined();
});

test("explicit uncertain output cannot be automatically retried even if marked retryable", async () => {
  const f = await fixture();
  const s = makeService(f, async () => ({
    kind: "retry",
    error: detail("OUTPUT_UNCERTAIN", true),
  }));
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const result = value(await s.waitForAttempt("job-work", f.context()));
  expect(result.status).toBe("interrupted");
  expect(result.nextEligibleAttempt).toBeUndefined();
});

test("fresh narrower execution budgets apply cumulatively, not separately to each stage", async () => {
  const f = await fixture();
  const s = makeService(
    f,
    async (ex) => {
      value(await ex.stage(output));
      expect(await ex.stage(output)).toMatchObject({
        status: "failed",
        error: { code: "OUTPUT_LIMIT" },
      });
      return { kind: "wait", error: detail("ACTION_REQUIRED") };
    },
    {
      executionAuthority: {
        ...f.executionAuthority,
        async issue(record, signal) {
          const ctx = await f.executionAuthority.issue(record, signal);
          return {
            ...ctx,
            budget: { ...ctx.budget, maxOutputBytes: output.length },
          };
        },
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  expect(value(await s.waitForAttempt("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
  expect(
    value(await f.store.jobs.get("job-work", f.context())).usage.outputBytes,
  ).toBe(output.length);
});

test("an old execution cannot adopt a successor fence or interrupt the successor", async () => {
  const f = await fixture();
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const old = await started.promise;
  const prior = value(await f.store.jobs.get("job-work", f.context()));
  const interrupted = value(
    await f.store.jobs.reconcile(
      "job-work",
      prior.rowVersion,
      { kind: "interrupt", error: detail("INTERRUPTED") },
      f.context("recovery"),
    ),
  );
  const decision = await f.evidence(interrupted, {
    reason: "stopped",
    error: detail("INTERRUPTED"),
    stopConfirmed: true,
    stoppedLeaseId: fence(prior).leaseId,
  });
  if (decision.kind !== "resolved")
    throw new Error("Expected fixture recovery.");
  decision.decision = "queued";
  const queued = value(
    await f.store.jobs.reconcile(
      "job-work",
      interrupted.rowVersion,
      decision,
      f.context("recovery"),
    ),
  );
  const successor = value(
    await f.store.jobs.claim(
      "job-work",
      { state: "queued", rowVersion: queued.rowVersion },
      "successor",
      1000,
      f.context(),
    ),
  );
  expect(fence(successor).fencingToken).toBeGreaterThan(
    fence(prior).fencingToken,
  );
  await expect(old.checkpoint()).rejects.toThrow();
  expect(await old.stage(output)).toMatchObject({ status: "failed" });
  release.resolve({
    kind: "complete",
    completion: { outputs: [], outputState: "complete", diagnosticIds: [] },
  });
  await s.waitForAttempt("job-work", f.context());
  const after = value(await f.store.jobs.get("job-work", f.context()));
  expect(after.rowVersion).toBe(successor.rowVersion);
  expect(after.job.status).toBe("running");
});
