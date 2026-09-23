import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { AssetError, bound, decodeRaster, sanitizeSvg } from "../src/index.js";

const limits = { ...DEFAULT_BUDGETS, maxOutputBytes: 256_000_000 };
const stripe = readFileSync(
  new URL(
    "../../../tests/fixtures/foundation/assets/stripes.png",
    import.meta.url,
  ),
);
function chunk(type: string, bytes: Uint8Array) {
  const buffer = Buffer.alloc(bytes.length + 12);
  buffer.writeUInt32BE(bytes.length);
  buffer.write(type, 4, "ascii");
  buffer.set(bytes, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4);
  return buffer;
}
const vector = (body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">${body}</svg>`,
  );
describe("budget and hostile parser regressions", () => {
  it.each([26_214_400, 64_000_000, 262_144_000])(
    "has exact normative threshold semantics for %i",
    (threshold) => {
      expect(() => bound("LIMIT", threshold - 1, threshold)).not.toThrow();
      expect(() => bound("LIMIT", threshold, threshold)).not.toThrow();
      try {
        bound("LIMIT", threshold + 1, threshold);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AssetError);
        expect(error).toHaveProperty("diagnostic", {
          code: "LIMIT",
          message: "Resource budget exceeded",
          measured: threshold + 1,
          allowed: threshold,
        });
      }
    },
  );
  it("rejects valid-CRC huge dimensions before inflate", () => {
    const ihdr = Buffer.from(stripe.subarray(16, 29));
    ihdr.writeUInt32BE(64_000_001, 0);
    ihdr.writeUInt32BE(1, 4);
    expect(() =>
      decodeRaster(
        Buffer.concat([
          stripe.subarray(0, 8),
          chunk("IHDR", ihdr),
          stripe.subarray(33),
        ]),
        limits,
      ),
    ).toThrow(/RASTER_PIXELS/);
  });
  it("bounds genuine compressed bombs with valid CRC and tiny header", () => {
    const image = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const bomb = Buffer.concat([
      image.subarray(0, 33),
      chunk("IDAT", deflateSync(Buffer.alloc(1_000_000))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decodeRaster(bomb, limits)).toThrow(/PNG_MALFORMED/);
  });
  it("rejects compressed-stream trailing garbage, CRC corruption and post-IEND bytes", () => {
    const image = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const idat = image.indexOf(Buffer.from("IDAT"));
    const size = image.readUInt32BE(idat - 4);
    const garbage = Buffer.concat([
      image.subarray(0, 33),
      chunk(
        "IDAT",
        Buffer.concat([
          image.subarray(idat + 4, idat + 4 + size),
          Buffer.from("extra"),
        ]),
      ),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decodeRaster(garbage, limits)).toThrow(/PNG_MALFORMED/);
    const corrupt = Buffer.from(stripe);
    corrupt[40] = (corrupt[40] ?? 0) ^ 1;
    expect(() => decodeRaster(corrupt, limits)).toThrow(/PNG_MALFORMED/);
    expect(() =>
      decodeRaster(Buffer.concat([stripe, Buffer.from("tail")]), limits),
    ).toThrow(/PNG_MALFORMED/);
  });
  it("rejects malformed profiles/transparency and explicitly unsupported animation", () => {
    for (const [type, reason] of [
      ["iCCP", /PNG_MALFORMED/],
      ["tRNS", /PNG_MALFORMED/],
      ["acTL", /PNG_ANIMATION_UNSUPPORTED/],
    ] as const) {
      expect(() =>
        decodeRaster(
          Buffer.concat([
            stripe.subarray(0, 33),
            chunk(type, Buffer.alloc(8)),
            stripe.subarray(33),
          ]),
          limits,
        ),
      ).toThrow(reason);
    }
  });
  it("bounds chunk counts independently of compressed bytes", () => {
    const image = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const many = Buffer.concat([
      image.subarray(0, 33),
      ...Array.from({ length: 25 }, () => chunk("IDAT", Buffer.alloc(0))),
      image.subarray(33),
    ]);
    expect(() =>
      decodeRaster(many, { ...limits, maxExpandedNodes: 20 }),
    ).toThrow(/PNG_CHUNKS/);
  });
  it.each([
    '<rect width="-1"/>',
    '<circle r="-2"/>',
    '<path d="MNaN 0"/>',
    '<polygon points="--1,2"/>',
    '<rect width="1e999"/>',
  ])("rejects out-of-profile vector geometry %s", (body) => {
    expect(() => sanitizeSvg(vector(body), limits)).toThrow(/SVG_UNSUPPORTED/);
  });
  it("rejects duplicate roots, namespaced elements and encoded references", () => {
    expect(() =>
      sanitizeSvg(Buffer.concat([vector(""), vector("")]), limits),
    ).toThrow();
    expect(() =>
      sanitizeSvg(
        vector('<s:rect xmlns:s="http://www.w3.org/2000/svg"/>'),
        limits,
      ),
    ).toThrow();
    expect(() =>
      sanitizeSvg(
        vector('<rect fill="&#117;rl(https://example.com)"/>'),
        limits,
      ),
    ).toThrow();
  });
});
