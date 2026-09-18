import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { PrivateChannel } from "../src/channel.js";
import { ServiceQuiescence, stoppedFrame } from "../src/service-shutdown.js";

it("notifies the owning lifecycle when closure leaves a truncated protocol frame", async () => {
  const pipe = new PassThrough();
  let invalid = false;
  const channel = new PrivateChannel(pipe, undefined, () => {
    invalid = true;
  });
  const pending = channel.read(1000);
  pipe.end(Buffer.from([0, 0]));
  await expect(pending).rejects.toThrow();
  expect(invalid).toBe(true);
});

it.each(["header", "payload"] as const)(
  "invalidates stopped evidence before an error clears a partial %s",
  async (kind) => {
    const pipe = new PassThrough();
    const evidence = new ServiceQuiescence();
    const channel = new PrivateChannel(
      pipe,
      (value) => evidence.observeControl(value),
      () => evidence.invalidateControl(),
    );
    const body = Buffer.from(JSON.stringify(stoppedFrame()));
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    const partial =
      kind === "header"
        ? Buffer.from([0, 0])
        : Buffer.from([0, 0, 0, 4, 123, 34]);
    pipe.write(Buffer.concat([frame, partial]));
    expect(evidence.acknowledged).toBe(true);
    pipe.emit("error", new Error("Owned transport error."));
    expect(evidence.confirms({ code: 8, bytes: new Uint8Array() })).toBe(false);
    channel.close();
  },
);
it("preserves stopped evidence when transport failure occurs at a complete frame boundary", () => {
  const pipe = new PassThrough();
  const evidence = new ServiceQuiescence();
  const channel = new PrivateChannel(
    pipe,
    (value) => evidence.observeControl(value),
    () => evidence.invalidateControl(),
  );
  const body = Buffer.from(JSON.stringify(stoppedFrame()));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  pipe.write(frame);
  pipe.emit("error", new Error("Owned transport error."));
  expect(evidence.confirms({ code: 8, bytes: new Uint8Array() })).toBe(true);
  channel.close();
});
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
