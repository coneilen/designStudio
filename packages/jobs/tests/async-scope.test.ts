import { getEventListeners } from "node:events";
import { createFakeClock } from "@design-studio/contracts/testing";
import { afterEach, aroundEach, describe, expect, it } from "vitest";
import { deferred } from "../../host/tests/deferred.js";
import { AsyncTestScope } from "./async-scope.js";
import {
  OBSERVATION_LIMITS,
  type ObservationSource,
  observeSelectedTest,
} from "./test-observation.js";
import { inTestScope, ownTests, testScope } from "./test-scope.js";

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

describe("owned conditional test bodies", () => {
  aroundEach((run, context) =>
    inTestScope(new AsyncTestScope(context.signal), run),
  );
  afterEach(async () => {
    await testScope().close();
  });

  function observationFixture() {
    const lines: string[] = [];
    let tick = () => {};
    let stops = 0,
      releases = 0,
      starts = 0;
    let now = 1000;
    const sample = {
      cpuUserMicros: 1,
      cpuSystemMicros: 2,
      rssBytes: 3,
      heapUsedBytes: 4,
      fsReadOperations: 5,
      fsWriteOperations: 6,
      eventLoopMeanMicros: 0,
      eventLoopMaxMicros: 0,
      eventLoopP99Micros: 0,
      eventLoopSamples: 0,
    };
    const source: ObservationSource = {
      monotonic: () => now,
      wall: () => 1700000000000 + now,
      sample: () => sample,
      start: (callback) => {
        starts++;
        tick = callback;
      },
      stopSampling: () => {
        stops++;
      },
      release: () => {
        releases++;
      },
      write: (line) => {
        lines.push(line);
      },
    };
    return {
      source,
      sample,
      lines,
      tick() {
        now += 1000;
        tick();
      },
      get starts() {
        return starts;
      },
      get stops() {
        return stops;
      },
      get releases() {
        return releases;
      },
    };
  }
  const observedTestName =
    "fails closed when serialized finalization itself outlives the lease";

  it("closed test observer is disabled outside the exact six names without allocating resources", () => {
    const fixture = observationFixture();
    const runner = new AbortController();
    const observer = observeSelectedTest(
      "private test/path",
      runner.signal,
      () => {
        throw new Error("Disabled observer must not construct a source");
      },
    );
    observer.phase("setup");
    observer.counters(() => {
      throw new Error("Not evaluated");
    });
    observer.pending()();
    observer.unresolved();
    observer.closed();
    runner.abort();
    expect(fixture.lines).toEqual([]);
  });

  it("closed test observer bounds all phase/sample bytes and reserves exactly-once abort and closure", () => {
    const fixture = observationFixture();
    const runner = new AbortController();
    const observer = observeSelectedTest(
      observedTestName,
      runner.signal,
      () => fixture.source,
    );
    observer.counters(() => ({
      pendingBodies: Number.MAX_SAFE_INTEGER,
      sleepers: Number.MAX_SAFE_INTEGER,
      turns: Number.MAX_SAFE_INTEGER,
      activeJobs: Number.MAX_SAFE_INTEGER,
    }));
    for (let i = 0; i < 1000; i++) observer.phase("turns");
    for (let i = 0; i < 100; i++) fixture.tick();
    runner.abort();
    runner.signal.dispatchEvent(new Event("abort"));
    observer.unresolved();
    observer.unresolved();
    observer.closed();
    observer.closed();
    const records = fixture.lines.map((line) => JSON.parse(line));
    expect(records.length).toBeLessThanOrEqual(OBSERVATION_LIMITS.records);
    expect(Buffer.byteLength(fixture.lines.join(""))).toBeLessThanOrEqual(
      OBSERVATION_LIMITS.bytes,
    );
    expect(records.filter((r) => r.event === "abort")).toHaveLength(1);
    expect(records.filter((r) => r.event === "closed")).toHaveLength(1);
    expect(records.filter((r) => r.event === "cap")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      event: "closed",
      settled: true,
      outputCapReached: true,
      sampleCapReached: true,
    });
    expect(records.at(-1).dropped).toBeGreaterThan(0);
    expect(fixture.stops).toBe(1);
    expect(fixture.releases).toBe(1);
    expect(getEventListeners(runner.signal, "abort")).toHaveLength(0);
  });

  it("closed test observer samples at most ninety ticks and explicitly reports exhaustion", () => {
    const fixture = observationFixture();
    const observer = observeSelectedTest(
      observedTestName,
      new AbortController().signal,
      () => fixture.source,
    );
    for (let i = 0; i < 200; i++) fixture.tick();
    observer.closed();
    const records = fixture.lines.map((line) => JSON.parse(line));
    expect(
      records.filter((r) => r.event === "sample").length,
    ).toBeLessThanOrEqual(90);
    expect(fixture.stops).toBe(1);
    const cap = records.find((r) => r.event === "cap");
    expect(cap).toMatchObject({ settled: false });
    expect(cap.sampleCapReached || cap.outputCapReached).toBe(true);
    expect(records.at(-1)).toMatchObject({
      event: "closed",
      sampleCapReached: true,
    });
  });

  it("closed observer retains its timer/monitor until deferred original work and owner closure settle", async () => {
    const fixture = observationFixture();
    const runner = new AbortController();
    const observer = observeSelectedTest(
      observedTestName,
      runner.signal,
      () => fixture.source,
    );
    const gate = deferred<void>();
    const done = observer.pending();
    const work = gate.promise.finally(done);
    runner.abort();
    observer.closed();
    expect(fixture.releases).toBe(0);
    expect(
      fixture.lines
        .map((line) => JSON.parse(line))
        .some((r) => r.event === "closed"),
    ).toBe(false);
    try {
      fixture.tick();
      expect(fixture.lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: "unresolved",
          pendingObservedWork: 1,
          settled: false,
        }),
      );
    } finally {
      gate.resolve();
      await work;
    }
    expect(fixture.releases).toBe(1);
    const count = fixture.lines.length;
    observer.phase("body");
    observer.pending()();
    fixture.tick();
    runner.signal.dispatchEvent(new Event("abort"));
    expect(fixture.lines).toHaveLength(count);
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      event: "closed",
      pendingObservedWork: 0,
    });
  });

  it("closed observer omits invalid counters/samples and reports observer faults without masking failures", () => {
    const fixture = observationFixture();
    const observer = observeSelectedTest(
      observedTestName,
      new AbortController().signal,
      () => fixture.source,
    );
    fixture.source.sample = () => ({
      ...fixture.sample,
      path: "private-path",
      error: "private-error",
    });
    observer.counters(() => ({ turns: 1, sql: "private-query" }));
    observer.phase("body");
    fixture.source.sample = () => {
      throw new Error("private-stack");
    };
    observer.closed();
    const text = fixture.lines.join("");
    expect(text).not.toMatch(/private-|sql|path|stack/);
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      observerFault: true,
      event: "closed",
    });
  });

  it("closed observer never reads accessors or lets failing output replace a test error", () => {
    const fixture = observationFixture();
    const observer = observeSelectedTest(
      observedTestName,
      new AbortController().signal,
      () => fixture.source,
    );
    let reads = 0;
    Object.defineProperty(fixture.sample, "rssBytes", {
      get() {
        reads++;
        throw new Error("private accessor");
      },
    });
    expect(() => observer.phase("body")).not.toThrow();
    expect(reads).toBe(0);
    const write = fixture.source.write;
    fixture.source.write = () => {
      throw new Error("observer sink failed");
    };
    expect(() => observer.phase("scope-join")).not.toThrow();
    fixture.source.write = write;
    observer.closed();
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      observerFault: true,
    });
  });

  it("closed observer marks unavailable internals null rather than implying zero drained work", () => {
    const fixture = observationFixture();
    const observer = observeSelectedTest(
      observedTestName,
      new AbortController().signal,
      () => fixture.source,
    );
    observer.counters(() => ({
      activeJobs: null,
      pendingAuthorities: null,
      turns: 0,
    }));
    observer.phase("body");
    const record = JSON.parse(fixture.lines.at(-1) ?? "");
    expect(record).toMatchObject({
      activeJobs: null,
      pendingAuthorities: null,
      turns: 0,
      unavailableCounters: 2,
      countersAvailable: true,
    });
    observer.closed();
  });

  it("closed observer never claims resource closure when monitor release fails", () => {
    const fixture = observationFixture();
    const runner = new AbortController();
    const observer = observeSelectedTest(
      observedTestName,
      runner.signal,
      () => fixture.source,
    );
    const release = fixture.source.release;
    fixture.source.release = () => {
      throw new Error("private monitor failure");
    };
    expect(() => observer.closed()).not.toThrow();
    expect(fixture.lines.map((line) => JSON.parse(line))).not.toContainEqual(
      expect.objectContaining({ event: "closed" }),
    );
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      event: "unresolved",
      settled: false,
      observerResourcesClosed: false,
      resourceFaults: 1,
    });
    fixture.source.release = release;
    observer.closed();
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      event: "closed",
      observerResourcesClosed: true,
      observerFault: true,
    });
    expect(getEventListeners(runner.signal, "abort")).toHaveLength(0);
    expect(fixture.lines.join("")).not.toContain("private");
  });

  it("closed observer rejects arbitrary phase values and summarizes sink failure without throwing", () => {
    const fixture = observationFixture();
    const observer = observeSelectedTest(
      observedTestName,
      new AbortController().signal,
      () => fixture.source,
    );
    Reflect.apply(observer.phase, undefined, ["private-sql"]);
    const write = fixture.source.write;
    fixture.source.write = () => {
      throw new Error("private sink");
    };
    observer.phase("body");
    fixture.source.write = write;
    observer.closed();
    expect(JSON.parse(fixture.lines.at(-1) ?? "")).toMatchObject({
      observerFault: true,
      sinkFaults: 1,
    });
    expect(fixture.lines.join("")).not.toContain("private");
  });
  const owned = ownTests(it);
  owned.skipIf(false)("tracks the original skipIf body promise", async () => {
    const pending: unknown = Reflect.get(testScope(), "pending");
    expect(pending instanceof Set && pending.size > 0).toBe(true);
  });
  owned.runIf(true)("tracks the original runIf body promise", async () => {
    const pending: unknown = Reflect.get(testScope(), "pending");
    expect(pending instanceof Set && pending.size > 0).toBe(true);
  });
});
