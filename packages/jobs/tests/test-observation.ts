import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";

export const OBSERVATION_LIMITS = Object.freeze({
  samples: 90,
  records: 128,
  bytes: 65536,
  recordBytes: 2048,
});
const cases = {
  "renews the unchanged lease for a 28000 ms provider at 100 ms turns and stops before returning":
    "scheduler-turns",
  "fails closed when serialized finalization itself outlives the lease":
    "scheduler-finalization",
  "retires exact aborted grants/listeners while retaining the 128-live-authority cap":
    "scheduler-authorities",
  "read-only conversion diagnostics preserve denial and read ownership: cleanup":
    "reference-cleanup",
  "commits immutable rate-limit evidence through real jobs/SQLite and enforces cooldown after restart":
    "persistence",
  "partial stage receipt survives unavailable journal refresh and cannot complete":
    "stage-refresh",
  "cap 1: retained slots survive interruption and a competing scheduler":
    "jobs-cap1",
  "cap 4: retained slots survive interruption and a competing scheduler":
    "jobs-cap4",
  "restart never treats an expired lease as proof of stopped execution":
    "jobs-restart",
  "queued and safely waiting jobs respect their original absolute deadline":
    "jobs-deadline",
  "bounded stop retains an uncooperative callback and its slot until actual return":
    "jobs-stop",
  "stop during admission cannot launch a callback after stop has returned":
    "jobs-admission",
  "a hung issuer has a finite allowance and cannot launch after its late reply":
    "jobs-issuer",
  "explicit current-policy resume retains logical identity and original limits":
    "jobs-resume",
  "wait cancellation does not cancel durable work or leak mutable private views":
    "jobs-wait",
} as const;
const phases = [
  "setup",
  "root-open",
  "fixture-open",
  "store-open",
  "body",
  "provider",
  "turns",
  "finalization",
  "authorities",
  "seed",
  "submit",
  "run-once",
  "attempt-wait",
  "restart",
  "cooldown",
  "assertions",
  "scope-join",
  "runtime-close",
  "service-stop",
  "queue-join",
  "store-close",
  "filesystem-close",
  "root-delete",
  "mock-reset",
  "capture",
  "reference-operation",
  "cleanup",
  "scheduler-scope-join",
  "support-scope-join",
  "fake-clock-wait",
] as const;
type Phase = (typeof phases)[number];
const counterKeys = [
  "pendingBodies",
  "sleepers",
  "cadenceSleeps",
  "stopSleeps",
  "deadlineSleeps",
  "abortedSleeps",
  "turns",
  "heartbeats",
  "starts",
  "stops",
  "activeJobs",
  "pendingAuthorities",
  "stores",
  "activeStoreOperations",
  "queueSequence",
  "schedulerPending",
  "supportPending",
  "priorSchedulerPending",
  "priorSupportPending",
  "cleanupEntries",
  "schedulerOwnerMatches",
  "schedulerAborted",
  "supportAborted",
  "submitIndex",
  "completedSubmits",
] as const;
export type ObservationCounters = Partial<
  Record<(typeof counterKeys)[number], number | null>
