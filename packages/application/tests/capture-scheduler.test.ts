import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CredentialStore } from "@design-studio/contracts";
import {
  createFakeClock,
  createFakeFileSystem,
  fakeComplete,
  fakeFailure,
} from "@design-studio/contracts/testing";
import {
  HostBoundaryError,
  ProjectFileSystem,
  SystemClock,
} from "@design-studio/host";
import { JobService } from "@design-studio/jobs";
import type { CaptureProject } from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { AsyncTestScope } from "../../jobs/tests/async-scope.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import type { CaptureWork } from "../../project-host/dist/capture-work.js";
import {
  assembleNativeCapture,
  type NativeCaptureCleanupRequired,
} from "../src/capture-runtime-internal.js";

const seam = vi.hoisted(() => ({ work: undefined as CaptureWork | undefined }));
vi.mock("@design-studio/project-host", async (original) => ({
  ...(await original<typeof import("@design-studio/project-host")>()),
  acquireCaptureWork: () => {
    if (!seam.work) throw new Error("Synthetic work not admitted");
    return seam.work;
  },
}));
vi.mock("../../project-host/dist/capture-work.js", () => ({
  assertCaptureWork: (work: CaptureWork) => {
    if (work !== seam.work) throw new Error("Unknown synthetic work");
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let owner: AsyncTestScope;
let prepared: Awaited<ReturnType<typeof createFixture>> | undefined;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async ({ signal }) => {
  owner = new AsyncTestScope(signal);
  prepared = await owner.track(createFixture());
});
afterEach(async () => {
  await owner.close();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  seam.work = undefined;
  prepared = undefined;
});
function owned<T extends unknown[]>(work: (...args: T) => Promise<void>) {
  return (...args: T) => owner.track(work(...args));
}
function gate() {
  const pending = deferred<void>();
  owner.releaseOnEnd(() => pending.resolve());
  return pending;
}

async function fixture() {
  owner.signal.throwIfAborted();
  if (!prepared) throw new Error("Scheduler fixture was not prepared");
  return prepared;
}
async function createFixture() {
  const scope = owner;
  const root = await mkdtemp(
    path.join(tmpdir(), "capture-scheduler-synthetic-"),
  );
  let openedRuntime:
    | Awaited<ReturnType<typeof assembleNativeCapture>>
    | undefined;
  let store: LocalStore | undefined;
  let policy: ReturnType<typeof nativeCapturePolicy> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      if (openedRuntime) await openedRuntime.close();
      else {
        store?.close();
        policy?.close();
      }
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  };
  cleanups.push(close);
  const clock = createFakeClock(Date.parse("2026-09-21T00:00:00Z"));
  const sleepers = new Set<Promise<void>>();
  const scheduled = new Map<
    Promise<void>,
    { milliseconds: number; signal: AbortSignal }
  >();
  let schedulerSignal: AbortSignal | undefined;
  vi.spyOn(SystemClock.prototype, "now").mockImplementation(clock.now);
  vi.spyOn(SystemClock.prototype, "sleep").mockImplementation((ms, signal) => {
    const sleeping = clock.sleep(ms, signal);
    sleepers.add(sleeping);
    scheduled.set(sleeping, { milliseconds: ms, signal });
    scope.notify();
    sleeping.then(
      () => {
        sleepers.delete(sleeping);
        scheduled.delete(sleeping);
        scope.notify();
      },
      () => {
        sleepers.delete(sleeping);
        scheduled.delete(sleeping);
        scope.notify();
      },
    );
    return sleeping;
  });
  // Native admission, credentials, filesystem and transport are synthetic.
  // The facade, native authority, capture handler, scheduler and SQLite are real.
  const project = {
    projectId: "project_synthetic",
    artifactRootId: "artifacts_synthetic",
    paths: {
      database: path.join(root, "state.sqlite"),
      artifacts: root,
      outputs: root,
      inputs: root,
      temp: root,
    },
    principal: { actorId: "actor_synthetic" },
    reference: {
      id: "credential_synthetic",
      providerId: "figma_rest",
      store: "windows-credential-manager",
    },
    recheck: async () => {},
    close: async () => {},
  } as CaptureProject;
  const credentials: CredentialStore = {
    async use(_reference, context, consumer) {
      const bytes = Buffer.from("synthetic-only");
      try {
        return fakeComplete(context, await consumer(bytes));
      } finally {
        bytes.fill(0);
      }
    },
  };
  const work: CaptureWork = {
    project,
    actorId: project.principal.actorId,
    permissionScope: "synthetic",
    sqliteBinding: path.resolve(
      ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
    ),
    policyId: "synthetic",
    policySha256: "a".repeat(64),
    imageOrigins: [],
    apiOrigins: ["https://api.figma.com"],
    get policy() {
      if (!policy) throw new Error("Synthetic policy not initialized");
      return policy;
    },
    current: async () => {},
    readyCredential: async () => undefined,
    recoveryAuthority: async () => {
      throw new Error("Scheduler fixture does not authorize recovery");
    },
    isCurrent: () => true,
    attestDatabase: async () => {},
    credentials: () => credentials,
    close: vi.fn(),
  };
  seam.work = work;
  policy = nativeCapturePolicy(work);
  const memory = createFakeFileSystem(project.projectId);
  const closeFiles = vi.fn(async () => {});
  const files: ProjectFileSystem = Object.create(ProjectFileSystem.prototype);
  Object.assign(files, {
    ...memory,
    ensurePublicationDurable: async (_root, _artifacts, context) =>
      fakeComplete(context, { durable: true }),
    closePreservingStages: closeFiles,
  } satisfies Pick<
    ProjectFileSystem,
    keyof typeof memory | "ensurePublicationDurable" | "closePreservingStages"
  >);
  vi.spyOn(ProjectFileSystem, "create").mockResolvedValue(files);
  const open = LocalStore.open.bind(LocalStore);
  vi.spyOn(LocalStore, "open").mockImplementation(async (options) => {
    store = await open(options);
    return store;
  });
  const originalStop = JobService.prototype.stop;
  const stops = vi
    .spyOn(JobService.prototype, "stop")
    .mockImplementation(function (this: JobService, ...args) {
      const result = originalStop.apply(this, args);
      queueMicrotask(() => scope.notify());
      return result;
    });
  const originalStart = JobService.prototype.start;
  const starts = vi
    .spyOn(JobService.prototype, "start")
    .mockImplementation(async function (this: JobService) {
      const prior = new Set(
        [...scheduled.values()].map((entry) => entry.signal),
      );
      const result = await originalStart.call(this);
      if (result.status === "complete") {
        const candidates = [...scheduled.values()].filter(
          (entry) => entry.milliseconds === 100 && !prior.has(entry.signal),
        );
        if (candidates.length !== 1)
          throw new Error("Missing exact scheduler cadence registration");
        schedulerSignal = candidates[0]?.signal;
      }
      scope.notify();
      return result;
    });
  const wait = vi.spyOn(JobService.prototype, "waitForAttempt");
  const runtime = await assembleNativeCapture(project);
  openedRuntime = runtime;
  if (!store) throw new Error("Missing synthetic store");
  const heartbeat = vi.spyOn(store.jobs, "heartbeat");
  const claim = vi.spyOn(store.jobs, "claim");
  const commitJob = store.jobs.commitJob.bind(store.jobs);
  const commit = vi.spyOn(store.jobs, "commitJob");
  const originalTurn = JobService.prototype.runOnce;
  const turns = vi
    .spyOn(JobService.prototype, "runOnce")
    .mockImplementation(function (this: JobService) {
      const result = originalTurn.call(this);
      queueMicrotask(() => scope.notify());
      return result;
    });
  const parent = new AbortController();
  scope.releaseOnEnd(() => parent.abort());
  const input = {
    operation: "capture" as const,
    requestId: "capture_synthetic",
    url: "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
  };
  const readyTurn = async (ms: number) => {
    await scope.wait(
      starts.mock.results[0]?.value ??
        Promise.reject(new Error("Scheduler was not started")),
    );
    await scope.until(() =>
      [...scheduled.values()].some((entry) => entry.signal === schedulerSignal)
        ? true
        : undefined,
    );
    const count = turns.mock.calls.length;
    const next = scope.until(() =>
      turns.mock.calls.length > count
        ? { pending: turns.mock.results[count]?.value }
        : undefined,
    );
    clock.advance(ms);
    return next;
  };
  return {
    clock,
    policy,
    runtime,
    store,
    input,
    parent,
    heartbeat,
    claim,
    commit,
    commitJob,
    starts,
    stops,
    wait,
    turns,
    sleepers,
    closeFiles,
    awaitEvent: scope.wait.bind(scope),
    stopStarted: (count: number) =>
      scope.until(() => (stops.mock.calls.length >= count ? true : undefined)),
    stopTimer: () =>
      scope.until(() =>
        [...scheduled.values()].some((entry) => entry.milliseconds === 5000)
          ? true
          : undefined,
      ),
    readyTurn,
    async turn(ms = 2000) {
      const next = await readyTurn(ms);
      await scope.wait(next.pending);
    },
    close,
  };
}

function provider() {
  const entered = deferred<Parameters<FigmaHttpsTransport["api"]>[3]>();
  const release = gate();
  const network = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockImplementation(async (operation, _version, _secret, budget) => {
      if (operation === "nodes") {
        entered.resolve(budget);
        await release.promise;
      }
      const json =
        operation === "metadata"
          ? { file: { version: "synthetic_v1" } }
          : operation === "nodes"
            ? {
                version: "synthetic_v1",
                nodes: {
                  "1:2": {
                    document: {
                      id: "1:2",
                      type: "FRAME",
                      name: "Synthetic",
                      absoluteBoundingBox: { x: 0, y: 0, width: 2, height: 2 },
                      children: [],
                    },
                  },
                },
              }
            : { images: { "1:2": null } };
      const bytes = Buffer.from(JSON.stringify(json));
      budget.dnsQuery();
      budget.receive(bytes.length);
      budget.decoded(bytes.length);
      return { status: 200, bytes, mediaType: "application/json" };
    });
  return { entered, release, network };
}

it.each([
  { duration: 6000, step: 2000 },
  { duration: 28000, step: 100 },
])(
  "renews the unchanged lease for a $duration ms provider at $step ms turns and stops before returning",
  owned(async ({ duration, step }) => {
    const f = await fixture();
    const p = provider();
    const result = f.runtime.execute(f.input, f.parent.signal);
    try {
      await f.awaitEvent(p.entered.promise);
      const execution = f.claim.mock.calls[0]?.[4];
      if (!execution) throw new Error("Missing execution authority");
      expect(execution.signal).not.toBe(f.parent.signal);
      expect(Date.parse(execution.deadline) - f.clock.now()).toBe(30000);
      expect(execution.budget).toMatchObject({
        maxAttempts: 1,
        maxExternalCalls: 4,
      });
      for (let elapsed = 0; elapsed < duration; elapsed += step) {
        await f.turn(step);
        expect(await f.turns.mock.results.at(-1)?.value).toMatchObject({
          status: "complete",
        });
      }
      expect(f.policy.verify(execution.authorization)).toBe(true);
      expect(execution.signal.aborted).toBe(false);
      expect(f.turns).toHaveBeenCalledTimes(duration / step + 1);
      p.release.resolve();
      expect(await result).toMatchObject({
        status: "partial",
        value: { jobStatus: "completed" },
      });
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.claim.mock.calls[0]?.[3]).toBe(5000);
      expect(f.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(
        Math.floor(duration / 2000),
      );
      expect(f.heartbeat.mock.calls.every((call) => call[2] === 5000)).toBe(
        true,
      );
      expect(f.commit).toHaveBeenCalledTimes(1);
      expect(f.stops).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
      const calls = f.turns.mock.calls.length;
      f.clock.advance(6000);
      await Promise.resolve();
      expect(f.turns).toHaveBeenCalledTimes(calls);
      expect(p.network).toHaveBeenCalledTimes(3);
    } finally {
      p.release.resolve();
      await result;
      await f.close();
    }
  }),
);

it(
  "waits for the original start acknowledgement before advancing fake time",
  owned(async () => {
    const f = await fixture();
    const p = provider();
    const acknowledged = gate();
    const entered = deferred<void>();
    const start = f.starts.getMockImplementation();
    if (!start) throw new Error("Missing real scheduler start observer");
    f.starts.mockImplementationOnce(async function (this: JobService) {
      const report = await start.call(this);
      entered.resolve();
      await acknowledged.promise;
      return report;
    });
    const result = f.runtime.execute(f.input, f.parent.signal);
    try {
      await f.awaitEvent(entered.promise);
      const before = f.clock.now();
      const turning = owner.track(f.turn(100));
      await Promise.resolve();
      expect(f.clock.now()).toBe(before);
      acknowledged.resolve();
      await turning;
      await f.awaitEvent(p.entered.promise);
      p.release.resolve();
      expect(await result).toMatchObject({ status: "partial" });
      expect(f.stops).toHaveBeenCalledTimes(1);
    } finally {
      acknowledged.resolve();
      p.release.resolve();
      await result;
      await f.close();
    }
  }),
);

it(
  "preserves a delayed original provider failure instead of lease CONFLICT",
  owned(async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = gate();
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockImplementation(async (_operation, _version, _secret, budget) => {
        entered.resolve();
        await release.promise;
        budget.dnsQuery();
        throw new CaptureHttpError("PROVIDER_UNAVAILABLE", 503);
      });
    const result = f.runtime.execute(f.input, f.parent.signal);
    try {
      await f.awaitEvent(entered.promise);
      for (let count = 0; count < 3; count++) await f.turn();
      release.resolve();
      expect(await result).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
        value: {
          jobStatus: "completed",
          capture: { completeness: "unavailable" },
        },
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.stops).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
    } finally {
      release.resolve();
      await result;
      await f.close();
    }
  }),
);
it.each(["cancel", "deadline"] as const)(
  "joins the original provider after %s without another attempt",
  owned(async (reason) => {
    const f = await fixture();
    const p = provider();
    let settled = false;
    const result = f.runtime.execute(f.input, f.parent.signal).finally(() => {
      settled = true;
    });
    try {
      const budget = await f.awaitEvent(p.entered.promise);
      if (reason === "cancel") {
        await f.turn();
        f.parent.abort();
      } else {
        for (let count = 0; count < 15; count++) await f.turn();
      }
      await f.stopStarted(1);
      expect(budget.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(f.closeFiles).not.toHaveBeenCalled();
      p.release.resolve();
      expect(await result).toMatchObject({
        error: {
          code: reason === "cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED",
        },
      });
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.sleepers.size).toBe(0);
      const calls = p.network.mock.calls.length;
      f.clock.advance(6000);
      await Promise.resolve();
      expect(p.network).toHaveBeenCalledTimes(calls);
    } finally {
      p.release.resolve();
      await result;
      await f.close();
    }
  }),
);

