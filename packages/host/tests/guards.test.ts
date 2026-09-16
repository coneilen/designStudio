import { syntheticContext } from "@design-studio/contracts/testing";
import { describe, expect, it } from "vitest";
import {
  authorizeOperation,
  OperationGuard,
  SystemClock,
} from "../src/guards.js";

const scope = {
  projectId: "project_synthetic",
  resourceKind: "provider",
  resourceId: "fake-process",
  operation: "execute",
} as const;
const authority = () => true;

describe("trusted scoped context", () => {
  it("requires trusted provenance in addition to schema/grants", () => {
    expect(() =>
      authorizeOperation(syntheticContext(), scope, () => false),
    ).toThrowError(/authority/i);
    expect(() =>
      authorizeOperation(syntheticContext(), scope, authority),
    ).not.toThrow();
  });
  it.each([
    { projectId: "foreign" },
    { resourceKind: "repository" as const },
    { resourceId: "other" },
    { operation: "write" as const },
    { actorId: "other" },
  ])("denies mismatched scope %j", (override) => {
    expect(() =>
      authorizeOperation(
        syntheticContext(),
        { ...scope, ...override },
        authority,
      ),
    ).toThrow();
  });
  it("rejects expired, cancelled and nonfinite contexts", () => {
    const context = syntheticContext();
    expect(() =>
      authorizeOperation(
        { ...context, deadline: "2000-01-01T00:00:00Z" },
        scope,
        authority,
      ),
    ).toThrow(/deadline/i);
    expect(() =>
      authorizeOperation(
        {
          ...context,
          authorization: {
            ...context.authorization,
            expiresAt: "2000-01-01T00:00:00Z",
          },
        },
        scope,
        authority,
      ),
    ).toThrow(/expired/i);
    expect(() =>
      authorizeOperation(
        { ...context, signal: AbortSignal.abort() },
        scope,
        authority,
      ),
    ).toThrow(/cancel/i);
    expect(() =>
      authorizeOperation(
        { ...context, budget: { ...context.budget, maxInputBytes: Infinity } },
        scope,
        authority,
      ),
    ).toThrow(/invalid/i);
  });
  it("enforces cumulative finite budgets without resetting the deadline", () => {
    let now = Date.now();
    const context = syntheticContext({
      clock: { now: () => now, sleep: async () => {} },
    });
    const guard = new OperationGuard(context, scope, authority);
    guard.consume("input", context.budget.maxInputBytes);
    expect(() => guard.consume("input", 1)).toThrow(/limit/i);
    expect(() => guard.consume("output", -1)).toThrow(/invalid/i);
    now += context.budget.maxDurationMs;
    expect(() => guard.check()).toThrow(/deadline/i);
  });
  it("real sleep is abortable and rejects invalid durations", async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    const sleep = clock.sleep(10_000, controller.signal);
    controller.abort();
    await expect(sleep).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      clock.sleep(Infinity, new AbortController().signal),
    ).rejects.toThrow();
    await clock.sleep(1, new AbortController().signal);
  });
});
