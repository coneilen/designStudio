import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import type { HandlerResult, JobExecution } from "../src/types.js";
import { deferred, fixture, makeService, value } from "./support.js";

for (const cap of [1, 4]) {
  test(`cap ${cap}: retained slots survive interruption and a competing scheduler`, async () => {
    const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
    const f = await fixture({ clock, workers: cap });
    const running: JobExecution[] = [];
    const release = deferred<HandlerResult>();
    const s = makeService(
      f,
      async (ex) => {
        running.push(ex);
        return release.promise;
      },
      { maxWorkers: cap },
    );
    const ids = ["work", "other", "third", "fourth", "fifth"];
    for (const id of ids) {
      value(
        await s.submit(f.submission(id, [`resource-${id}`]), f.context(id)),
      );
      clock.advance(1);
    }
    value(await s.runOnce());
    expect(running).toHaveLength(cap);
    clock.advance(1000);
    value(await s.runOnce());
    let competingCalls = 0;
    const competitor = makeService(
      f,
      async () => {
        competingCalls++;
        return { kind: "wait", error: detail("ACTION_REQUIRED") };
      },
      { maxWorkers: cap, ownerId: "competitor" },
    );
    value(await competitor.runOnce());
    expect(competingCalls).toBe(0);
    expect(running.every((ex) => ex.context.signal.aborted)).toBe(true);
    release.resolve({ kind: "fail", error: detail("LEASE_LOST") });
    for (const ex of running)
      value(await s.waitForAttempt(ex.record.job.id, f.context("observer")));
    value(await competitor.runOnce());
    expect(competingCalls).toBe(Math.min(cap, 5 - cap));
    for (const id of ids)
      await competitor.waitForAttempt(`job-${id}`, f.context("observer"));
  });
}
test("restart never treats an expired lease as proof of stopped execution", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const queued = value(await f.store.jobs.create(f.submission(), f.context()));
  value(
    await f.store.jobs.claim(
      "job-work",
      { state: "queued", rowVersion: queued.rowVersion },
      "dead-worker",
      1000,
      f.context(),
    ),
  );
  await f.reopen();
  let calls = 0;
  const s = makeService(f, async () => {
    calls++;
    return { kind: "wait", error: detail("ACTION_REQUIRED") };
  });
  value(await s.runOnce());
  expect(value(await s.get("job-work", f.context())).status).toBe("running");
  clock.advance(1000);
  value(await s.runOnce());
  const job = value(await s.get("job-work", f.context()));
  expect(job.status).toBe("interrupted");
  expect(job.lease?.ownerId).toBe("dead-worker");
  expect(calls).toBe(0);
});
test("queued and safely waiting jobs respect their original absolute deadline", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const s = makeService(f, async () => ({
    kind: "wait",
    error: detail("ACTION_REQUIRED"),
  }));
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  value(await s.waitForAttempt("job-work", f.context()));
  value(await s.submit(f.submission("other"), f.context("other")));
  clock.advance(30000);
  value(await s.runOnce());
  expect(value(await s.get("job-work", f.context())).status).toBe("failed");
  expect(value(await s.get("job-other", f.context("other"))).status).toBe(
    "failed",
  );
});
test("bounded stop retains an uncooperative callback and its slot until actual return", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.start());
  const execution = await started.promise;
  const interrupted = deferred<void>();
  f.setFault((point) => {
    if (point === "before-commit") interrupted.resolve();
  });
  const stopping = s.stop(500);
  await interrupted.promise;
  f.setFault(undefined);
  clock.advance(500);
  expect(await stopping).toMatchObject({
    status: "failed",
    error: { code: "INTERRUPTED" },
  });
  expect(execution.context.signal.aborted).toBe(true);
  expect(value(await s.get("job-work", f.context())).status).toBe(
    "interrupted",
  );
  release.resolve({ kind: "fail", error: detail("INTERRUPTED") });
  value(await s.waitForAttempt("job-work", f.context()));
  expect(await s.stop()).toMatchObject({
    status: "complete",
    value: { active: 0 },
  });
});
test("stop during admission cannot launch a callback after stop has returned", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const observing = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const s = makeService(
    f,
    async () => {
      calls++;
      return { kind: "wait", error: detail("ACTION_REQUIRED") };
    },
    {
      executionAuthority: {
        ...f.executionAuthority,
        async observe(signal) {
          observing.resolve();
          await release.promise;
          return f.executionAuthority.observe(signal);
        },
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  const turn = s.runOnce();
  await observing.promise;
  const stopping = s.stop(100);
  release.resolve();
  await turn;
  await stopping;
  expect(calls).toBe(0);
  expect(value(await s.get("job-work", f.context())).status).toBe("queued");
});

test("a hung issuer has a finite allowance and cannot launch after its late reply", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const issuing = deferred<AbortSignal>();
  const release = deferred<void>();
  let calls = 0;
  const s = makeService(
    f,
    async () => {
      calls++;
      return { kind: "wait", error: detail("ACTION_REQUIRED") };
    },
    {
      authorityTimeoutMs: 100,
      executionAuthority: {
        ...f.executionAuthority,
        async issue(record, signal) {
          issuing.resolve(signal);
          await release.promise;
          return f.executionAuthority.issue(record, signal);
        },
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  const turn = s.runOnce();
  const signal = await issuing.promise;
  clock.advance(100);
  value(await turn);
  expect(signal.aborted).toBe(true);
  expect(value(await s.get("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
  release.resolve();
  expect(calls).toBe(0);
});

test("explicit current-policy resume retains logical identity and original limits", async () => {
  const f = await fixture();
  let calls = 0;
  const s = makeService(f, async () => {
    calls++;
    return { kind: "wait", error: detail("ACTION_REQUIRED") };
  });
  const original = value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  value(await s.waitForAttempt("job-work", f.context()));
  const record = value(await f.store.jobs.get("job-work", f.context()));
  const evidence = await f.evidence(record, {
    reason: "stopped",
    error: detail("ACTION_REQUIRED"),
    stoppedLeaseId: null,
    stopConfirmed: true,
  });
  if (evidence.kind !== "resolved")
    throw new Error("Expected fixture decision.");
  evidence.decision = "queued";
  value(
    await s.resume(
      "job-work",
      record.rowVersion,
      evidence,
      f.context("resume"),
    ),
  );
  value(await s.runOnce());
  const again = value(await s.waitForAttempt("job-work", f.context()));
  expect(again.attempt).toBe(2);
  expect(again.idempotency).toEqual(original.idempotency);
  expect(again.deadline).toBe(original.deadline);
  expect(again.budget).toEqual(original.budget);
  expect(calls).toBe(2);
});

test("wait cancellation does not cancel durable work or leak mutable private views", async () => {
  const f = await fixture();
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const ex = await started.promise;
  const waiter = new AbortController();
  const waiting = s.wait("job-work", f.context("observer", waiter.signal));
  waiter.abort();
  expect(await waiting).toMatchObject({ status: "cancelled" });
  expect(ex.context.signal.aborted).toBe(false);
  const viewed = value(await s.getVersioned("job-work", f.context()));
  viewed.job.budget.maxAttempts = 99;
  expect(value(await s.get("job-work", f.context())).budget.maxAttempts).toBe(
    3,
  );
  release.resolve({ kind: "wait", error: detail("ACTION_REQUIRED") });
  value(await s.waitForAttempt("job-work", f.context()));
});