it.each(["submit", "start", "waitForAttempt"] as const)(
  "stops and joins when %s throws",
  owned(async (method) => {
    const f = await fixture();
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new Error("Unexpected synthetic provider"));
    vi.spyOn(JobService.prototype, method).mockRejectedValueOnce(
      new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Synthetic lifecycle failure",
      ),
    );
    try {
      expect(await f.runtime.execute(f.input, f.parent.signal)).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(f.stops).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
      const turns = f.turns.mock.calls.length;
      const calls = network.mock.calls.length;
      f.clock.advance(6000);
      await Promise.resolve();
      expect(f.turns).toHaveBeenCalledTimes(turns);
      expect(network).toHaveBeenCalledTimes(calls);
      expect(f.claim.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
    }
  }),
);
it(
  "retires a failed initial scheduler observer and joins before returning",
  owned(async () => {
    const f = await fixture();
    let observer: AbortSignal | undefined;
    vi.spyOn(f.store.jobs, "scan").mockImplementationOnce(
      async (_input, context) => {
        observer = context.signal;
        return fakeFailure(context, "PROVIDER_UNAVAILABLE");
      },
    );
    try {
      expect(await f.runtime.execute(f.input, f.parent.signal)).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(observer?.aborted).toBe(true);
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.stops).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
    } finally {
      await f.close();
    }
  }),
);

