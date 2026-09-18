import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { readMaskedSecret } from "../src/masked-secret.js";
import {
  createDedicatedSecretInputOwner,
  readMaskedSecretFromTerminal,
  type SecretInputConfirmation,
  SecretInputFailure,
} from "../src/masked-secret-input.js";

const start = "\x1b[200~";
const end = "\x1b[201~";
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
  let releaseFailure = false;
  let releaseGate: Promise<void> | undefined;
  let releases = 0;
  return {
    input,
    output,
    text: () => Buffer.concat(transcript).toString(),
    async releaseAfterExit() {
      releases++;
      await releaseGate;
      if (releaseFailure) throw new Error("private-cleanup-failure");
      input.setRawMode(false);
    },
    failRelease(value: boolean) {
      releaseFailure = value;
    },
    delayRelease(gate: Promise<void>) {
      releaseGate = gate;
    },
    releases: () => releases,
  };
}
function fixture(timeoutMs?: number) {
  const tty = terminal();
  const control = createDedicatedSecretInputOwner(tty);
  const abort = new AbortController();
  const result = readMaskedSecretFromTerminal(control.owner, {
    signal: abort.signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  let settled = false;
  const outcome = result.then(
    (bytes) => {
      settled = true;
      return { bytes };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  return {
    tty,
    control,
    abort,
    result,
    outcome,
    settled: () => settled,
    send(value: string) {
      if (!value.length) return;
      const chunk = Buffer.from(value);
      tty.input.write(chunk);
      expect(chunk.every((byte) => byte === 0)).toBe(true);
      expect(tty.input.readableLength).toBe(0);
    },
    confirm() {
      const receipt = control.confirmation();
      expect(receipt).toBeDefined();
      if (!receipt) throw new Error("Missing synthetic confirmation");
      control.confirm(receipt);
    },
    async exit() {
      if (!tty.input.closed) {
        const closed = once(tty.input, "close");
        tty.input.destroy();
        await closed;
      }
      return control.afterTerminalExit();
    },
  };
}

it("reproduces the old split multiline stream without accepting a prefix or leaving queued bytes", async () => {
  const f = fixture();
  f.send("synthetic-first\r");
  f.send("synthetic-second\r");
  expect(await f.outcome).toMatchObject({
    error: { code: "INVALID_INPUT", cleanupRequired: true },
  });
  expect(f.control.state().pending).toBe(true);
  expect(f.tty.input.isRaw).toBe(true);
  expect(f.tty.input.listenerCount("data")).toBe(1);
  expect(await f.exit()).toMatchObject({ pending: false });
});

it("accepts a complete frame only after separate registered control and terminal exit, at every split point", async () => {
  const stream = `${start}synthetic-local-only${end}`;
  for (let split = 0; split <= stream.length; split++) {
    const f = fixture();
    f.send(stream.slice(0, split));
    f.send(stream.slice(split));
    expect(f.control.state().phase).toBe("awaiting-confirmation");
    await Promise.resolve();
    expect(f.settled()).toBe(false);
    f.confirm();
    expect((await f.control.afterTerminalExit()).pending).toBe(true);
    await Promise.resolve();
    expect(f.settled()).toBe(false);
    expect(await f.exit()).toMatchObject({ phase: "closed", pending: false });
    const bytes = await f.result;
    expect(Buffer.from(bytes).toString()).toBe("synthetic-local-only");
    bytes.fill(0);
    expect(f.tty.text()).not.toContain("synthetic-local-only");
    expect(f.tty.input.listenerCount("data")).toBe(0);
  }
});

it("accepts exactly 1 through 4096 printable bytes without changing the size bound", async () => {
  for (const length of [1, 4096]) {
    const f = fixture();
    f.send(`${start}${"x".repeat(length)}${end}`);
    f.confirm();
    await f.exit();
    const bytes = await f.result;
    expect(bytes.byteLength).toBe(length);
    bytes.fill(0);
  }
});

for (const [name, stream, code] of [
  ["split CRLF", `${start}first\r\nsecond${end}`, "INVALID_INPUT"],
  ["newline suffix", `${start}first\r${end}`, "INVALID_INPUT"],
  [
    "nested markers",
    `${start}first${start}second${end}${end}`,
    "INVALID_INPUT",
  ],
  ["marker-like payload", `${start}first\x1b[20Xsecond${end}`, "INVALID_INPUT"],
  [
    "clipboard end marker plus confirmation key",
    `${start}first${end}\x07second${end}`,
    "INVALID_INPUT",
  ],
  ["empty frame", `${start}${end}`, "INVALID_INPUT"],
  ["Ctrl+C", `${start}first\x03second${end}`, "CANCELLED"],
  ["Ctrl+D", `${start}first\x04second${end}`, "CANCELLED"],
  ["overflow", `${start}${"x".repeat(4097)}${end}`, "INPUT_LIMIT"],
] as const)
  it(`rejects ${name} independently of every two-chunk split`, async () => {
    for (let split = 0; split <= stream.length; split++) {
      const f = fixture();
      f.send(stream.slice(0, split));
      f.send(stream.slice(split));
      expect(await f.outcome).toMatchObject({ error: { code } });
      expect(f.control.confirmation()).toBeUndefined();
      expect(f.control.state().pending).toBe(true);
      await f.exit();
      expect(f.tty.input.listenerCount("data")).toBe(0);
    }
  }, 15_000);

it("parses markers byte by byte and drains invalid frames before keeping only the discard sink", async () => {
  const f = fixture();
  for (const value of `${start}first\nsecond`) f.send(value);
  expect(f.control.state().phase).toBe("draining");
  for (const value of end) f.send(value);
  expect(f.control.state().phase).toBe("discarding");
  f.send("late-third-secret\r");
  expect(f.tty.input.listenerCount("data")).toBe(1);
  expect(f.tty.input.isRaw).toBe(true);
  await f.exit();
  expect(await f.outcome).toMatchObject({ error: { code: "INVALID_INPUT" } });
});

it("invalidates late input even after owner confirmation and withholds bytes until closure", async () => {
  for (const confirmed of [false, true]) {
    const f = fixture();
    f.send(`${start}first${end}`);
    if (confirmed) f.confirm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.send(`${start}second${end}`);
    expect(await f.outcome).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(f.control.state().pending).toBe(true);
    await f.exit();
  }
});

it("bounds drain work and deadline, retaining only a zeroing sink and explicit recovery owner", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(100);
    f.send(`${start}bad\n${"x".repeat(9000)}`);
    expect(f.control.state()).toMatchObject({
      phase: "discarding",
      pending: true,
      parsedBytes: 8192,
      primaryCode: "INVALID_INPUT",
      cleanupCode: "INPUT_LIMIT",
    });
    f.send("late-secret");
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    const outcome = await f.outcome;
    expect(outcome).toMatchObject({
      error: { owner: f.control.owner, cleanupRequired: true },
    });
    expect(f.tty.text()).toContain(
      "Close/discard this dedicated secret-input console",
    );
    expect(f.tty.input.listenerCount("data")).toBe(1);
    expect(f.tty.input.readableLength).toBe(0);
    await f.exit();
  } finally {
    vi.useRealTimers();
  }
});

it("cancels an open frame and never calls a mere EOF safe terminal closure", async () => {
  const f = fixture();
  f.send(`${start}partial`);
  f.abort.abort(new Error("private-cancel-reason"));
  expect(await f.outcome).toMatchObject({ error: { code: "CANCELLED" } });
  f.send(`discarded${end}`);
  f.tty.input.emit("end");
  expect((await f.control.afterTerminalExit()).pending).toBe(true);
  expect(f.tty.text()).not.toContain("private-cancel-reason");
  await f.exit();
});

it("preserves primary and cleanup errors and allows only the owner to retry release", async () => {
  const f = fixture();
  f.tty.failRelease(true);
  f.send(`${start}bad\n${end}`);
  expect(await f.outcome).toMatchObject({ error: { code: "INVALID_INPUT" } });
  expect(await f.exit()).toMatchObject({
    pending: true,
    primaryCode: "INVALID_INPUT",
    cleanupCode: "INTERRUPTED",
  });
  expect(f.tty.input.isRaw).toBe(true);
  f.tty.failRelease(false);
  expect(await f.control.afterTerminalExit()).toMatchObject({
    phase: "closed",
    pending: false,
    primaryCode: "INVALID_INPUT",
  });
  expect(f.tty.input.listenerCount("data")).toBe(0);
  expect(f.tty.text()).not.toContain("private-cleanup-failure");
});

it("joins actual cleanup settlement and serializes retry without returning a late secret", async () => {
  const f = fixture();
  let release!: () => void;
  f.tty.delayRelease(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.send(`${start}synthetic${end}`);
  f.confirm();
  const closing = f.exit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const duplicate = f.control.afterTerminalExit();
  expect(f.control.state()).toMatchObject({
    phase: "closing",
    pending: true,
  });
  expect(f.tty.releases()).toBe(1);
  expect(f.settled()).toBe(false);
  f.abort.abort();
  expect(await f.outcome).toMatchObject({ error: { code: "CANCELLED" } });
  expect(f.control.state().pending).toBe(true);
  release();
  expect(await closing).toMatchObject({ phase: "closed", pending: false });
  expect(await duplicate).toMatchObject({ phase: "closed", pending: false });
  expect(f.tty.releases()).toBe(1);
});

it("rejects confirmation/owner clones, replay, and unsupported production admission", async () => {
  const f = fixture();
  await expect(
    readMaskedSecretFromTerminal(
      { ...f.control.owner },
      { signal: f.abort.signal },
    ),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  await expect(
    readMaskedSecretFromTerminal(f.control.owner, { signal: f.abort.signal }),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  f.send(`${start}synthetic${end}`);
  const receipt = f.control.confirmation();
  expect(receipt).toBeDefined();
  if (!receipt) throw new Error("Missing receipt");
  expect(() => f.control.confirm({ ...receipt })).toThrow();
  expect(() =>
    f.control.confirm({
      kind: "secret-input-confirmation",
    } satisfies SecretInputConfirmation),
  ).toThrow();
  f.control.confirm(receipt);
  expect(() => f.control.confirm(receipt)).toThrow();
  await f.exit();
  (await f.result).fill(0);
  await expect(
    readMaskedSecret({ signal: f.abort.signal }),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
});

it("does not admit non-TTY, shared, encoded or buffered input", () => {
  const redirected = terminal();
  redirected.input.isTTY = false;
  expect(() => createDedicatedSecretInputOwner(redirected)).toThrow();
  const shared = terminal();
  shared.input.on("data", () => {});
  expect(() => createDedicatedSecretInputOwner(shared)).toThrow();
  const encoded = terminal();
  encoded.input.setEncoding("utf8");
  expect(() => createDedicatedSecretInputOwner(encoded)).toThrow();
  const buffered = terminal();
  buffered.input.write(Buffer.from("synthetic"));
  expect(() => createDedicatedSecretInputOwner(buffered)).toThrow();
  const queued: unknown = buffered.input.read();
  if (queued instanceof Uint8Array) queued.fill(0);
});

it("clears a valid candidate on timeout and on terminal cleanup failure without returning it", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.send(`${start}synthetic${end}`);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await f.outcome).toMatchObject({
      error: { code: "DEADLINE_EXCEEDED" },
    });
    f.send("late");
    await f.exit();
  } finally {
    vi.useRealTimers();
  }
  const broken = fixture();
  broken.send(`${start}synthetic${end}`);
  broken.confirm();
  broken.tty.failRelease(true);
  expect(await broken.exit()).toMatchObject({
    pending: true,
    cleanupCode: "INTERRUPTED",
  });
  expect(await broken.outcome).toMatchObject({
    error: { code: "INTERRUPTED" },
  });
  broken.tty.failRelease(false);
  await broken.control.afterTerminalExit();
});

it("withholds raw output errors and keeps explicit cleanup on setup failure", async () => {
  const tty = terminal();
  const control = createDedicatedSecretInputOwner(tty);
  tty.output.write = () => {
    throw new Error("private-output-error");
  };
  const result = readMaskedSecretFromTerminal(control.owner, {
    signal: new AbortController().signal,
  });
  const failure = await result.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SecretInputFailure);
  expect(failure).toMatchObject({
    code: "TRANSPORT_UNAVAILABLE",
    cleanupRequired: true,
  });
  expect(failure).toMatchObject({
    recoveryGuidance: expect.stringContaining("Close/discard"),
  });
  const closed = once(tty.input, "close");
  tty.input.destroy();
  await closed;
  expect((await control.afterTerminalExit()).pending).toBe(false);
});

it("checks the immutable deadline even before a delayed timer callback runs", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const f = fixture(100);
    f.send(`${start}synthetic${end}`);
    now = 100;
    expect(() => f.confirm()).toThrow();
    expect(await f.outcome).toMatchObject({
      error: { code: "DEADLINE_EXCEEDED" },
    });
    await f.exit();
    expect(f.control.state().pending).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
