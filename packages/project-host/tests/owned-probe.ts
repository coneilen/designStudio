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
