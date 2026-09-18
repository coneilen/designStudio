import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import koffi from "koffi";
import {
  registerFixtureInstallationGuards,
  verifyInstalledRoot,
} from "../../dist/installation.js";
import { captureInstallationForTest } from "../../dist/installation-diagnostics.js";
import { loadNative } from "../../dist/native.js";

const [root, installed, countText] = process.argv.slice(2);
const count = Number(countText);
if (
  !root ||
  !path.basename(root).startsWith("ds-ph-") ||
  !installed?.startsWith(`${root}${path.sep}`) ||
  ![1, 2].includes(count) ||
  process.env.VITEST !== "true"
)
  throw new Error(
    "Metadata diagnostic requires its exact owned synthetic namespace.",
  );
const native = await loadNative();
native.localAppData = () => root;
const kernel = koffi.load("kernel32.dll");
const current = kernel.func("uintptr_t __stdcall GetCurrentProcess()");
const query = kernel.func(
  "int __stdcall GetProcessHandleCount(uintptr_t, _Out_ void *)",
);
const handles = () => {
  const buffer = Buffer.alloc(4);
  if (!query(current(), buffer))
    throw new Error("Diagnostic handle snapshot failed.");
  return buffer.readUInt32LE();
};
const leases = [];
const guards = [];
const startup = performance.now();
for (let index = 0; index < count; index++) {
  const lease = await verifyInstalledRoot(installed);
  leases.push(lease);
  guards.push(registerFixtureInstallationGuards(lease));
}
process.send({
  kind: "ready",
  pinsets: leases.length,
  guards: guards.length,
  handles: handles(),
  startupMs: performance.now() - startup,
});
let busy = false;
process.on("message", async (message) => {
  if (busy) throw new Error("Diagnostic commands cannot overlap.");
  busy = true;
  try {
    if (message === "close") {
      for (const guard of guards.reverse()) guard.close();
      for (const lease of leases.reverse()) await lease.close();
      process.send({ kind: "closed", handles: handles() });
      process.disconnect();
      return;
    }
    const parallel = message === "serial" ? 1 : message === "pair" ? 2 : 0;
    if (!parallel) throw new Error("Unknown diagnostic case.");
    let previous = performance.now();
    let maxGapMs = 0;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - previous);
      previous = now;
      ticks++;
    }, 10);
    try {
      await delay(30);
      const capture = captureInstallationForTest(handles);
      const cpu = process.cpuUsage();
      const utilization = performance.eventLoopUtilization();
      const handlesBefore = handles();
      const started = performance.now();
      let durations;
      try {
        const outcomes = await Promise.allSettled(
          Array.from({ length: parallel }, async () => {
            const start = performance.now();
            await leases[0].checkCurrent();
            return performance.now() - start;
          }),
        );
        const failures = outcomes.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Diagnostic checkpoint batch failed.",
            { cause: failures[0].reason },
          );
        durations = outcomes.map((result) => {
          if (result.status !== "fulfilled")
            throw new Error("Unexpected unsettled diagnostic result.");
          return result.value;
        });
      } catch (primary) {
        try {
          capture.close();
        } catch (diagnostic) {
          throw new AggregateError(
            [primary, diagnostic],
            "Checkpoint and diagnostic capture failed.",
            { cause: primary },
          );
        }
        throw primary;
      }
      capture.close();
      const wallMs = performance.now() - started;
      const cpuDelta = process.cpuUsage(cpu);
      const elu = performance.eventLoopUtilization(utilization);
      await delay(30);
      clearInterval(heartbeat);
      process.send({
        kind: "result",
        parallel,
        durationsMs: durations,
        wallMs,
        maxHeartbeatGapMs: maxGapMs,
        maxHeartbeatLatenessMs: Math.max(0, maxGapMs - 10),
        ticks,
        cpuUserUs: cpuDelta.user,
        cpuSystemUs: cpuDelta.system,
        eventLoopActiveMs: elu.active,
        eventLoopIdleMs: elu.idle,
        handlesBefore,
        handlesAfter: handles(),
        rssBytes: process.memoryUsage.rss(),
        samples: capture.samples,
      });
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    process.send({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
});