>;
const sampleKeys = [
  "cpuUserMicros",
  "cpuSystemMicros",
  "rssBytes",
  "heapUsedBytes",
  "fsReadOperations",
  "fsWriteOperations",
  "eventLoopMeanMicros",
  "eventLoopMaxMicros",
  "eventLoopP99Micros",
  "eventLoopSamples",
] as const;
type Sample = Record<(typeof sampleKeys)[number], number>;
export interface ObservationSource {
  monotonic(): number;
  wall(): number;
  sample(): Sample;
  start(tick: () => void): void;
  stopSampling(): void;
  release(): void;
  write(line: string): void;
}
export interface TestObservation {
  phase(phase: Phase): void;
  counters(read: () => ObservationCounters): void;
  unresolved(): void;
  closed(): void;
  pending(): () => void;
}
const inert: TestObservation = Object.freeze({
  phase() {},
  counters() {},
  unresolved() {},
  closed() {},
  pending: () => () => {},
});
function source(): ObservationSource {
  const cpu = process.cpuUsage();
  const usage = process.resourceUsage();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopSampling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  return {
    monotonic: () => performance.timeOrigin + performance.now(),
    wall: Date.now,
    sample() {
      const delta = process.cpuUsage(cpu);
      const current = process.resourceUsage();
      const memory = process.memoryUsage();
      const micros = (value: number) =>
        Number.isFinite(value) ? Math.round(value / 1000) : 0;
      return {
        cpuUserMicros: delta.user,
        cpuSystemMicros: delta.system,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        fsReadOperations: current.fsRead - usage.fsRead,
        fsWriteOperations: current.fsWrite - usage.fsWrite,
        eventLoopMeanMicros: micros(delay.mean),
        eventLoopMaxMicros: micros(delay.max),
        eventLoopP99Micros: micros(delay.percentile(99)),
        eventLoopSamples: delay.count,
      };
    },
    start(tick) {
      delay.enable();
      timer = setInterval(tick, 1000);
      timer.unref();
    },
    stopSampling,
    release() {
      stopSampling();
      delay.disable();
    },
    write(line) {
      console.log(line.trimEnd());
    },
  };
}
function numericFields(
  value: object,
  allowed: readonly string[],
  required = false,
) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).some((key) => !allowed.includes(key)) ||
    (required && allowed.some((key) => !Object.hasOwn(descriptors, key)))
  )
    throw new Error("Invalid closed observation fields");
  const result: Record<string, number | null> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !required &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === null
    ) {
      result[key] = null;
      continue;
    }
    if (
      !Object.hasOwn(descriptor, "value") ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    )
      throw new Error("Invalid numeric observation");
    result[key] = descriptor.value;
  }
  return result;
}

