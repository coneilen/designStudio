import { expect, it } from "vitest";
import { encode, FrameReader, Kind } from "../src/protocol.js";

it("bounds advertised lengths before allocating, verifies nonce, and preserves fragmented binary frames", () => {
  const nonce = "ab".repeat(32);
  const received: Buffer[] = [];
  const reader = new FrameReader(nonce, 3, (frame) => {
    received.push(frame.bytes);
  });
  const frame = encode(nonce, Kind.result, 1, Buffer.from([0, 255, 128]));
  for (const byte of frame) reader.push(Buffer.of(byte));
  expect(received).toEqual([Buffer.from([0, 255, 128])]);
  for (const size of [0, 36, 41, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(size);
    expect(() => new FrameReader(nonce, 3, () => {}).push(header)).toThrow(
      "bound",
    );
  }
  expect(() =>
    new FrameReader(nonce, 3, () => {}).push(
      encode("cd".repeat(32), Kind.ready, 0),
    ),
  ).toThrow("nonce");
});
