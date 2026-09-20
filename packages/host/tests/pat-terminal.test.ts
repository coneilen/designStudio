import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { PatChannel, PatKind } from "../src/pat-channel.js";

const nonce = Buffer.alloc(32, 5);
function frame(kind: number, sequence: number, payload: Buffer) {
  const bytes = Buffer.alloc(38 + payload.length);
  bytes.writeUInt32BE(payload.length);
  nonce.copy(bytes, 4);
  bytes[36] = kind;
  bytes[37] = sequence;
  payload.copy(bytes, 38);
  return bytes;
}
const tails = {
  duplicate: () => frame(PatKind.closed, 1, Buffer.of(0)),
  error: () => frame(PatKind.error, 1, Buffer.of(3)),
  foreign: () => {
    const bytes = frame(PatKind.closed, 1, Buffer.of(3));
    bytes[4] = 99;
    return bytes;
  },
  header: () => frame(PatKind.closed, 1, Buffer.of(3)).subarray(0, 12),
  body: () =>
    frame(PatKind.accepted, 1, Buffer.from("synthetic")).subarray(0, 41),
};
for (const [name, tail] of Object.entries(tails))
  it(`terminal ${name} is rejected at every split and disposal preserves the failure`, async () => {
    const value = Buffer.concat([
      frame(PatKind.closed, 1, Buffer.of(3)),
      tail(),
    ]);
    for (let split = 0; split <= value.length; split++) {
      const pipe = new PassThrough();
      const delivered: Buffer[] = [];
      pipe.on("data", (chunk: Buffer) => delivered.push(chunk));
      const channel = new PatChannel(pipe, nonce);
      const reading = channel.read(1000);
      pipe.write(Buffer.from(value.subarray(0, split)));
      pipe.write(Buffer.from(value.subarray(split)));
      const terminal = await reading;
      expect(terminal.kind).toBe(PatKind.closed);
      terminal.bytes.fill(0);
      const final = expect(channel.finalizeReceive(1000)).rejects.toMatchObject(
        { code: "TRANSPORT_UNAVAILABLE" },
      );
      pipe.end();
      await final;
      expect(channel.receiveFinalized).toBe(false);
      await channel.close();
      await expect(channel.finalizeReceive(1)).rejects.toBeDefined();
      expect(
        delivered.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
    }
    value.fill(0);
  });

it("valid complete EOF finalizes at every split; intentional disposal alone never does", async () => {
  const value = frame(PatKind.closed, 1, Buffer.of(3));
  for (let split = 0; split <= value.length; split++) {
    const pipe = new PassThrough();
    const channel = new PatChannel(pipe, nonce);
    const reading = channel.read(1000);
    pipe.write(Buffer.from(value.subarray(0, split)));
    pipe.write(Buffer.from(value.subarray(split)));
    (await reading).bytes.fill(0);
    let finalized = false;
    const result = channel.finalizeReceive(1000).then(() => {
      finalized = true;
    });
    await Promise.resolve();
    expect(finalized).toBe(false);
    pipe.end();
    await result;
    expect(channel.receiveFinalized).toBe(true);
    await channel.close();
    expect(channel.receiveFinalized).toBe(true);
  }
  const pipe = new PassThrough();
  const channel = new PatChannel(pipe, nonce);
  const reading = channel.read(1000);
  pipe.write(Buffer.from(value));
  (await reading).bytes.fill(0);
  await channel.close();
  await expect(channel.finalizeReceive(1)).rejects.toBeDefined();
  expect(channel.receiveFinalized).toBe(false);
  value.fill(0);
});

it("late trailing bytes and transport failures invalidate a waiting terminal finalizer", async () => {
  for (const mode of ["bytes", "error"] as const) {
    const pipe = new PassThrough();
    const channel = new PatChannel(pipe, nonce);
    const reading = channel.read(1000);
    pipe.write(frame(PatKind.closed, 1, Buffer.of(3)));
    (await reading).bytes.fill(0);
    const result = expect(channel.finalizeReceive(1000)).rejects.toBeDefined();
    if (mode === "bytes") {
      const late = Buffer.from("synthetic-late");
      pipe.write(late);
      expect(late.every((byte) => byte === 0)).toBe(true);
    } else pipe.destroy(new Error("private transport failure"));
    await result;
    await channel.close();
    expect(channel.receiveFinalized).toBe(false);
  }
});
