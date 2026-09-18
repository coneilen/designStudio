import { performance } from "node:perf_hooks";

const kinds = ["open", "inspect", "acl", "pin", "hash"];

// Wrap complete checked JS operations, never an FFI call before GetLastError.
export function nativeTimings(clock = () => performance.now()) {
  const groups = new Map();
  let samplingErrors = 0;
  const fault = () => {
    samplingErrors = Math.min(Number.MAX_SAFE_INTEGER, samplingErrors + 1);
  };
  const record = (kind, started) => {
    try {
      const durationMs = clock() - started;
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new Error("Invalid timing duration.");
      const group = groups.get(kind) ?? {
        kind,
        calls: 0,
        totalMs: 0,
        maxMs: 0,
      };
      group.calls++;
      group.totalMs += durationMs;
      group.maxMs = Math.max(group.maxMs, durationMs);
      groups.set(kind, group);
    } catch {
      fault();
    }
  };
  return {
    measure(kind, operation) {
      let started;
      try {
        if (!kinds.includes(kind)) throw new Error("Invalid timing kind.");
        started = clock();
      } catch {
        fault();
      }
      try {
        return operation();
      } finally {
        if (started !== undefined) record(kind, started);
      }
    },
    report() {
      return {
        samplingErrors,
        groups: [...groups.values()].map((group) => ({ ...group })),
      };
    },
  };
}

export const nativeCapture = nativeTimings();
