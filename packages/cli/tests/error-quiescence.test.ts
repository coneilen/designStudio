import {
  ApplicationError,
  failure,
  PROJECT_ID,
} from "@design-studio/application";
import { expect, it, vi } from "vitest";
import {
  quiescenceRecord,
  SERVICE_QUIESCENCE_PREFIX,
} from "../src/service-evidence.js";
import {
  ServiceQuiescence,
  ServiceShutdown,
  stoppedFrame,
} from "../src/service-shutdown.js";

const result = () => ({
  code: 1,
  bytes: Buffer.from(
    JSON.stringify(failure("service_stop", "TRANSPORT_UNAVAILABLE")),
  ),
});
it("accepts split private error-teardown records only with matching typed failure and observed exit", async () => {
  const evidence = new ServiceQuiescence();
  const record = Buffer.from(quiescenceRecord());
  for (const byte of record) evidence.observeStderr(Uint8Array.of(byte));
  evidence.endStderr();
  const release = vi.fn(async () => {});
  const shutdown = new ServiceShutdown({
    evidence,
    channel: {
      write: async () => {
        throw new Error("Dead fd3.");
      },
      read: async () => {
        throw new Error("Dead fd3.");
      },
      close: () => {},
    },
    observedExit: () => result(),
    waitForExit: async () => result(),
    release,
  });
  await expect(shutdown.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
    cause: { code: "TRANSPORT_UNAVAILABLE" },
  });
  await expect(shutdown.close()).rejects.toMatchObject({ code: "INTERRUPTED" });
  expect(release).toHaveBeenCalledOnce();
});
it.each([
  "duplicate",
  "truncated",
  "extra",
  "oversized",
  "foreign",
  "conflicting",
] as const)(
  "does not rescue %s stderr evidence using a stopped stdout or control frame",
  (kind) => {
    const evidence = new ServiceQuiescence();
    const good = quiescenceRecord();
    const record =
      kind === "duplicate"
        ? good + good
        : kind === "truncated"
          ? good.slice(0, -1)
          : kind === "oversized"
            ? `${SERVICE_QUIESCENCE_PREFIX}${"x".repeat(513)}\n`
            : kind === "extra"
              ? `${SERVICE_QUIESCENCE_PREFIX}${JSON.stringify({ kind: "quiescent", projectId: PROJECT_ID, requestId: "service_stop", extra: true })}\n`
              : kind === "foreign"
                ? good.replace(PROJECT_ID, "another")
                : `${good}${SERVICE_QUIESCENCE_PREFIX}{}\n`;
    evidence.observeStderr(Buffer.from(record));
    evidence.endStderr();
    evidence.observeControl(stoppedFrame());
    expect(evidence.confirms(result())).toBe(false);
  },
);
it("requires matching complete failure stdout and never treats arbitrary stderr as authority", () => {
  const evidence = new ServiceQuiescence();
  evidence.observeStderr(Buffer.from("ordinary untrusted log\n"));
  evidence.endStderr();
  expect(evidence.confirms(result())).toBe(false);
  const confirmed = new ServiceQuiescence();
  confirmed.observeStderr(Buffer.from(quiescenceRecord()));
  confirmed.endStderr();
  expect(confirmed.confirms({ code: 1, bytes: new Uint8Array() })).toBe(false);
  expect(
    confirmed.confirms({
      code: 1,
      bytes: Buffer.from(
        JSON.stringify(failure("foreign", "TRANSPORT_UNAVAILABLE")),
      ),
    }),
  ).toBe(false);
  expect(
    confirmed.confirms({ code: 1, bytes: result().bytes.subarray(0, 30) }),
  ).toBe(false);
});
it("cannot override a previously invalidated partial control stream", () => {
  const evidence = new ServiceQuiescence();
  evidence.invalidateControl();
  evidence.observeStderr(Buffer.from(quiescenceRecord()));
  evidence.endStderr();
  expect(evidence.confirms(result())).toBe(false);
});
it("rejects a truncated second marker prefix even when followed by a newline", () => {
  const evidence = new ServiceQuiescence();
  evidence.observeStderr(
    Buffer.from(`${quiescenceRecord()}DESIGNCTL_SERVICE_QUIES\n`),
  );
  evidence.endStderr();
  expect(evidence.confirms(result())).toBe(false);
});
it("retains owner pins while successful error-path evidence exists but the service has not exited", async () => {
  const evidence = new ServiceQuiescence();
  evidence.observeStderr(Buffer.from(quiescenceRecord()));
  evidence.endStderr();
  const release = vi.fn(async () => {});
  const shutdown = new ServiceShutdown({
    evidence,
    release,
    observedExit: () => undefined,
    waitForExit: async () => {
      throw new ApplicationError("INTERRUPTED", 409);
    },
    channel: {
      write: async () => {
        throw new Error("Dead fd3.");
      },
      read: async () => {
        throw new Error("Dead fd3.");
      },
      close: () => {},
    },
  });
  await expect(shutdown.close()).rejects.toMatchObject({ code: "INTERRUPTED" });
  expect(release).not.toHaveBeenCalled();
});
