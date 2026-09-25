import { execFile } from "node:child_process";
import { onTestFinished } from "vitest";
import { ownedTest } from "./support.js";

interface ProbeOptions {
  signal: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}
export function startProbe(args: string[], options: ProbeOptions) {
  options.signal.throwIfAborted();
  let complete!: (value: {
    error: Error | null;
    stdout: string;
    stderr: string;
  }) => void;
  const result = new Promise<Parameters<typeof complete>[0]>((resolve) => {
    complete = resolve;
  });
  const child = execFile(
    process.execPath,
    args,
    {
      timeout: 10000,
      maxBuffer: 16384,
      ...options,
      encoding: "utf8",
      windowsHide: true,
    },
    (error, stdout, stderr) => complete({ error, stdout, stderr }),
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const finished = (async () => {
    const outcome = await result;
    // execFile can report abort before the OS process and its pipes have closed.
    await closed;
    if (outcome.error) throw outcome.error;
    return { stdout: outcome.stdout, stderr: outcome.stderr };
  })();
  return { child, finished };
}

type RunProbe = (
  args: string[],
  options?: Omit<ProbeOptions, "signal">,
) => Promise<{ stdout: string; stderr: string }>;

type FixturePhase =
  | "fixture-root"
  | "sourceverify-before"
  | "oldwriter"
  | "sourceverify-after"
  | "snapshot-before"
  | "handoff"
  | "newreader"
  | "snapshot-after"
  | "cleanup";
type FixtureMode =
  | "complete"
  | "postcommit-deadline"
  | "partial-stage"
  | "ineligible-job"
  | "unknown-stage"
  | "history-coexistence"
  | "output-tamper"
  | "ownership-regression";
interface PhaseEvent {
  scope: "owned-crossrelease-fixture";
  mode: FixtureMode;
  phase: FixturePhase;
  event: "start" | "settled" | "failed" | "runner-abort" | "owner-closed";
  elapsedMs: number;
  phaseMs: number;
  aborted: boolean;
}
type MeasurePhase = <T>(
  phase: FixturePhase,
  work: () => Promise<T>,
) => Promise<T>;

/** A fresh root spans independent setup and reader phases, never their timeout wrappers. */
export function prepareOwnedProbeFixture<T>(
  mode: FixtureMode,
  signal: AbortSignal,
  prepare: (root: string, run: RunProbe, phase: MeasurePhase) => Promise<T>,
  emit: (event: PhaseEvent) => void = (event) =>
    console.log(JSON.stringify(event)),
) {
  const children = new Set<ReturnType<typeof startProbe>>();
  const stopped = new Set<ReturnType<typeof startProbe>>();
  const stopErrors: unknown[] = [];
  const bodies = new Set<Promise<unknown>>();
  let closing = false;
  let transferred = false;
  let bodyStarted = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A setup timeout may be reported before a late allocation settles.
  void ready.catch(() => {});
  const origin = performance.now();
  let started = origin;
  let current: FixturePhase = "fixture-root";
  const report = (event: PhaseEvent["event"]) =>
    emit({
      scope: "owned-crossrelease-fixture",
      mode,
      phase: current,
      event,
      elapsedMs: Math.round(performance.now() - origin),
      phaseMs: Math.round(performance.now() - started),
      aborted: signal.aborted,
    });
  const begin = (name: FixturePhase) => {
    current = name;
    started = performance.now();
    report("start");
  };
  const phase: MeasurePhase = async (name, action) => {
    signal.throwIfAborted();
    if (closing) throw new Error("Synthetic fixture is closing");
    begin(name);
    try {
      const value = await action();
      report("settled");
      return value;
    } catch (error) {
      report("failed");
      throw error;
    }
  };
  const run: RunProbe = (args, options = {}) => {
    signal.throwIfAborted();
    if (closing) throw new Error("Synthetic fixture is closing");
    const probe = startProbe(args, { ...options, signal });
    children.add(probe);
    void probe.finished.then(
      () => children.delete(probe),
      () => children.delete(probe),
    );
    return probe.finished;
  };
  const stopChildren = () => {
    for (const probe of children) {
      if (stopped.has(probe)) continue;
      stopped.add(probe);
      if (probe.child.exitCode === null && probe.child.signalCode === null) {
        try {
          probe.child.kill();
        } catch (error) {
          stopErrors.push(error);
        }
      }
    }
  };
  const abort = () => {
    report("runner-abort");
    closing = true;
    release();
  };
  signal.addEventListener("abort", abort, { once: true });
  report("start");
  if (signal.aborted) abort();
  const original = ownedTest(async (root) => {
    const failures: unknown[] = [];
    report("settled");
    try {
      signal.throwIfAborted();
      if (closing) throw new Error("Synthetic fixture is closing");
      const value = await prepare(root, run, phase);
      signal.throwIfAborted();
      if (closing) throw new Error("Synthetic fixture is closing");
      if (children.size)
        throw new Error("Writer must close before fixture handoff");
      transferred = true;
      begin("handoff");
      resolveReady(value);
      await released;
    } catch (error) {
      failures.push(error);
    } finally {
      closing = true;
      stopChildren();
      await Promise.allSettled([...bodies]);
      await Promise.allSettled([...children].map((probe) => probe.finished));
      begin("cleanup");
    }
    failures.push(...stopErrors);
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned fixture failed after joining closure",
      );
  });
  const finished = original.then(
    () => {
      report("settled");
      report("owner-closed");
      signal.removeEventListener("abort", abort);
    },
    (error: unknown) => {
      rejectReady(error);
      report("failed");
      signal.removeEventListener("abort", abort);
      throw error;
    },
  );
  void finished.catch(() => {});
  return {
    ready,
    use(
      bodySignal: AbortSignal,
      work: (value: T, run: RunProbe, phase: MeasurePhase) => Promise<void>,
    ) {
      if (bodySignal !== signal || closing || !transferred || bodyStarted)
        throw new Error("Synthetic fixture handoff is not current");
      signal.throwIfAborted();
      bodyStarted = true;
      const body = Promise.resolve().then(async () => {
        const value = await ready;
        signal.throwIfAborted();
        if (closing) throw new Error("Synthetic fixture is closing");
        await work(value, run, phase);
      });
      bodies.add(body);
      void body.then(
        () => bodies.delete(body),
        () => bodies.delete(body),
      );
      return body;
    },
    close() {
      closing = true;
      stopChildren();
      release();
      return finished;
    },
  };
}

export function withOwnedProbe(
  signal: AbortSignal,
  work: (root: string, run: RunProbe) => Promise<void>,
) {
  const pending = ownedTest(async (root) => {
    const children = new Set<ReturnType<typeof startProbe>>();
    const run: RunProbe = (args, options = {}) => {
      const probe = startProbe(args, { ...options, signal });
      children.add(probe);
      void probe.finished.then(
        () => children.delete(probe),
        () => children.delete(probe),
      );
      return probe.finished;
    };
    try {
      signal.throwIfAborted();
      await work(root, run);
    } finally {
      // Only these exact owned child processes, never a process-name kill.
      for (const probe of children) probe.child.kill();
      await Promise.allSettled([...children].map((probe) => probe.finished));
    }
  });
  // The caller receives the original failure; this hook only joins ownership after timeout.
  onTestFinished(() =>
    pending.then(
      () => undefined,
      () => undefined,
    ),
  );
  return pending;
}
