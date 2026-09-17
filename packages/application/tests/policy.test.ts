import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { SystemClock } from "@design-studio/host";
import { expect, it } from "vitest";
import { createFixturePolicy } from "../src/policy.js";

it("issues exact owned authority and refuses clones or a revoked current actor", async () => {
  let current = "owned_actor";
  const lifetime = new AbortController();
  const policy = createFixturePolicy({
    clock: new SystemClock(),
    currentActor: async () => current,
    expectedActor: "owned_actor",
    onRevoked: () => lifetime.abort(),
  });
  const signal = new AbortController().signal;
  const context = await policy.issue({
    requestId: "logical_request",
    jobId: "job_1",
    grants: [
      { resourceKind: "job", resourceId: "job_1", operations: ["read"] },
    ],
    signal,
  });
  expect(policy.verify(context.authorization)).toBe(true);
  expect(policy.verify(structuredClone(context.authorization))).toBe(false);
  expect(context.requestId).toBe("logical_request");
  expect(context.signal).toBe(signal);
  expect(context.budget).toEqual(DEFAULT_BUDGETS);
  current = "foreign_actor";
  await expect(
    policy.issue({ requestId: "r", signal, grants: [] }),
  ).rejects.toThrow();
  expect(policy.verify(context.authorization)).toBe(false);
  expect(lifetime.signal.aborted).toBe(true);
});
it("does not accept effects, credentials, external grants or unbounded execution budgets", async () => {
  const policy = createFixturePolicy({
    clock: new SystemClock(),
    currentActor: async () => "owner",
    expectedActor: "owner",
    onRevoked: () => {},
  });
  await expect(
    policy.issue({
      requestId: "r",
      signal: new AbortController().signal,
      grants: [
        {
          resourceKind: "credential",
          resourceId: "secret",
          operations: ["read"],
        },
      ],
    }),
  ).rejects.toThrow();
  await expect(
    policy.issue({
      requestId: "r",
      signal: new AbortController().signal,
      grants: [],
      budget: { ...DEFAULT_BUDGETS, maxExternalCalls: 1 },
    }),
  ).rejects.toThrow();
});
it("preserves the admitted live signal and IDs across asynchronous principal verification", async () => {
  let proceed: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const policy = createFixturePolicy({
    clock: new SystemClock(),
    expectedActor: "owner",
    currentActor: async () => {
      await gate;
      return "owner";
    },
    onRevoked: () => {},
  });
  const controller = new AbortController();
  const input = {
    requestId: "original",
    signal: controller.signal,
    grants: [],
  };
  const pending = policy.issue(input);
  input.requestId = "changed";
  input.signal = new AbortController().signal;
  proceed?.();
  const context = await pending;
  expect(context.requestId).toBe("original");
  expect(context.signal).toBe(controller.signal);
});
it("revokes existing proofs when native current-principal verification fails", async () => {
  let failed = false;
  let revoked = false;
  const policy = createFixturePolicy({
    clock: new SystemClock(),
    expectedActor: "owner",
    currentActor: async () => {
      if (failed) throw new Error("Owned native failure.");
      return "owner";
    },
    onRevoked: () => {
      revoked = true;
    },
  });
  const context = await policy.issue({
    requestId: "r",
    signal: new AbortController().signal,
    grants: [],
  });
  failed = true;
  await expect(policy.check()).rejects.toThrow();
  expect(policy.verify(context.authorization)).toBe(false);
  expect(revoked).toBe(true);
});
it("keeps request-scoped proofs bound to current source authorization without constraining separately issued durable work", async () => {
  let sourceValid = true;
  const policy = createFixturePolicy({
    clock: new SystemClock(),
    expectedActor: "owner",
    currentActor: async () => "owner",
    onRevoked: () => {},
  });
  const request = await policy.issue({
    requestId: "request",
    signal: new AbortController().signal,
    grants: [],
    sourceAuthority: () => sourceValid,
  });
  const durable = await policy.issue({
    requestId: "durable",
    signal: new AbortController().signal,
    grants: [],
  });
  expect(policy.verify(request.authorization)).toBe(true);
  sourceValid = false;
  expect(policy.verify(request.authorization)).toBe(false);
  expect(policy.verify(durable.authorization)).toBe(true);
});
