import {
  ApplicationError,
  PROJECT_ID,
  success,
} from "@design-studio/application";
import { expect, it, vi } from "vitest";
import {
  type ObservedServiceExit,
  ServiceQuiescence,
  ServiceShutdown,
  stoppedFrame,
} from "../src/service-shutdown.js";

function fixture() {
  let observed: ObservedServiceExit | undefined;
  const write = vi.fn(async (_value: unknown) => {});
  const evidence = new ServiceQuiescence();
  const read = vi.fn(async (_timeout: number): Promise<unknown> => {
    const frame = stoppedFrame();
    evidence.observeControl(frame);
    return frame;
  });
  const close = vi.fn(() => {});
  const release = vi.fn(async () => {});
  const stopped = Buffer.from(
    `${JSON.stringify(
      success("service_stop", {
        kind: "service",
        state: "stopped",
        projectId: PROJECT_ID,
        warnings: [],
      }),
    )}\n`,
  );
  const lifecycle = new ServiceShutdown({
    channel: { write, read, close },
    evidence,
    observedExit: () => observed,
    waitForExit: async () => {
      if (!observed) throw new ApplicationError("INTERRUPTED", 409);
      return observed;
    },
    release,
  });
  return {
    lifecycle,
    evidence,
    write,
    read,
    close,
    release,
    stopped,
    exit: (code: number | null, bytes = stopped, error?: unknown) => {
      observed = { code, bytes, ...(error ? { error } : {}) };
    },
  };
}
it("releases an already exited quiescent service without requiring a dead IPC exchange", async () => {
  const f = fixture();
  f.exit(0);
  f.write.mockRejectedValue(new ApplicationError("TRANSPORT_UNAVAILABLE", 503));
  await f.lifecycle.close();
  await f.lifecycle.close();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});
it("releases after abnormal exit with genuine quiescence evidence but preserves failure on repeated close", async () => {
  const f = fixture();
  f.exit(7);
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).toHaveBeenCalledOnce();
});
it("retries failed owner release without retrying dead IPC or hiding the original process failure", async () => {
  const f = fixture();
  f.exit(9);
  const failedClose = new Error("Owned pins failed to close.");
  f.release.mockRejectedValueOnce(failedClose);
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
    cleanupFailure: failedClose,
  });
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.write).not.toHaveBeenCalled();
});
it.each(["empty", "partial", "duplicate", "foreign", "wrong-request"] as const)(
  "retains pins when exited service has %s quiescence evidence",
  async (kind) => {
    const f = fixture();
    const body = JSON.parse(f.stopped.toString());
    if (kind === "foreign") body.data.projectId = "foreign";
    if (kind === "wrong-request") body.requestId = "another";
    const bytes =
      kind === "empty"
        ? Buffer.alloc(0)
        : kind === "partial"
          ? f.stopped.subarray(0, 20)
          : kind === "duplicate"
            ? Buffer.concat([f.stopped, f.stopped])
            : Buffer.from(JSON.stringify(body));
    f.exit(0, bytes);
    await expect(f.lifecycle.close()).rejects.toMatchObject({
      code: "INTERRUPTED",
    });
    expect(f.release).not.toHaveBeenCalled();
  },
);
it("retains pins when the control channel fails while the child is still live or exit is unknown", async () => {
  const f = fixture();
  f.write.mockRejectedValue(new ApplicationError("TRANSPORT_UNAVAILABLE", 503));
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).not.toHaveBeenCalled();
  f.exit(0);
  await f.lifecycle.close();
  expect(f.release).toHaveBeenCalledOnce();
});
it("requires actual exit in addition to successful stop acknowledgement", async () => {
  const f = fixture();
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).not.toHaveBeenCalled();
  f.exit(0);
  await f.lifecycle.close();
  expect(f.release).toHaveBeenCalledOnce();
});
it.each([
  "duplicate",
  "foreign",
  "wrong-request",
  "extra-field",
  "conflicting",
] as const)(
  "rejects %s control evidence even if stdout claims a clean stop",
  async (kind) => {
    const f = fixture();
    if (kind === "duplicate") {
      f.evidence.observeControl(stoppedFrame());
      f.evidence.observeControl(stoppedFrame());
    } else if (kind === "conflicting") {
      f.evidence.observeControl(stoppedFrame());
      f.evidence.observeControl({ kind: "interrupted" });
    } else
      f.evidence.observeControl({
        ...stoppedFrame(),
        ...(kind === "foreign"
          ? { projectId: "other" }
          : kind === "wrong-request"
            ? { requestId: "other" }
            : { extra: true }),
      });
    f.exit(0);
    await expect(f.lifecycle.close()).rejects.toMatchObject({
      code: "INTERRUPTED",
    });
    expect(f.release).not.toHaveBeenCalled();
  },
);
it("preserves a previously observed quiescent frame through IPC loss and requires actual exit", async () => {
  const f = fixture();
  f.evidence.observeControl(stoppedFrame());
  f.exit(8, Buffer.alloc(0));
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).toHaveBeenCalledOnce();
});
it("refuses quiescence promotion when the control stream reports truncated framing", async () => {
  const f = fixture();
  f.evidence.observeControl(stoppedFrame());
  f.evidence.invalidateControl();
  f.exit(0);
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
  });
  expect(f.release).not.toHaveBeenCalled();
});
it("coalesces overlapping close attempts and never releases the same owner twice", async () => {
  const f = fixture();
  f.exit(0);
  let release: (() => void) | undefined;
  f.release.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.lifecycle.close();
  const second = f.lifecycle.close();
  expect(first).toBe(second);
  expect(f.release).toHaveBeenCalledOnce();
  release?.();
  await first;
  await f.lifecycle.close();
  expect(f.release).toHaveBeenCalledOnce();
});
it("preserves channel cleanup failure and permits close-only retry after observed quiescent exit", async () => {
  const f = fixture();
  f.exit(0);
  const cleanup = new Error("Channel cleanup failed.");
  f.close.mockImplementationOnce(() => {
    throw cleanup;
  });
  await expect(f.lifecycle.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
    cleanupFailure: cleanup,
  });
  expect(f.release).not.toHaveBeenCalled();
  await f.lifecycle.close();
  expect(f.release).toHaveBeenCalledOnce();
});
