import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import { deferred } from "../../host/tests/deferred.js";
import { AsyncTestScope } from "./async-scope.js";

it("does not advance before actual fake-clock sleep registration", async ({
  signal,
}) => {
  const scope = new AsyncTestScope(signal);
  const clock = createFakeClock();
  const registration = deferred<void>();
  scope.releaseOnEnd(() => registration.resolve());
  let sleeping: Promise<void> | undefined;
  const original = scope.track(
    (async () => {
      await registration.promise;
      sleeping = clock.sleep(100, scope.signal);
      scope.notify();
      await sleeping;
    })(),
  );
  const turn = scope.track(
    (async () => {
      await scope.until(() => (sleeping ? { sleeping } : undefined));
      clock.advance(100);
      await original;
    })(),
  );
  try {
    await Promise.resolve();
    expect(clock.now()).toBe(0);
    registration.resolve();
    await turn;
    expect(clock.now()).toBe(100);
  } finally {
    await scope.close();
  }
});
it("releases blocked work and joins it before teardown can restore global spies", async ({
  signal,
}) => {
  const scope = new AsyncTestScope(signal);
  const gate = deferred<void>();
  const late = deferred<void>();
  const events: string[] = [];
  scope.releaseOnEnd(() => gate.resolve());
  scope.track(
    (async () => {
      await gate.promise;
      await late.promise;
      events.push("worker-finished");
    })(),
  );
  const closing = scope.close().then(() => events.push("spies-restored"));
  try {
    await Promise.resolve();
    expect(events).toEqual([]);
  } finally {
    late.resolve();
    await closing;
  }
  expect(events).toEqual(["worker-finished", "spies-restored"]);
});
it("the original runner signal releases gates and aborts event waits", async () => {
  const original = new AbortController();
  const scope = new AsyncTestScope(original.signal);
  const gate = deferred<void>();
  scope.releaseOnEnd(() => gate.resolve());
  let returned = false;
  const work = scope.track(
    gate.promise.then(() => {
      returned = true;
    }),
  );
  const waiting = expect(scope.until(() => undefined)).rejects.toThrow(
    /cancelled/,
  );
  original.abort();
  await waiting;
  await scope.close();
  await work;
  expect(returned).toBe(true);
});