/** Test-only, non-awaited observability. Failures never replace the original test outcome. */
export function observeSelectedTest(
  name: string,
  signal: AbortSignal,
  createSource: () => ObservationSource = source,
): TestObservation {
  if (!Object.hasOwn(cases, name)) return inert;
  const caseId = cases[name as keyof typeof cases];
  let input: ObservationSource;
  try {
    input = createSource();
  } catch {
    try {
      console.log(
        JSON.stringify({
          scope: "closed-test-observation",
          caseId,
          event: "observer-unavailable",
        }),
      );
    } catch {
      /* No observer failure may replace the original test failure. */
    }
    return inert;
  }
  let phase: Phase = "setup",
    ended = false,
    capped = false,
    fault = false;
  let samples = 0,
    records = 0,
    bytes = 0,
    dropped = 0,
    observerMicros = 0;
  let pendingWork = 0,
    ownersClosed = false,
    resourcesClosed = false;
  let measurementFaults = 0,
    sinkFaults = 0,
    resourceFaults = 0;
  let counters = (): ObservationCounters => ({});
  const terminal = new Set<string>();
  const safe = (action: () => void, resource = false) => {
    try {
      action();
      return true;
    } catch {
      fault = true;
      if (resource)
        resourceFaults = Math.min(resourceFaults + 1, Number.MAX_SAFE_INTEGER);
      else
        measurementFaults = Math.min(
          measurementFaults + 1,
          Number.MAX_SAFE_INTEGER,
        );
      return false;
    }
  };
  let origin = 0;
  safe(() => {
    origin = input.monotonic();
  });
  const stamp = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
      throw new Error("Invalid observation timestamp");
    return Math.round(value);
  };
  function emit(
    event:
      | "phase"
      | "sample"
      | "armed"
      | "abort"
      | "cap"
      | "unresolved"
      | "closed",
    reserved = false,
  ) {
    if (ended || (reserved && terminal.has(event))) return;
    if (!reserved && capped) {
      dropped = Math.min(dropped + 1, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (reserved) terminal.add(event);
    let started = 0;
    safe(() => {
      started = input.monotonic();
    });
    const data: Record<string, number | null> = {};
    const metricsAvailable = safe(() => {
      Object.assign(data, numericFields(input.sample(), sampleKeys, true));
    });
    const countersAvailable = safe(() => {
      Object.assign(data, numericFields(counters(), counterKeys));
    });
    safe(() => {
      const monotonicMs = stamp(input.monotonic());
      const record = {
        scope: "closed-test-observation",
        caseId,
        phase,
        event,
        sequence: records,
        monotonicMs,
        wallMs: stamp(input.wall()),
        elapsedMs: stamp(Math.max(0, monotonicMs - origin)),
        aborted: signal.aborted,
        settled: event === "closed",
        sampleCapReached: samples >= OBSERVATION_LIMITS.samples,
        outputCapReached: capped,
        dropped,
        observerFault: fault,
        measurementFaults,
        sinkFaults,
        resourceFaults,
        metricsAvailable,
        countersAvailable,
        unavailableCounters: Object.values(data).filter(
          (value) => value === null,
        ).length,
        observerResourcesClosed: resourcesClosed,
        observerMicros,
        pendingObservedWork: pendingWork,
        ...data,
      };
      const line = `${JSON.stringify(record)}\n`;
      const length = Buffer.byteLength(line);
      const reserveRecords = 4;
      const reserveBytes = reserveRecords * OBSERVATION_LIMITS.recordBytes;
      if (length > OBSERVATION_LIMITS.recordBytes) {
        fault = true;
        return;
      }
      if (
        !reserved &&
        (records >= OBSERVATION_LIMITS.records - reserveRecords ||
          bytes + length > OBSERVATION_LIMITS.bytes - reserveBytes)
      ) {
        capped = true;
        dropped++;
        emit("cap", true);
        return;
      }
      if (
        records >= OBSERVATION_LIMITS.records ||
        bytes + length > OBSERVATION_LIMITS.bytes
      ) {
        fault = true;
        return;
      }
      records++;
      bytes += length;
      try {
        input.write(line);
      } catch {
        fault = true;
        sinkFaults = Math.min(sinkFaults + 1, Number.MAX_SAFE_INTEGER);
      }
    });
    safe(() => {
      observerMicros = Math.min(
        Number.MAX_SAFE_INTEGER,
        observerMicros +
          Math.max(0, Math.round((input.monotonic() - started) * 1000)),
      );
    });
  }
  const abort = () => emit("abort", true);
  signal.addEventListener("abort", abort, { once: true });
  emit("armed");
  if (signal.aborted) abort();
  safe(
    () =>
      input.start(() => {
        if (ended || samples >= OBSERVATION_LIMITS.samples) return;
        samples++;
        emit("sample");
        if (samples === OBSERVATION_LIMITS.samples) {
          emit("cap", true);
          safe(() => input.stopSampling(), true);
        }
      }),
    true,
  );
  const finish = () => {
    if (ended) return;
    if (pendingWork) {
      emit("unresolved", true);
      return;
    }
    const released = safe(() => input.release(), true);
    const detached = safe(
      () => signal.removeEventListener("abort", abort),
      true,
    );
    resourcesClosed = released && detached;
    if (!resourcesClosed) {
      emit("unresolved", true);
      return;
    }
    emit("closed", true);
    ended = true;
    counters = () => ({});
  };
  return {
    phase(value) {
      if (ended) return;
      if (!phases.includes(value)) {
        fault = true;
        return;
      }
      phase = value;
      emit("phase");
    },
    counters(read) {
      if (!ended) counters = read;
    },
    unresolved() {
      emit("unresolved", true);
    },
    closed() {
      if (ended) return;
      ownersClosed = true;
      finish();
    },
    pending() {
      if (ended || ownersClosed) return () => {};
      pendingWork++;
      let settled = false;
      return () => {
        if (settled || ended) return;
        settled = true;
        pendingWork--;
        if (ownersClosed) finish();
      };
    },
  };
}
