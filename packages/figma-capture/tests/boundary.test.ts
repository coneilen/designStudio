import { Worker } from "node:worker_threads";
import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { CaptureBudget, ownRequest } from "../src/boundary.js";
import { decodeReference } from "../src/decode.js";
import { captureFixture, png } from "./support.js";

it("honors shorter authorization expiry without renewing the original work deadline", async () => {
  const fixture = captureFixture();
  const clock = createFakeClock(Date.now());
  fixture.context.clock = clock;
  fixture.context.deadline = new Date(clock.now() + 30000).toISOString();
  fixture.context.authorization.expiresAt = new Date(
    clock.now() + 10,
  ).toISOString();
  const budget = new CaptureBudget(
    fixture.context,
    fixture.policy,
    fixture.authority,
  );
  try {
    budget.call();
    expect(budget.deadline).toBe(clock.now() + 10);
    clock.advance(10);
    expect(() => budget.call()).toThrow();
  } finally {
    await budget.close();
  }
});

it("pins exact selection/reference/policy before work and rejects encoded scope escapes", () => {
  const f = captureFixture();
  for (const selectionUrl of [
    "https://user:password@www.figma.com/design/SyntheticFile/selection?node-id=1-2",
    "https://www.figma.com/design/SyntheticFile/%2Fother?node-id=1-2",
    "https://www.figma.com/design/SyntheticFile/selection?node-id=1%253A2",
    "https://www.figma.com/design/OtherFile/selection?node-id=1-2",
    "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2&node-id=2-3",
  ])
    expect(() =>
      ownRequest({ ...f.request, selectionUrl }, f.policy),
    ).toThrow();
  expect(() =>
    ownRequest({ ...f.request, policySha256: "f".repeat(64) }, f.policy),
  ).toThrow();
  expect(
    ownRequest(
      {
        ...f.request,
        selectionUrl:
          "https://www.figma.com/design/SyntheticFile/name?node-id=1%3A2&t=synthetic",
      },
      f.policy,
    ).selectionUrl,
  ).toBe(f.request.selectionUrl);
});
it("enforces cumulative call/DNS/raw/body/persisted boundaries, not per-request resets", async () => {
  const f = captureFixture();
  f.context.budget.maxInputBytes = 128;
  f.context.budget.maxOutputBytes = 128;
  const budget = new CaptureBudget(f.context, f.policy, f.authority);
  try {
    for (let call = 0; call < 4; call++) {
      budget.call();
      budget.dnsQuery();
      budget.receive(32);
      budget.decoded(32);
      budget.output(32);
    }
    expect(() => budget.call()).toThrow();
    expect(() => budget.dnsQuery()).toThrow();
    expect(() => budget.receive(1)).toThrow();
    expect(() => budget.decoded(1)).toThrow();
    expect(() => budget.output(1)).toThrow();
    expect(budget.calls).toBe(4);
    expect(budget.received).toBe(128);
    expect(budget.persisted).toBe(128);
  } finally {
    await budget.close();
  }
});
it("bounds decoded pixels and observes actual worker termination before cancellation returns", async () => {
  const f = captureFixture();
  f.context.budget.maxRasterPixels = 1;
  const limited = new CaptureBudget(f.context, f.policy, f.authority);
  try {
    await expect(
      decodeReference(png(true, 2, 1), limited),
    ).rejects.toMatchObject({
      code: "RASTER_LIMIT",
      referenceDiagnostic: {
        stage: "png",
        reason: "raster-limit",
        mimeClass: "not-observed",
      },
    });
  } finally {
    await limited.close();
  }
  const other = captureFixture();
  const abort = new AbortController();
  other.context.signal = abort.signal;
  const budget = new CaptureBudget(
    other.context,
    other.policy,
    other.authority,
  );
  const terminate = Worker.prototype.terminate;
  let exited = false;
  const observed = vi
    .spyOn(Worker.prototype, "terminate")
    .mockImplementation(function (this: Worker) {
      return terminate.call(this).then((code) => {
        exited = true;
        return code;
      });
    });
  try {
    const work = decodeReference(png(), budget);
    abort.abort();
    await expect(work).rejects.toMatchObject({ code: "CANCELLED" });
    expect(exited).toBe(true);
  } finally {
    observed.mockRestore();
    await budget.close();
  }
});