it(
  "retains the service and primary failure when bounded stop cannot join",
  owned(async () => {
    const f = await fixture();
    const p = provider();
    f.wait.mockImplementationOnce(async () => {
      await f.awaitEvent(p.entered.promise);
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Synthetic wait failure",
      );
    });
    const result = f.runtime.execute(f.input, f.parent.signal);
    try {
      await f.awaitEvent(p.entered.promise);
      await f.stopStarted(1);
      await f.stopTimer();
      f.clock.advance(5000);
      expect(await result).toMatchObject({
        status: "interrupted",
        error: { code: "INTERRUPTED" },
      });
      await expect(
        f.runtime.execute(f.input, new AbortController().signal),
      ).rejects.toThrow("FORBIDDEN");
      const closing = f.runtime.close().catch((error: unknown) => error);
      await f.stopStarted(2);
      await f.stopTimer();
      f.clock.advance(5000);
      expect(await closing).toMatchObject({
        operationCode: "PROVIDER_UNAVAILABLE",
        cleanupCode: "INTERRUPTED",
      } satisfies Partial<NativeCaptureCleanupRequired>);
      expect(f.closeFiles).not.toHaveBeenCalled();
      p.release.resolve();
      await f.runtime.close();
      expect(f.closeFiles).toHaveBeenCalledTimes(1);
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
    } finally {
      p.release.resolve();
      await result;
      await f.close();
    }
  }),
);

