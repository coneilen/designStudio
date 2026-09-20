import { Duplex, PassThrough, type TransformCallback } from "node:stream";
import { expect, it } from "vitest";
import { PatChannel, PatKind } from "../src/pat-channel.js";

it("moves synthetic secret bytes only through bounded binary frames and owns teardown", async () => {
  const pipe = new PassThrough();
  const nonce = Buffer.alloc(32, 7);
  const channel = new PatChannel(pipe, nonce);
  const secret = Buffer.from("synthetic-binary-only");
  const read = channel.read(1000);
  await channel.send(PatKind.accepted, 1, secret);
  const frame = await read;
  expect(frame.kind).toBe(PatKind.accepted);
  expect(Buffer.from(frame.bytes).toString()).toBe("synthetic-binary-only");
  frame.bytes.fill(0);
  channel.close();
});
it("rejects oversize and unknown kinds before allocating or transmitting", async () => {
  const pipe = new PassThrough();
  const channel = new PatChannel(pipe, Buffer.alloc(32, 1));
  await expect(
    channel.send(PatKind.accepted, 1, Buffer.alloc(4097)),
  ).rejects.toThrow();
  await expect(channel.send(250, 0, Buffer.alloc(0))).rejects.toThrow();
  channel.close();
});

const raw = (nonce: Buffer, kind: number, sequence: number, bytes: Buffer) => {
  const frame = Buffer.alloc(38 + bytes.length);
  frame.writeUInt32BE(bytes.length);
  nonce.copy(frame, 4);
  frame[36] = kind;
  frame[37] = sequence;
  bytes.copy(frame, 38);
  return frame;
};
it("decodes every split point without stringifying secret payloads", async () => {
  const nonce = Buffer.alloc(32, 3);
  const body = Buffer.from("synthetic-split-frame");
  for (let split = 0; split <= 38 + body.length; split++) {
    const pipe = new PassThrough();
    const channel = new PatChannel(pipe, nonce);
    const frame = raw(nonce, PatKind.accepted, 1, body);
    const result = channel.read(1000);
    pipe.write(frame.subarray(0, split));
    pipe.write(frame.subarray(split));
    const accepted = await result;
    expect(accepted.bytes).toEqual(body);
    expect(frame.every((byte) => byte === 0)).toBe(true);
    accepted.bytes.fill(0);
    await channel.close();
  }
  body.fill(0);
});
it("rejects nonce, kind, sequence and truncated frames and clears incoming bytes", async () => {
  for (const mutation of ["nonce", "kind", "sequence", "truncated"] as const) {
    const nonce = Buffer.alloc(32, 4);
    const pipe = new PassThrough();
    const channel = new PatChannel(pipe, nonce);
    const frame = raw(nonce, PatKind.accepted, 1, Buffer.from("synthetic"));
    if (mutation === "nonce") frame[4] = 9;
    if (mutation === "kind") frame[36] = 250;
    if (mutation === "sequence") frame[37] = 2;
    const reading = channel.read(1000);
    const failure = expect(reading).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    const part =
      mutation === "truncated" ? frame.subarray(0, frame.length - 2) : frame;
    pipe.write(part);
    if (mutation === "truncated") pipe.end();
    await failure;
    expect(part.every((byte) => byte === 0)).toBe(true);
    frame.fill(0);
    await channel.close();
  }
});
it("retains write-frame bytes until the actual callback settles, including close", async () => {
  class Delayed extends Duplex {
    borrowed?: Buffer;
    writing?: TransformCallback;
    closing?: (error: Error | null) => void;
    override _read() {}
    override _write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      this.borrowed = chunk;
      this.writing = callback;
    }
    override _destroy(
      _error: Error | null,
      callback: (error: Error | null) => void,
    ) {
      this.closing = callback;
    }
  }
  const pipe = new Delayed();
  const channel = new PatChannel(pipe, Buffer.alloc(32, 1));
  const written = channel.send(
    PatKind.accepted,
    1,
    Buffer.from("synthetic-late-write"),
  );
  const writing = expect(written).rejects.toMatchObject({
    code: "TRANSPORT_UNAVAILABLE",
  });
  let closed = false;
  const closing = channel.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  expect(pipe.borrowed?.subarray(38).toString()).toBe("synthetic-late-write");
  pipe.writing?.(new Error("synthetic private transport error"));
  await writing;
  expect(pipe.borrowed?.every((byte) => byte === 0)).toBe(true);
  pipe.closing?.(null);
  await closing;
});
