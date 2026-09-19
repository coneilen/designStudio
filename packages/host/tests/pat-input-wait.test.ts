import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { PatChannel, PatKind } from "../src/pat-channel.js";

afterEach(() => {
  vi.useRealTimers();
});
it.each(["deadline", "cancel"] as const)(
  "clean input %s leaves nonce and terminal transport alive",
  async (mode) => {
    vi.useFakeTimers();
    const pipe = new PassThrough();
    const channel = new PatChannel(pipe, Buffer.alloc(32, 5));
    const abort = new AbortController();
    const wait = channel.readInput(10, abort.signal);
    if (mode === "cancel") abort.abort();
    else await vi.advanceTimersByTimeAsync(10);
    expect(await wait).toBeNull();
    expect(pipe.destroyed).toBe(false);
    expect(channel.receiveFailed).toBe(false);
    expect(channel.receiveFinalized).toBe(false);
    const next = channel.read(100);
    await channel.send(PatKind.closed, 1, Buffer.of(3));
    const frame = await next;
    expect(frame).toMatchObject({ kind: PatKind.closed, sequence: 1 });
    frame.bytes.fill(0);
    pipe.end();
    await channel.finalizeReceive(100);
    expect(channel.receiveFinalized).toBe(true);
    await channel.close();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("input expiry never converts a partial header/body or prior nonce failure into a clean boundary", async () => {
  vi.useFakeTimers();
  for (let split = 1; split < 42; split++) {
    const pipe = new PassThrough();
    const nonce = Buffer.alloc(32, 6);
    const channel = new PatChannel(pipe, nonce);
    const bytes = Buffer.alloc(42);
    bytes.writeUInt32BE(4);
    nonce.copy(bytes, 4);
    bytes[36] = PatKind.accepted;
    bytes[37] = 1;
    bytes.fill(65, 38);
    const read = channel.readInput(10).catch((error: unknown) => error);
    pipe.write(bytes.subarray(0, split));
    await vi.advanceTimersByTimeAsync(10);
    expect(await read).toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(channel.receiveFailed).toBe(true);
    expect(bytes.subarray(0, split).every((byte) => byte === 0)).toBe(true);
    await expect(channel.finalizeReceive(1)).rejects.toBeDefined();
    await channel.close();
    expect(channel.receiveFailed).toBe(true);
    bytes.fill(0);
  }
  const pipe = new PassThrough();
  const channel = new PatChannel(pipe, Buffer.alloc(32, 1));
  const reading = channel.readInput(10).catch((error: unknown) => error);
  const wrong = Buffer.alloc(38);
  wrong[36] = PatKind.cancel;
  pipe.write(wrong);
  expect(await reading).toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
  await expect(
    channel.readInput(10, AbortSignal.abort()),
  ).rejects.toBeDefined();
  await channel.close();
  expect(channel.receiveFailed).toBe(true);
});
it("keeps the original read cap and does not drop buffered frames on an already-cancelled input wait", async () => {
  const pipe = new PassThrough();
  const channel = new PatChannel(pipe, Buffer.alloc(32, 2));
  await expect(channel.readInput(300001)).rejects.toBeDefined();
  await channel.send(PatKind.closed, 1, Buffer.of(3));
  expect(await channel.readInput(10, AbortSignal.abort())).toBeNull();
  expect(channel.hasBufferedInput).toBe(true);
  const frame = await channel.read(100);
  expect(frame.kind).toBe(PatKind.closed);
  frame.bytes.fill(0);
  pipe.end();
  await channel.finalizeReceive(100);
  await channel.close();
});
