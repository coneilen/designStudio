import { ChildProcess, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { PatChannel, PatKind } from "../../host/dist/pat-channel.js";
import {
  collectWindowsPat,
  NativePatDialogError,
} from "../../host/dist/windows-pat-dialog.js";
import type { CaptureProject } from "../src/capture-project.js";
import { startCapturePatDialog } from "../src/pat-dialog-controller.js";
import { runPatDialogInput } from "../src/pat-dialog-input.js";
import { patMemoryPair } from "./pat-memory-pair.js";

const seam = vi.hoisted(() => ({
  project: undefined as object | undefined,
  helpers: 0,
  joined: false,
  exited: false,
  released: false,
  terminateCalls: 0,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: (delay: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delay)),
}));
vi.mock("../../host/dist/owned-job.js", () => ({
  loadJobs: async () => ({
    create: () => ({
      flags: () => 0x2008,
      members: () => (seam.joined && !seam.exited ? [4242] : []),
      terminate: () => {
        seam.terminateCalls++;
      },
      close: () => {
        if (!seam.exited) throw new Error("Synthetic owner still live");
        seam.released = true;
      },
    }),
  }),
}));
vi.mock("../src/capture-project.js", () => ({
  captureProjectOwner: (project: unknown) => {
    if (project !== seam.project) throw new Error("Foreign synthetic owner");
    return {
      get helpers() {
        return seam.helpers;
      },
      set helpers(value: number) {
        seam.helpers = value;
      },
      work: 0,
      installation: {
        checkCurrent: async () => {},
        paths: { node: "synthetic-node", dialogEntry: "synthetic-helper" },
      },
    };
  },
}));
vi.mock("../../host/dist/windows-pat-dialog.js", async (original) => ({
  ...(await original<typeof import("../../host/dist/windows-pat-dialog.js")>()),
  collectWindowsPat: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([
  "parent-first",
  "helper-first",
  "manual-near",
  "cleanup-failed",
  "abnormal-exit",
  "partial-eof",
  "missing-eof",
  "late-terminal-no-eof",
  "late-accepted",
  "hung-cleanup",
] as const)(
  "actual controller/helper deadline ordering without native/UI calls: %s",
  async (mode) => {
    expect(vi.isMockFunction(spawn)).toBe(true);
    expect(vi.isMockFunction(collectWindowsPat)).toBe(true);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1000);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    // Protocol-only module-owned fixture, not a native project admission proof.
    const project = { recheck: async () => {} } as CaptureProject;
    Object.assign(seam, {
      project,
      helpers: 0,
      joined: false,
      exited: false,
      released: false,
      terminateCalls: 0,
    });
    const pipes = patMemoryPair();
    if (mode === "missing-eof" || mode === "late-terminal-no-eof")
      pipes.child.endPeerOnDestroy = false;
    if (mode === "partial-eof") {
      const destroy = pipes.child.destroy.bind(pipes.child);
      vi.spyOn(pipes.child, "destroy").mockImplementation((error) => {
        if (!pipes.child.destroyed) pipes.parent.push(Buffer.alloc(12));
        return destroy(error);
      });
    }
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 4242 });
    Object.defineProperty(child, "stdio", {
      value: [null, null, null, pipes.parent],
    });
    vi.mocked(spawn).mockReturnValue(child);
    child.kill = () => {
      seam.terminateCalls++;
      return true;
    };
    const channel = new PatChannel(pipes.child);
    const returned: Buffer[] = [];
    let releaseHung: (() => void) | undefined;
    let cleaned = false;
    vi.mocked(collectWindowsPat).mockImplementation(
      (signal, deadline, ready) =>
        new Promise((resolve, reject) => {
          let finishing = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (code: "CANCELLED" | "DEADLINE_EXCEEDED") => {
            if (finishing) return;
            finishing = true;
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", cancelled);
            const settled = () => {
              cleaned = mode !== "cleanup-failed";
              if (mode === "late-accepted") {
                const bytes = Buffer.from("synthetic-late-input");
                returned.push(bytes);
                resolve(bytes);
              } else
                reject(
                  new NativePatDialogError(
                    code,
                    cleaned,
                    cleaned ? undefined : "window-destroy",
                  ),
                );
            };
            if (mode === "hung-cleanup") releaseHung = settled;
            else
              setTimeout(settled, mode === "late-terminal-no-eof" ? 4900 : 2);
          };
          const cancelled = () => finish("CANCELLED");
          signal.addEventListener("abort", cancelled, { once: true });
          timer = setTimeout(
            () => finish("DEADLINE_EXCEEDED"),
            Math.max(
              0,
              deadline - performance.now() - (mode === "helper-first" ? 1 : 0),
            ),
          );
          ready();
        }),
    );
    let inputDeadline = 0;
    const peer = (async () => {
      const init = await channel.read(5000);
      init.bytes.fill(0);
      seam.joined = true;
      await channel.send(PatKind.joined, 0);
      const start = await channel.read(5000);
      const duration = start.bytes.readUInt32BE();
      start.bytes.fill(0);
      expect(duration).toBe(300000);
      inputDeadline = performance.now() + duration;
      if (mode === "parent-first")
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const code = await runPatDialogInput(channel, duration);
      if (mode !== "hung-cleanup") {
        seam.exited = true;
        child.emit("close", mode === "abnormal-exit" ? 1 : code);
      }
      return code;
    })();
    const abort = new AbortController();
    const run = startCapturePatDialog(project, abort.signal);
    let delivered = false;
    let settledAt: number | undefined;
    const result = run.result.then(
      (bytes) => {
        settledAt = performance.now();
        delivered = true;
        bytes.fill(0);
        return undefined;
      },
      (error: unknown) => {
        settledAt = performance.now();
        return error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(inputDeadline).toBeGreaterThan(0);
      if (mode === "manual-near") {
        await vi.advanceTimersByTimeAsync(inputDeadline - 1 - Date.now());
        abort.abort();
      }
      const needsGrace = [
        "missing-eof",
        "hung-cleanup",
        "late-terminal-no-eof",
      ].includes(mode);
      await vi.advanceTimersByTimeAsync(
        inputDeadline +
          (mode === "late-terminal-no-eof" ? 5000 : needsGrace ? 5100 : 100) -
          Date.now(),
      );
      if (mode === "late-terminal-no-eof") {
        expect(settledAt).toBeDefined();
        expect(settledAt).toBeLessThanOrEqual(inputDeadline + 5000);
      }
      const error = await result;
      expect(delivered).toBe(false);
      if (["parent-first", "helper-first", "late-accepted"].includes(mode))
        expect(error).toMatchObject({ code: "DEADLINE_EXCEEDED" });
      else if (mode === "manual-near")
        expect(error).toMatchObject({ code: "CANCELLED" });
      else expect(error).toBeDefined();
      if (mode === "hung-cleanup") {
        expect(await run.close()).toMatchObject({
          closed: false,
          scrub: "unconfirmed",
        });
        expect(seam.helpers).toBe(1);
        expect(seam.released).toBe(false);
        expect(seam.terminateCalls).toBe(1);
        seam.exited = true;
        child.emit("close", 1);
        pipes.child.destroy();
        releaseHung?.();
        await peer;
      } else await peer;
      const good = [
        "parent-first",
        "helper-first",
        "manual-near",
        "late-accepted",
      ].includes(mode);
      expect(await run.close()).toMatchObject({
        closed: true,
        scrub: good ? "confirmed" : "unconfirmed",
      });
      expect(seam.helpers).toBe(0);
      expect(seam.released).toBe(true);
      if (good) {
        expect(cleaned).toBe(true);
        expect(seam.terminateCalls).toBe(0);
      }
      for (const bytes of returned)
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      seam.exited = true;
      child.emit("close", 1);
      releaseHung?.();
      pipes.parent.push(null);
      await vi.advanceTimersByTimeAsync(5001);
      await channel.close();
      await peer;
      await result;
      await run.close();
    }
  },
);
