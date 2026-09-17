import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakeClock } from "@design-studio/contracts/testing";
import { HostBoundaryError } from "@design-studio/host";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import type { JobServiceOptions } from "../src/types.js";
import { deferred, fixture, makeService, value } from "./support.js";

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
