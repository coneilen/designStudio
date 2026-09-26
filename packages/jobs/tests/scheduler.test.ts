import { createFakeClock } from "@design-studio/contracts/testing";
import { beforeEach, describe, expect, test as it } from "vitest";
import { detail } from "../src/boundary.js";
import type { HandlerResult, JobExecution } from "../src/types.js";
import { AsyncTestScope } from "./async-scope.js";
import {
  fixture as createFixture,
  makeService as createService,
  deferred,
  jobsCleanupCount,
  ownCleanup,
  value,
} from "./support.js";
import {
  type ObservationCounters,
  observeSelectedTest,
  type TestObservation,
} from "./test-observation.js";
import { testScope } from "./test-scope.js";

let scope: AsyncTestScope;
const observations = new WeakMap<
  AsyncTestScope,
  {
    observer: TestObservation;
    counters: () => ObservationCounters;
    progress: { submitIndex: number; completedSubmits: number };
  }
>();
let previousSupport: AsyncTestScope | undefined;
const pendingCount = (owner: AsyncTestScope | undefined) => {
  const pending: unknown = owner && Reflect.get(owner, "pending");
  return pending instanceof Set ? pending.size : null;
};
beforeEach(({ signal, task }) => {
  const priorScheduler = scope;
  const priorSupport = previousSupport;
  const support = testScope();
  const observed = observeSelectedTest(task.name, signal);
  const progress = { submitIndex: 0, completedSubmits: 0 };
  // Sample prior owners before replacing the existing module-global scheduler scope.
  observed.counters(() => ({
    priorSchedulerPending: pendingCount(priorScheduler),
    priorSupportPending: pendingCount(priorSupport),
    cleanupEntries: jobsCleanupCount(),
  }));
  observed.phase("setup");
  scope = new AsyncTestScope(signal);
  const owner = scope;
  previousSupport = support;
  const counters = (): ObservationCounters => ({
    schedulerPending: pendingCount(owner),
    supportPending: pendingCount(support),
    priorSchedulerPending: pendingCount(priorScheduler),
    priorSupportPending: pendingCount(priorSupport),
    cleanupEntries: jobsCleanupCount(),
    schedulerOwnerMatches: scope === owner ? 1 : 0,
    schedulerAborted: owner.signal.aborted ? 1 : 0,
    supportAborted: support.signal.aborted ? 1 : 0,
    ...progress,
  });
  observations.set(owner, { observer: observed, counters, progress });
  observed.counters(counters);
  ownCleanup(async () => {
    observed.phase("scheduler-scope-join");
    await owner.close();
  });
});
function fixture(options: Parameters<typeof createFixture>[0] = {}) {
  const observation = observations.get(scope);
  return createFixture({
    ...options,
    ...(observation
      ? {
          observation: observation.observer,
          observationCounters: observation.counters,
        }
      : {}),
  });
}
function test(
  name: string,
  work: (observed: TestObservation) => Promise<void>,
) {
  it(name, () => {
    const observed = observations.get(scope)?.observer;
    if (!observed) throw new Error("Missing scheduler test observation");
    observed.phase("body");
    const settled = observed.pending();
    return scope.track(work(observed).finally(settled));
  });
}
function makeService(...args: Parameters<typeof createService>) {
  const service = createService(...args);
  const owner = scope;
  const observed = observations.get(owner)?.observer;
  args[0].ownCleanup(async () => {
    observed?.phase("scheduler-scope-join");
    await owner.close();
    observed?.phase("service-stop");
    value(await service.stop());
  });
  return service;
}
function gate<T>(abandoned: T) {
  const result = deferred<T>();
  scope.releaseOnEnd(() => result.resolve(abandoned));
  return result;
}

