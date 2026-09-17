import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { PrivateChannel } from "../src/channel.js";

it("frames a private message without stdout or environment transport", async () => {
  const pipe = new PassThrough();
  const channel = new PrivateChannel(pipe);
  const received = channel.read(1000);
  await channel.write({
    kind: "ready",
    port: 47119,
    credential: "a".repeat(43),
  });
  expect(await received).toEqual({
    kind: "ready",
    port: 47119,
    credential: "a".repeat(43),
  });
  channel.close();
});
it("rejects oversized framing before allocating its declared payload", async () => {
  const pipe = new PassThrough();
  const channel = new PrivateChannel(pipe);
  const result = channel.read(1000);
  pipe.write(Buffer.from([0x7f, 0xff, 0xff, 0xff]));
  await expect(result).rejects.toThrow();
  channel.close();
});
it("has finite timeout and reports closure rather than returning an empty credential", async () => {
  const channel = new PrivateChannel(new PassThrough());
  await expect(channel.read(1)).rejects.toThrow();
  channel.close();
  await expect(channel.read(1000)).rejects.toThrow();
});
