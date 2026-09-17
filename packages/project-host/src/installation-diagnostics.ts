import { performance } from "node:perf_hooks";

type Phase =
  | "start"
  | "prepare"
  | "root-pin"
  | "enumeration"
  | "directory-pins"
  | "file-pins"
  | "identity"
  | "registration"
  | "ancestors"
  | "release"
  | "end";
export interface InstallationPhaseSample {
  id: number;
  mode: "current" | "rehash";
  phase: Phase;
  atMs: number;
  durationMs: number;
  count: number;
  active: number;
  success: number;
  handles: number;
  rssBytes: number;
  cpuUserUs: number;
  cpuSystemUs: number;
}
interface Capture {
  samples: InstallationPhaseSample[];
  sampleHandles: () => number;
  next: number;
  active: number;
  samplingErrors: number;
  overflowed: boolean;
  droppedSamples: number;
  firstError: unknown;
}
let capture: Capture | undefined;
export interface InstallationTrace {
  time(): number;
  phase(phase: Phase, started: number, count?: number): void;
  end(success: boolean): void;
}

/** Internal diagnostic seam; no package export or production configuration. */
export function captureInstallationForTest(sampleHandles: () => number): {
  samples: InstallationPhaseSample[];
  readonly failure: {
    samplingErrors: number;
    overflowed: boolean;
    droppedSamples: number;
  };
  close(): void;
} {
  if (process.env.VITEST !== "true" || capture)
    throw new Error(
      "Installation diagnostics require an isolated test process.",
    );
  const owned: Capture = {
    samples: [],
    sampleHandles,
    next: 0,
    active: 0,
    samplingErrors: 0,
    overflowed: false,
    droppedSamples: 0,
    firstError: undefined,
  };
  capture = owned;
  return {
    samples: owned.samples,
    get failure() {
      return Object.freeze({
        samplingErrors: owned.samplingErrors,
        overflowed: owned.overflowed,
        droppedSamples: owned.droppedSamples,
      });
    },
    close() {
      if (owned.active)
        throw new Error("Diagnostic checkpoints are still active.");
      if (capture === owned) capture = undefined;
      if (owned.samplingErrors || owned.overflowed)
        throw new Error(
          `Installation diagnostic capture failed (sampling errors: ${owned.samplingErrors}, overflow: ${Number(owned.overflowed)}, dropped samples: ${owned.droppedSamples}).`,
          { cause: owned.firstError },
        );
    },
  };
}

export function traceInstallation(
  hashBytes: boolean,
): InstallationTrace | undefined {
  const owned = capture;
  if (!owned) return undefined;
  const id = ++owned.next;
  const fault = (error: unknown) => {
    if (!owned.samplingErrors) owned.firstError = error;
    owned.samplingErrors = Math.min(
      Number.MAX_SAFE_INTEGER,
      owned.samplingErrors + 1,
    );
  };
  const time = () => {
    if (owned.samplingErrors) return 0;
    try {
      return performance.now();
    } catch (error) {
      fault(error);
      return 0;
    }
  };
  const started = time();
  owned.active++;
  let ended = false;
  const emit = (phase: Phase, from: number, count = 0, success = 1) => {
    if (ended) return;
    if (owned.samples.length >= 2048) owned.overflowed = true;
    if (owned.overflowed || owned.samplingErrors) {
      owned.droppedSamples = Math.min(
        Number.MAX_SAFE_INTEGER,
        owned.droppedSamples + 1,
      );
      return;
    }
    try {
      const atMs = performance.now();
      const cpu = process.cpuUsage();
      owned.samples.push({
        id,
        mode: hashBytes ? "rehash" : "current",
        phase,
        atMs,
        durationMs: atMs - from,
        count,
        active: owned.active,
        success,
        handles: owned.sampleHandles(),
        rssBytes: process.memoryUsage.rss(),
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
      });
    } catch (error) {
      fault(error);
      owned.droppedSamples = Math.min(
        Number.MAX_SAFE_INTEGER,
        owned.droppedSamples + 1,
      );
    }
  };
  emit("start", started);
  return {
    time,
    phase: emit,
    end(success) {
      if (ended) return;
      try {
        emit("end", started, 0, success ? 1 : 0);
      } finally {
        ended = true;
        owned.active--;
      }
    },
  };
}
