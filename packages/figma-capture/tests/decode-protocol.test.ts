import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syntheticContext } from "@design-studio/contracts/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageBudget } from "../src/boundary.js";
import { decodeReference } from "../src/decode.js";

const seam = vi.hoisted(() => ({
  messages: [] as unknown[],
  exit: 0,
  crash: false,
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    constructor() {
      super();
      setImmediate(() => {
        for (const message of seam.messages) this.emit("message", message);
        if (seam.crash) this.emit("error", new Error("private worker failure"));
        this.emit("exit", seam.exit);
      });
    }
    async terminate() {
      return 1;
    }
  },
}));
afterEach(() => {
  seam.messages = [];
  seam.exit = 0;
  seam.crash = false;
});
const budget = (): ImageBudget => {
  const context = syntheticContext();
  return {
    body: 0,
    context,
    signal: context.signal,
    policy: { imageOrigins: [] },
    check() {},
    dnsQuery() {},
    receive() {},
    decoded() {},
  };
};
const valid = {
  ok: true,
  kind: "png",
  width: 1,
  height: 1,
  colorSpace: "srgb",
};
it.each([
  [],
  [null],
  [{ ok: false }],
  [{ ...valid, kind: "json" }],
  [{ ...valid, width: NaN }],
  [{ ...valid, height: Infinity }],
  [{ ...valid, width: 0 }],
  [{ ...valid, width: 0.5 }],
  [{ ...valid, width: 6553601 }],
  [{ ...valid, extra: "private" }],
  [valid, valid],
  [{ ok: false, kind: "png", reason: "private arbitrary exception" }],
  [{ ok: false, kind: "png", reason: "json-malformed" }],
  [{ ok: false, kind: "png", reason: "png-malformed", stack: "private" }],
])("rejects wrong or multiple worker messages %#", async (...messages) => {
  seam.messages = messages;
  await expect(decodeReference(Buffer.of(1), budget())).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    referenceDiagnostic: { stage: "worker", reason: "worker-protocol" },
  });
});
it("does not serialize worker exception details", async () => {
  seam.crash = true;
  await expect(decodeReference(Buffer.of(1), budget())).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    referenceDiagnostic: { reason: "worker-unavailable" },
  });
});
it("accepts only bounded positive metadata", async () => {
  seam.messages = [valid];
  expect(await decodeReference(Buffer.of(1), budget())).toEqual({
    width: 1,
    height: 1,
    colorSpace: "srgb",
  });
});
