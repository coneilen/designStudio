import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { readMaskedSecret } from "../src/masked-secret.js";
import { readMaskedSecretFromTerminal } from "../src/masked-secret-input.js";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const transcript: Buffer[] = [];
  output.on("data", (chunk: Buffer) => transcript.push(chunk));
  return { input, output, text: () => Buffer.concat(transcript).toString() };
}
it("owns bytes without echo and restores terminal mode and listeners", async () => {
  const tty = terminal();
  const result = readMaskedSecretFromTerminal(tty, {
    signal: new AbortController().signal,
  });
  tty.input.write(Buffer.from("synthetic-local-only\r"));
  const bytes = await result;
  expect(Buffer.from(bytes).toString()).toBe("synthetic-local-only");
  expect(tty.text()).not.toContain("synthetic-local-only");
  expect(tty.input.isRaw).toBe(false);
  expect(tty.input.listenerCount("data")).toBe(0);
  bytes.fill(0);
});
for (const value of [
  "\u0003",
  "\u001b",
  "\u0004",
  "bad\nextra",
  "bad secret",
  "x".repeat(4097),
])
  it(`rejects cancellation/control/multiline/oversize input ${value.length}`, async () => {
    const tty = terminal();
    const result = readMaskedSecretFromTerminal(tty, {
      signal: new AbortController().signal,
    });
    tty.input.write(Buffer.from(value));
    await expect(result).rejects.toBeDefined();
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount("data")).toBe(0);
    expect(tty.text()).not.toContain("bad");
  });
it("never consumes redirected input and production entry has no injectable terminal", async () => {
  const tty = terminal();
  tty.input.isTTY = false;
  await expect(
    readMaskedSecretFromTerminal(tty, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  expect(tty.input.listenerCount("data")).toBe(0);
  expect(typeof readMaskedSecret).toBe("function");
});
it("cancels and restores without a data event", async () => {
  const tty = terminal();
  const controller = new AbortController();
  const result = readMaskedSecretFromTerminal(tty, {
    signal: controller.signal,
  });
  controller.abort(new Error("sensitive-cancel-reason"));
  await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  expect(tty.input.isRaw).toBe(false);
  expect(tty.text()).not.toContain("sensitive");
});

it("bounds user interaction at five minutes, restores mode and zeroes incoming chunks", async () => {
  vi.useFakeTimers();
  try {
    const tty = terminal();
    const result = readMaskedSecretFromTerminal(tty, {
      signal: new AbortController().signal,
    });
    const failed = expect(result).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    const chunk = Buffer.from("synthetic-partial");
    tty.input.write(chunk);
    expect(chunk.every((byte) => byte === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    await failed;
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not leave listeners after synchronous output failure and surfaces failed raw-mode restoration", async () => {
  const tty = terminal();
  tty.output.write = () => {
    throw new Error("private-output-failure");
  };
  await expect(
    readMaskedSecretFromTerminal(tty, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
  expect(tty.input.listenerCount("data")).toBe(0);
  expect(tty.input.isRaw).toBe(false);
  const broken = terminal();
  broken.input.setRawMode = (raw: boolean) => {
    if (!raw) throw new Error("private-restore-failure");
    broken.input.isRaw = raw;
    return broken.input;
  };
  const result = readMaskedSecretFromTerminal(broken, {
    signal: new AbortController().signal,
  });
  broken.input.write(Buffer.from("synthetic\r"));
  await expect(result).rejects.toMatchObject({ code: "INTERRUPTED" });
  expect(broken.input.listenerCount("data")).toBe(0);
});

it("does not read a shared/encoded/buffered terminal and handles EOF/backspace", async () => {
  const shared = terminal();
  shared.input.on("data", () => {});
  await expect(
    readMaskedSecretFromTerminal(shared, {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  const tty = terminal();
  const result = readMaskedSecretFromTerminal(tty, {
    signal: new AbortController().signal,
  });
  tty.input.write(Buffer.from("abcd\u007fx\r"));
  const bytes = await result;
  expect(Buffer.from(bytes).toString()).toBe("abcx");
  bytes.fill(0);
  const ended = terminal();
  const failure = readMaskedSecretFromTerminal(ended, {
    signal: new AbortController().signal,
  });
  ended.input.end();
  await expect(failure).rejects.toMatchObject({ code: "CANCELLED" });
  expect(ended.input.isRaw).toBe(false);
});
