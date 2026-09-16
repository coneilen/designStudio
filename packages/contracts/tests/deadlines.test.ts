import { describe, expect, it, vi } from "vitest";
import type { Clock, OperationContext, SourceSnapshot } from "../src/index.js";
import { validateContract } from "../src/index.js";
import {
  createFakeClock,
  createFakeFigmaProvider,
  fakeComplete,
  syntheticContext,
} from "../src/testing.js";

const start = Date.parse("2026-09-16T00:00:00Z");
const request = { fileKey: "synthetic", nodeId: "1:2", version: "1" };
const snapshot: SourceSnapshot = {
  schemaVersion: "1.0",
  id: "source_synthetic",
  projectId: "project_synthetic",
  identity: {
    transport: "synthetic",
    fixtureId: "fixture_synthetic",
    contentDigest: "a".repeat(64),
  },
  capturedAt: "2026-09-16T00:00:00Z",
  captureEndedAt: "2026-09-16T00:00:00Z",
  consistency: { guarantee: "synthetic-immutable", limitations: [] },
  completeness: "complete",
  requests: [],
  artifacts: [],
  missing: [],
  diagnosticIds: [],
};

function setup(maxDurationMs = 10_000) {
  const virtual = createFakeClock(start);
  const waiters = new Set<AbortSignal>();
  const sleeps: Array<{ milliseconds: number; signal: AbortSignal }> = [];
  const controller = new AbortController();
  const clock: Clock = {
    now: virtual.now,
    sleep(milliseconds, signal) {
      sleeps.push({ milliseconds, signal });
      waiters.add(signal);
      return virtual.sleep(milliseconds, signal).finally(() => {
        waiters.delete(signal);
      });
    },
  };
  const defaults = syntheticContext();
  const context = syntheticContext({
    clock,
    signal: controller.signal,
    deadline: new Date(start + 1_000).toISOString(),
    authorization: {
      ...defaults.authorization,
      expiresAt: new Date(start + 60_000).toISOString(),
    },
    budget: { ...defaults.budget, maxDurationMs },
  });
  return { context, controller, sleeps, waiters, advance: virtual.advance };
}

function scriptedRequest(context: OperationContext) {
  const replies: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const result = createFakeFigmaProvider({
    reply: (current) =>
      new Promise((resolve) => {
        signals.push(current.signal);
        replies.push(() => resolve(fakeComplete(current, snapshot)));
      }),
  }).readSnapshot(request, context);
  return {
    result,
    signals,
    release() {
      const reply = replies.shift();
      if (!reply) throw new Error("The scripted request did not start.");
      reply();
    },
  };
}

describe("injected-clock provider deadlines", () => {
  it.each([1_000, 1_001])(
    "rejects completion after advancing virtual time by %i ms",
    async (elapsed) => {
      expect(validateContract("SourceSnapshot", snapshot).success).toBe(true);
      const clock = setup();
      const work = scriptedRequest(clock.context);
      clock.advance(elapsed);
      work.release();
      expect(await work.result).toMatchObject({
        status: "failed",
        error: { code: "DEADLINE_EXCEEDED" },
      });
      expect(clock.waiters.size).toBe(0);
    },
  );

  it("enforces the shorter duration budget with the same virtual clock", async () => {
    const clock = setup(100);
    const work = scriptedRequest(clock.context);
    clock.advance(100);
    work.release();
    expect(await work.result).toMatchObject({
      status: "failed",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    expect(clock.sleeps.map((sleep) => sleep.milliseconds)).toEqual([100]);
    expect(clock.waiters.size).toBe(0);
  });

  it("expires pending work through virtual time without releasing the reply or waiting for wall time", async () => {
    const clock = setup();
    const work = scriptedRequest(clock.context);
    try {
      expect(clock.sleeps.map((sleep) => sleep.milliseconds)).toEqual([1_000]);
      clock.advance(1_001);
      expect(await work.result).toMatchObject({
        status: "failed",
        error: { code: "DEADLINE_EXCEEDED" },
      });
      expect(work.signals.every((signal) => signal.aborted)).toBe(true);
      expect(clock.waiters.size).toBe(0);
    } finally {
      clock.controller.abort();
      await work.result;
    }
  });

  it("cancels the deadline sleep and removes cancellation listeners when work succeeds", async () => {
    const clock = setup();
    const removeListener = vi.spyOn(
      clock.context.signal,
      "removeEventListener",
    );
    const work = scriptedRequest(clock.context);
    clock.advance(999);
    work.release();
    expect(await work.result).toMatchObject({
      status: "complete",
      value: snapshot,
    });
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps.every((sleep) => sleep.signal.aborted)).toBe(true);
    expect(clock.waiters.size).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    clock.advance(10_000);
    clock.controller.abort();
    expect(await work.result).toMatchObject({ status: "complete" });
  });

  it("cancels pending work and drains the deadline sleep without an unhandled rejection", async () => {
    const clock = setup();
    const work = scriptedRequest(clock.context);
    clock.controller.abort();
    expect(await work.result).toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" },
    });
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps.every((sleep) => sleep.signal.aborted)).toBe(true);
    expect(work.signals.every((signal) => signal.aborted)).toBe(true);
    expect(clock.waiters.size).toBe(0);
    clock.advance(10_000);
    work.release();
    expect(await work.result).toMatchObject({ status: "cancelled" });
  });

  it("cleans up the deadline sleep without hiding a scripted failure", async () => {
    const clock = setup();
    const failure = new Error("Synthetic reply failure.");
    const result = createFakeFigmaProvider({
      reply: async () => {
        throw failure;
      },
    }).readSnapshot(request, clock.context);
    await expect(result).rejects.toBe(failure);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps.every((sleep) => sleep.signal.aborted)).toBe(true);
    expect(clock.waiters.size).toBe(0);
  });

  it("surfaces unexpected clock failures and cancels the remaining scripted work", async () => {
    const clock = setup();
    const failure = new Error("Synthetic clock failure.");
    const work = scriptedRequest({
      ...clock.context,
      clock: {
        now: clock.context.clock.now,
        sleep: () => Promise.reject(failure),
      },
    });
    work.release();
    await expect(work.result).rejects.toBe(failure);
    expect(work.signals.every((signal) => signal.aborted)).toBe(true);
  });
});
