import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const koffi = createRequire(
  new URL("../../project-host/package.json", import.meta.url),
)("koffi");
const kernel = koffi.load("kernel32.dll");
const open = kernel.func(
  "uintptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)",
);
const wait = kernel.func(
  "uint32_t __stdcall WaitForSingleObject(uintptr_t, uint32_t)",
);
const times = kernel.func(
  "int __stdcall GetProcessTimes(uintptr_t, _Out_ void *, _Out_ void *, _Out_ void *, _Out_ void *)",
);
const close = kernel.func("int __stdcall CloseHandle(uintptr_t)");
const lastError = kernel.func("uint32_t __stdcall GetLastError()");
export async function waitForReportedExit(pid, timeOrigin) {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid === process.pid ||
    !Number.isFinite(timeOrigin)
  )
    throw new Error("Invalid owned process observation.");
  const handle = open(0x101000, 0, pid);
  if (!handle) {
    if (lastError() === 87) return;
    throw new Error("Owned process observation unavailable.");
  }
  let primary;
  try {
    const buffers = Array.from({ length: 4 }, () => Buffer.alloc(8));
    if (!times(handle, ...buffers))
      throw new Error("Owned process birth-time observation failed.");
    const born = Number(
      buffers[0].readBigUInt64LE() / 10000n - 11644473600000n,
    );
    if (Math.abs(born - timeOrigin) > 2000)
      throw new Error("Recorded PID identity changed.");
    const deadline = performance.now() + 60000;
    let observed = false;
    while (performance.now() < deadline) {
      const state = wait(handle, 0);
      if (state === 0) {
        observed = true;
        break;
      }
      if (state !== 258) throw new Error("Owned process wait failed.");
      await delay(25);
    }
    if (!observed) throw new Error("Owned process exit was not observed.");
  } catch (error) {
    primary = error;
  }
  if (!close(handle)) {
    const failure = new Error("Owned process observation handle close failed.");
    if (primary)
      throw new AggregateError(
        [primary, failure],
        "Owned process observation and release failed.",
        { cause: primary },
      );
    throw failure;
  }
  if (primary) throw primary;
}
