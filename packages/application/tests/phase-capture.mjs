import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import koffi from "koffi";
import { nativeCapture } from "./f08-native-timing.mjs";
import { captureInstallationForTest } from "./installation-diagnostics.js";

const directory = "__F08_DIAGNOSTIC_DIRECTORY__";
const original = lstatSync(directory, { bigint: true });
if (
  !original.isDirectory() ||
  original.isSymbolicLink() ||
  realpathSync(directory) !== directory
)
  throw new Error("Invalid owned diagnostic directory.");
const instance = import.meta.url.includes("/bootstrap/")
  ? 1
  : import.meta.url.includes("/payload/")
    ? 2
    : 0;
if (!instance)
  throw new Error("Diagnostic collector requires a sealed test candidate.");
writeFileSync(
  path.join(directory, `${process.pid}-${instance}.start.json`),
  JSON.stringify({
    pid: process.pid,
    instance,
    timeOrigin: performance.timeOrigin,
  }),
  { flag: "wx" },
);
const role = process.argv.includes("serve")
  ? 1
  : process.argv.includes("--session-fd")
    ? 2
    : process.argv[1]?.endsWith("bootstrap.mjs")
      ? 4
      : 3;
const kernel = koffi.load("kernel32.dll");
const current = kernel.func("uintptr_t __stdcall GetCurrentProcess()");
const query = kernel.func(
  "int __stdcall GetProcessHandleCount(uintptr_t, _Out_ void *)",
);
const sampleHandles = () => {
  const bytes = Buffer.alloc(4);
  if (!query(current(), bytes))
    throw new Error("Diagnostic handle sample failed.");
  return bytes.readUInt32LE();
};
const previousVitest = process.env.VITEST;
process.env.VITEST = "true";
const capture = captureInstallationForTest(sampleHandles);
if (previousVitest === undefined) delete process.env.VITEST;
else process.env.VITEST = previousVitest;
let previous = performance.now();
let maxGap = 0;
let ticks = 0;
let done = false;
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - previous);
  previous = now;
  ticks++;
}, 10);
heartbeat.unref();
const records = [];
const marker = Symbol.for("design-studio-owned-phase-test");
globalThis[marker] ??= new Map();
const markers = globalThis[marker];
markers.set(instance, (kind) => {
  if (
    records.length < 32 &&
    [
      "claimed",
      "worker-open",
      "worker-opened",
      "worker-failed",
      "verify-start",
      "verify-end",
      "verify-failed",
    ].includes(kind)
  )
    records.push({ kind, atMs: performance.now() });
});
function finish(exitFallback) {
  if (done) return;
  done = true;
  clearInterval(heartbeat);
  maxGap = Math.max(maxGap, performance.now() - previous);
  let incomplete = false;
  try {
    capture.close();
  } catch {
    incomplete = true;
  }
  const failure = capture.failure;
  const native = nativeCapture.report();
  incomplete ||=
    failure.samplingErrors !== 0 ||
    failure.overflowed ||
    failure.droppedSamples !== 0 ||
    native.samplingErrors !== 0;
  const groups = new Map();
  const ends = [];
  const starts = new Map();
  const previousSamples = new Map();
  for (const sample of capture.samples) {
    if (sample.phase === "start") starts.set(sample.id, sample);
    const previous =
      (sample.phase === "end"
        ? starts.get(sample.id)
        : previousSamples.get(sample.id)) ?? sample;
    previousSamples.set(sample.id, sample);
    const key = `${sample.mode}:${sample.phase}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        mode: sample.mode,
        phase: sample.phase,
        calls: 0,
        totalMs: 0,
        maxMs: 0,
        count: 0,
        activeMax: 0,
        handlesMax: 0,
        rssBytesMax: 0,
        cpuUserUs: 0,
        cpuSystemUs: 0,
      };
      groups.set(key, group);
    }
    group.calls++;
    group.totalMs += sample.durationMs;
    group.maxMs = Math.max(group.maxMs, sample.durationMs);
    group.count = Math.max(group.count, sample.count);
    group.activeMax = Math.max(group.activeMax, sample.active);
    group.handlesMax = Math.max(group.handlesMax, sample.handles);
    group.rssBytesMax = Math.max(group.rssBytesMax, sample.rssBytes);
    group.cpuUserUs += sample.cpuUserUs - previous.cpuUserUs;
    group.cpuSystemUs += sample.cpuSystemUs - previous.cpuSystemUs;
    if (sample.phase === "end")
      ends.push({
        id: sample.id,
        mode: sample.mode,
        durationMs: sample.durationMs,
        success: sample.success,
      });
  }
  const output = {
    version: 2,
    timeOrigin: performance.timeOrigin,
    pid: process.pid,
    instance,
    role,
    incomplete: Number(incomplete),
    exitFallback: Number(exitFallback),
    samplingErrors: failure.samplingErrors,
    droppedSamples: failure.droppedSamples,
    samples: capture.samples.length,
    maxGapMs: maxGap,
    ticks,
    groups: [...groups.values()],
    ends: ends.slice(-16),
    records,
    native,
  };
  try {
    const now = lstatSync(directory, { bigint: true });
    if (
      now.dev !== original.dev ||
      now.ino !== original.ino ||
      now.isSymbolicLink() ||
      !now.isDirectory() ||
      realpathSync(directory) !== directory
    )
      throw new Error("Diagnostic directory changed.");
    const target = path.join(directory, `${process.pid}-${instance}.json`);
    if (path.dirname(target) !== directory)
      throw new Error("Diagnostic destination escaped.");
    const bytes = Buffer.from(JSON.stringify(output));
    if (bytes.length > 16384) throw new Error("Diagnostic capture limit.");
    writeFileSync(target, bytes, { flag: "wx" });
  } catch {
    // Fixed signal only. Parent treats missing report as diagnostic failure.
    process.stderr.write("F08_TEST_DIAGNOSTIC_WRITE_FAILED\n");
  }
}
process.once("beforeExit", () => finish(false));
process.once("exit", () => finish(true));
