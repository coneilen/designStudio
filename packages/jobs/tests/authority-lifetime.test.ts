import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakeClock } from "@design-studio/contracts/testing";
import { HostBoundaryError } from "@design-studio/host";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import type { JobServiceOptions } from "../src/types.js";
import { deferred, fixture, makeService, value } from "./support.js";

test("execution issuance uses remaining job lifetime and still tracks late settlement", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const entered = deferred<AbortSignal>();
  const release = deferred<void>();
  let calls = 0;
  const service = makeService(
    f,
    async () => {
      calls++;
      return { kind: "wait", error: detail("ACTION_REQUIRED") };
    },
    {
      authorityTimeoutMs: 15000,
      executionAuthority: {
        ...f.executionAuthority,
        async issue(record, signal) {
          entered.resolve(signal);
          await release.promise;
          return f.executionAuthority.issue(record, signal);
        },
      },
    },
  );
  const submission = f.submission();
  submission.deadline = new Date(clock.now() + 100).toISOString();
  value(await service.submit(submission, f.context()));
  const turn = service.runOnce();
  const signal = await entered.promise;
  clock.advance(99);
  await nextTurn();
  const abortedBeforeDeadline = signal.aborted;
  clock.advance(1);
  await nextTurn();
  const abortedAtDeadline = signal.aborted;
  const stopping = service.stop(100);
  await nextTurn();
  clock.advance(100);
  const beforeSettlement = await stopping;
  release.resolve();
  await turn;
  const afterSettlement = await service.stop(100);
  expect(abortedBeforeDeadline).toBe(false);
  expect(abortedAtDeadline).toBe(true);
  expect(beforeSettlement).toMatchObject({ status: "interrupted" });
  expect(afterSettlement).toMatchObject({ status: "complete" });
  expect(calls).toBe(0);
});

test("already expired job skips execution issuance but permits fresh recovery authority", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  let issued = 0;
  let recovered = 0;
  const service = makeService(
    f,
    async () => {
      throw new Error("Expired job cannot run.");
    },
    {
      authorityTimeoutMs: 15000,
      executionAuthority: {
        ...f.executionAuthority,
        async issue(record, signal) {
          issued++;
          return f.executionAuthority.issue(record, signal);
        },
      },
      recoveryAuthority: {
        ...f.recoveryAuthority,
        async issue(record, signal) {
          recovered++;
          return f.recoveryAuthority.issue(record, signal);
        },
      },
    },
  );
  const submission = f.submission();
  submission.deadline = new Date(clock.now() + 100).toISOString();
  value(await service.submit(submission, f.context()));
  clock.advance(100);
  value(await service.runOnce());
  expect(issued).toBe(0);
  expect(recovered).toBe(1);
  expect(value(await service.get("job-work", f.context())).status).toBe(
    "failed",
  );
  value(await service.stop());
});

for (const callback of [
  "observe",
  "observe-rejection",
  "issue",
  "recovery-issue",
  "recovery-decision",
] as const) {
  test(`timed-out ${callback} still prevents shutdown until its original promise settles`, async () => {
    const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
    const f = await fixture({ clock });
    const entered = deferred<AbortSignal>();
    const release = deferred<void>();
    const settled = deferred<void>();
    async function delay<T>(
      signal: AbortSignal,
      operation: () => Promise<T>,
    ): Promise<T> {
      entered.resolve(signal);
      try {
        await release.promise;
        if (callback === "observe-rejection")
          throw new Error("Late synthetic authority failure.");
        return await operation();
      } finally {
        settled.resolve();
      }
    }
    const overrides: Partial<JobServiceOptions> = { authorityTimeoutMs: 100 };
    if (callback === "observe" || callback === "observe-rejection") {
      overrides.executionAuthority = {
        ...f.executionAuthority,
        observe: (signal) =>
          delay(signal, () => f.executionAuthority.observe(signal)),
      };
    } else if (callback === "issue") {
      overrides.executionAuthority = {
        ...f.executionAuthority,
        issue: (record, signal) =>
          delay(signal, () => f.executionAuthority.issue(record, signal)),
      };
    } else {
      overrides.executionAuthority = {
        ...f.executionAuthority,
        async issue() {
          throw new HostBoundaryError(
            "AUTH_REQUIRED",
            "Current policy requires action.",
          );
        },
      };
      overrides.recoveryAuthority =
        callback === "recovery-issue"
          ? {
              ...f.recoveryAuthority,
              issue: (record, signal) =>
                delay(signal, () => f.recoveryAuthority.issue(record, signal)),
            }
          : {
              ...f.recoveryAuthority,
              decide: (record, facts, context) =>
                delay(context.signal, () =>
                  f.recoveryAuthority.decide(record, facts, context),
                ),
            };
    }
    let calls = 0;
    const service = makeService(
      f,
      async () => {
        calls++;
        return { kind: "wait", error: detail("ACTION_REQUIRED") };
      },
      overrides,
    );
    value(await service.submit(f.submission(), f.context()));
    const turn = service.runOnce();
    const signal = await entered.promise;
    clock.advance(100);
    await turn;
    expect(signal.aborted).toBe(true);
    const stopping = service.stop(100);
    await nextTurn();
    clock.advance(100);
    const beforeSettlement = await stopping;
    release.resolve();
    await settled.promise;
    const afterSettlement = await service.stop(100);
    expect(beforeSettlement).toMatchObject({
      status: "interrupted",
      error: { code: "INTERRUPTED" },
    });
    expect(afterSettlement).toMatchObject({
      status: "complete",
      value: { active: 0 },
    });
    expect(calls).toBe(0);
  });
}