for (const cap of [1, 4]) {
  describe(`retained-slot fixture cap ${cap}`, () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let clock: ReturnType<typeof createFakeClock>;
    let s: ReturnType<typeof makeService>;
    let competitor: ReturnType<typeof makeService> | undefined;
    let release: ReturnType<typeof deferred<HandlerResult>>;
    const running: JobExecution[] = [];
    const ids = ["work", "other", "third", "fourth", "fifth"];
    beforeEach(() => {
      const observed = observations.get(scope);
      if (!observed) throw new Error("Missing original setup observation");
      observed.observer.phase("setup");
      const settled = observed.observer.pending();
      return scope.track(
        (async () => {
          running.length = 0;
          competitor = undefined;
          clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
          f = await fixture({ clock, workers: cap });
          release = deferred<HandlerResult>();
          scope.releaseOnEnd(() =>
            release.resolve({ kind: "fail", error: detail("LEASE_LOST") }),
          );
          s = makeService(
            f,
            async (ex) => {
              running.push(ex);
              return release.promise;
            },
            { maxWorkers: cap },
          );
          for (const id of ids) {
            observed.progress.submitIndex++;
            observed.observer.phase("submit");
            value(
              await s.submit(
                f.submission(id, [`resource-${id}`]),
                f.context(id, scope.signal),
              ),
            );
            observed.progress.completedSubmits++;
            clock.advance(1);
          }
        })().finally(settled),
      );
    });
    test(`cap ${cap}: retained slots survive interruption and a competing scheduler`, (observed) =>
      scope.track(
        (async () => {
          observed.phase("run-once");
          value(await s.runOnce());
          expect(running).toHaveLength(cap);
          clock.advance(1000);
          value(await s.runOnce());
          let competingCalls = 0;
          competitor = makeService(
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
          observed.phase("attempt-wait");
          for (const ex of running)
            value(
              await s.waitForAttempt(
                ex.record.job.id,
                f.context("observer", scope.signal),
              ),
            );
          value(await competitor.runOnce());
          expect(competingCalls).toBe(Math.min(cap, 5 - cap));
          for (const id of ids)
            await competitor.waitForAttempt(
              `job-${id}`,
              f.context("observer", scope.signal),
            );
        })(),
      ));
  });
}
test("restart never treats an expired lease as proof of stopped execution", async (observed) => {
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
  observed.phase("restart");
  await f.reopen();
  let calls = 0;
  const s = makeService(f, async () => {
    calls++;
    return { kind: "wait", error: detail("ACTION_REQUIRED") };
  });
  observed.phase("run-once");
  value(await s.runOnce());
  expect(value(await s.get("job-work", f.context())).status).toBe("running");
  clock.advance(1000);
  value(await s.runOnce());
  const job = value(await s.get("job-work", f.context()));
  expect(job.status).toBe("interrupted");
  expect(job.lease?.ownerId).toBe("dead-worker");
  expect(calls).toBe(0);
});
test("queued and safely waiting jobs respect their original absolute deadline", async (observed) => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const s = makeService(f, async () => ({
    kind: "wait",
    error: detail("ACTION_REQUIRED"),
  }));
  observed.phase("submit");
  value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  value(await s.runOnce());
  observed.phase("attempt-wait");
  value(await s.waitForAttempt("job-work", f.context()));
  value(await s.submit(f.submission("other"), f.context("other")));
  clock.advance(30000);
  value(await s.runOnce());
  expect(value(await s.get("job-work", f.context())).status).toBe("failed");
  expect(value(await s.get("job-other", f.context("other"))).status).toBe(
    "failed",
  );
});
test("bounded stop retains an uncooperative callback and its slot until actual return", async (observed) => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const started = deferred<JobExecution>();
  const release = gate<HandlerResult>({
    kind: "fail",
    error: detail("INTERRUPTED"),
  });
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  observed.phase("submit");
  value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  value(await s.start());
  observed.phase("fake-clock-wait");
  const execution = await scope.wait(started.promise);
  const interrupted = deferred<void>();
  f.setFault((point) => {
    if (point === "before-commit") interrupted.resolve();
  });
  observed.phase("service-stop");
  const stopping = s.stop(500);
  observed.phase("fake-clock-wait");
  await scope.wait(interrupted.promise);
  f.setFault(undefined);
  clock.advance(500);
  expect(await stopping).toMatchObject({
    status: "interrupted",
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
test("stop during admission cannot launch a callback after stop has returned", async (observed) => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const observing = deferred<void>();
  const release = gate<void>(undefined);
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
  observed.phase("submit");
  value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  const turn = s.runOnce();
  observed.phase("fake-clock-wait");
  await scope.wait(observing.promise);
  observed.phase("service-stop");
  const stopping = s.stop(100);
  release.resolve();
  await turn;
  await stopping;
  expect(calls).toBe(0);
  expect(value(await s.get("job-work", f.context())).status).toBe("queued");
});

test("a hung issuer has a finite allowance and cannot launch after its late reply", async (observed) => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const issuing = deferred<AbortSignal>();
  const release = gate<void>(undefined);
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
  observed.phase("submit");
  value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  const turn = s.runOnce();
  observed.phase("fake-clock-wait");
  const signal = await scope.wait(issuing.promise);
  clock.advance(100);
  value(await turn);
  expect(signal.aborted).toBe(true);
  expect(value(await s.get("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
  release.resolve();
  observed.phase("service-stop");
  value(await s.stop());
  expect(calls).toBe(0);
});

test("explicit current-policy resume retains logical identity and original limits", async (observed) => {
  const f = await fixture();
  let calls = 0;
  const s = makeService(f, async () => {
    calls++;
    return { kind: "wait", error: detail("ACTION_REQUIRED") };
  });
  observed.phase("submit");
  const original = value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  value(await s.runOnce());
  observed.phase("attempt-wait");
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

test("wait cancellation does not cancel durable work or leak mutable private views", async (observed) => {
  const f = await fixture();
  const started = deferred<JobExecution>();
  const release = gate<HandlerResult>({
    kind: "fail",
    error: detail("INTERRUPTED"),
  });
  const s = makeService(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  observed.phase("submit");
  value(await s.submit(f.submission(), f.context()));
  observed.phase("run-once");
  value(await s.runOnce());
  observed.phase("fake-clock-wait");
  const ex = await scope.wait(started.promise);
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