it(
  "fails closed when serialized finalization itself outlives the lease",
  owned(async () => {
    const f = await fixture();
    const p = provider();
    const entered = deferred<void>();
    const release = gate();
    f.commit.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return f.commitJob(...args);
    });
    const result = f.runtime.execute(f.input, f.parent.signal);
    try {
      await f.awaitEvent(p.entered.promise);
      p.release.resolve();
      await f.awaitEvent(entered.promise);
      await f.readyTurn(100);
      let pulseSettled = false;
      void f.turns.mock.results.at(-1)?.value.then(() => {
        pulseSettled = true;
      });
      await Promise.resolve();
      expect(pulseSettled).toBe(false);
      f.clock.advance(5900);
      release.resolve();
      expect(await result).toMatchObject({
        status: "interrupted",
        error: { code: "CONFLICT" },
        value: { jobStatus: "interrupted" },
      });
      expect(f.claim).toHaveBeenCalledTimes(1);
      expect(f.commit).toHaveBeenCalledTimes(1);
      expect(f.stops).toHaveBeenCalledTimes(1);
      expect(f.sleepers.size).toBe(0);
    } finally {
      p.release.resolve();
      release.resolve();
      await result;
      await f.close();
    }
  }),
);

it(
  "retires exact aborted grants/listeners while retaining the 128-live-authority cap",
  owned(async () => {
    const f = await fixture();
    const held = new AbortController();
    const issue = (signal: AbortSignal, parentSignal?: AbortSignal) =>
      f.policy.issue({
        jobId: "synthetic_authority",
        requestId: "synthetic_authority",
        signal,
        ...(parentSignal ? { parentSignal } : {}),
      });
    try {
      const active = await issue(held.signal);
      for (let index = 0; index < 140; index++) {
        const own = new AbortController();
        const parent = new AbortController();
        const observer = await issue(own.signal, parent.signal);
        expect(observer.signal).toBe(own.signal);
        (index % 2 ? own : parent).abort();
        expect(f.policy.verify(observer.authorization)).toBe(false);
        expect(f.policy.verify(active.authorization)).toBe(true);
        expect(getEventListeners(own.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      }
      const controllers = Array.from(
        { length: 127 },
        () => new AbortController(),
      );
      for (const controller of controllers) await issue(controller.signal);
      await expect(issue(new AbortController().signal)).rejects.toMatchObject({
        code: "ACTION_REQUIRED",
      });
      controllers[0]?.abort();
      expect(await issue(new AbortController().signal)).toMatchObject({
        deadline: new Date(f.clock.now() + 30000).toISOString(),
      });
      expect(f.policy.verify(active.authorization)).toBe(true);
    } finally {
      await f.close();
      expect(getEventListeners(held.signal, "abort")).toHaveLength(0);
    }
  }),
);
