import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { HostBoundaryError } from "../../host/dist/guards.js";
import { PatChannel, PatKind } from "../../host/dist/pat-channel.js";
import {
  collectWindowsPat,
  NativePatDialogError,
} from "../../host/dist/windows-pat-dialog.js";
import { runPatDialogInput } from "../src/pat-dialog-input.js";
import { patMemoryPair } from "./pat-memory-pair.js";

vi.mock("../../host/dist/windows-pat-dialog.js", async (original) => ({
  ...(await original<typeof import("../../host/dist/windows-pat-dialog.js")>()),
  collectWindowsPat: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each(["legacy-fatal", "input-expiry", "send-failure"] as const)(
  "terminal transport at input expiry: %s",
  async (mode) => {
    expect(vi.isMockFunction(collectWindowsPat)).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1000);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const pipe = patMemoryPair();
    const parent = new PatChannel(pipe.parent, Buffer.alloc(32, 7));
    const child = new PatChannel(pipe.child, Buffer.alloc(32, 7));
    if (mode === "legacy-fatal")
      vi.spyOn(child, "readInput").mockImplementation((duration) =>
        child.read(duration),
      );
    if (mode === "send-failure") {
      const send = child.send.bind(child);
      vi.spyOn(child, "send").mockImplementation((kind, sequence, bytes) => {
        if (kind === PatKind.accepted)
          return Promise.reject(
            new HostBoundaryError(
              "TRANSPORT_UNAVAILABLE",
              "Synthetic write failure",
            ),
          );
        return send(kind, sequence, bytes);
      });
    }
    let cleaned = false;
    let returned: Buffer | undefined;
    vi.mocked(collectWindowsPat).mockImplementation(
      (signal, deadline, ready) =>
        new Promise((resolve, reject) => {
          if (mode === "send-failure") {
            ready();
            setTimeout(() => {
              cleaned = true;
              returned = Buffer.from("synthetic-write-failure");
              resolve(returned);
            }, 2);
            return;
          }
          let started = false;
          const teardown = () => {
            if (started) return;
            started = true;
            setTimeout(() => {
              cleaned = true;
              reject(new NativePatDialogError("DEADLINE_EXCEEDED", true));
            }, 2);
          };
          signal.addEventListener("abort", teardown, { once: true });
          setTimeout(teardown, Math.max(0, deadline - performance.now()));
          ready();
        }),
    );
    const session = runPatDialogInput(child, 20);
    const terminal: { kind: number; code: number }[] = [];
    const reading = (async () => {
      const ready = await parent.read(100);
      expect(ready.kind).toBe(PatKind.ready);
      ready.bytes.fill(0);
      for (let index = 0; index < 2; index++) {
        const frame = await parent.read(100);
        expect(cleaned).toBe(true);
        terminal.push({ kind: frame.kind, code: frame.bytes[0] ?? 0 });
        frame.bytes.fill(0);
      }
      await parent.finalizeReceive(100);
    })().catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(23);
      const code = await session;
      const received = await reading;
      if (mode === "legacy-fatal") {
        expect(received).toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
        expect(code).toBe(1);
        expect(terminal).toEqual([]);
        expect(child.receiveFailed).toBe(true);
      } else if (mode === "send-failure") {
        expect(received).toBeUndefined();
        expect(code).toBe(1);
        expect(terminal).toEqual([
          { kind: PatKind.error, code: 3 },
          { kind: PatKind.closed, code: 0 },
        ]);
        expect(returned?.every((byte) => byte === 0)).toBe(true);
      } else {
        expect(received).toBeUndefined();
        expect(code).toBe(0);
        expect(terminal).toEqual([
          { kind: PatKind.error, code: 2 },
          { kind: PatKind.closed, code: 3 },
        ]);
        expect(parent.receiveFinalized).toBe(true);
      }
    } finally {
      await child.close();
      await parent.close();
    }
  },
);
