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
  close(): void;
} {
  if (process.env.VITEST !== "true" || capture)
    throw new Error(
      "Installation diagnostics require an isolated test process.",
    );
  const owned: Capture = { samples: [], sampleHandles, next: 0, active: 0 };
  capture = owned;
  return {
    samples: owned.samples,
    close() {
      if (owned.active)
        throw new Error("Diagnostic checkpoints are still active.");
      if (capture === owned) capture = undefined;
    },
  };
}

export function traceInstallation(
  hashBytes: boolean,
): InstallationTrace | undefined {
  const owned = capture;
  if (!owned) return undefined;
  const id = ++owned.next;
  const started = performance.now();
  owned.active++;
  const emit = (phase: Phase, from: number, count = 0, success = 1) => {
    if (owned.samples.length >= 2048)
      throw new Error("Installation diagnostic sample bound exceeded.");
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
  };
  emit("start", started);
  return {
    time: () => performance.now(),
    phase: emit,
    end(success) {
      emit("end", started, 0, success ? 1 : 0);
      owned.active--;
    },
  };
}
