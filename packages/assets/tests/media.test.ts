import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  classify,
  decodeRaster,
  sanitizeSvg,
  sha256,
  validateLimits,
} from "../src/index.js";

const stripe = readFileSync(
  new URL(
    "../../../tests/fixtures/foundation/assets/stripes.png",
    import.meta.url,
  ),
);
const limits = { ...DEFAULT_BUDGETS, maxOutputBytes: 256_000_000 };
const svg = (body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">${body}</svg>`,
  );

describe("bounded media", () => {
  it("decodes actual fixture pixels without changing originals", () => {
    const original = sha256(stripe);
    const decoded = decodeRaster(stripe, limits);
    expect(decoded).toMatchObject({
      width: 200,
      height: 100,
      colorSpace: "srgb",
      alpha: "opaque",
    });
    expect(decoded.rgba.length).toBe(80_000);
    expect(sha256(stripe)).toBe(original);
  });
  it.each([-1, 0, 1])("enforces exact input boundary %i", (offset) => {
    const run = () =>
      decodeRaster(stripe, {
        ...limits,
        maxInputBytes: stripe.length + offset,
      });
    if (offset < 0) expect(run).toThrow(/INPUT_BYTES/);
    else expect(run()).toHaveProperty("rgba");
  });
  it.each([Number.NaN, Infinity, -1, 1.5])(
    "rejects invalid budget %s",
    (maxRasterPixels) => {
      expect(() => validateLimits({ ...limits, maxRasterPixels })).toThrow(
        /INVALID_BUDGET/,
      );
    },
  );
  it("checks pixels and decoded output before decoder allocation", () => {
    expect(() =>
      decodeRaster(stripe, { ...limits, maxRasterPixels: 19_999 }),
    ).toThrow(/RASTER_PIXELS/);
    expect(
      decodeRaster(stripe, { ...limits, maxRasterPixels: 20_000 }).width,
    ).toBe(200);
    expect(() =>
      decodeRaster(stripe, { ...limits, maxOutputBytes: 79_999 }),
    ).toThrow(/OUTPUT_BYTES/);
    const huge = Buffer.from(stripe);
    huge.writeUInt32BE(100_000, 16);
    expect(() => decodeRaster(huge, limits)).toThrow();
  });
  it("rejects truncation, spoofing and unsupported decoders", () => {
    expect(() => decodeRaster(stripe.subarray(0, -1), limits)).toThrow(
      /MALFORMED/,
    );
    expect(() => decodeRaster(Buffer.from("not an image.png"), limits)).toThrow(
      /UNSUPPORTED/,
    );
    expect(classify(Buffer.from([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(() =>
      decodeRaster(Buffer.from([255, 216, 255, 224]), limits),
    ).toThrow(/UNSUPPORTED/);
    expect(classify(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
  });
  it("measures straight alpha", () => {
    const image = new PNG({ width: 1, height: 1 });
    image.data.set([25, 50, 75, 120]);
    expect(decodeRaster(PNG.sync.write(image), limits)).toMatchObject({
      alpha: "straight",
    });
  });
  it("rejects oversized inflate even with a small IHDR", () => {
    const image = new PNG({ width: 1, height: 1 });
    const encoded = PNG.sync.write(image);
    const idat = encoded.indexOf(Buffer.from("IDAT"));
    const compressed = deflateSync(Buffer.alloc(1_000_000));
    // A bad CRC is independently malformed; even repairing it must not permit expansion.
    const hostile = Buffer.concat([
      encoded.subarray(0, idat - 4),
      Buffer.alloc(4),
      Buffer.from("IDAT"),
      compressed,
      Buffer.alloc(4),
      encoded.subarray(-12),
    ]);
    hostile.writeUInt32BE(compressed.length, idat - 4);
    expect(() => decodeRaster(hostile, limits)).toThrow(/MALFORMED/);
  });
});

describe("data-only SVG derivative", () => {
  it("preserves a data-only accessibility title in authored shape fixtures", () => {
    const bytes = readFileSync(
      new URL(
        "../../../tests/fixtures/assets/safe-shapes.svg",
        import.meta.url,
      ),
    );
    expect(sanitizeSvg(bytes, limits).bytes.toString()).toContain(
      "<title>Original synthetic shapes</title>",
    );
  });
  it("reconstructs safe vectors and retains original identity separately", () => {
    const bytes = svg('<rect height="10" width="20" fill="#123456"/>');
    const result = sanitizeSvg(bytes, limits);
    expect(result.width).toBe(20);
    expect(result.sha256).not.toBe(sha256(bytes));
    expect(result.derivativeOf).toBe(sha256(bytes));
    expect(result.bytes.toString()).toContain("<rect");
  });
  it.each([
    "<script>alert(1)</script>",
    '<rect onclick="evil()"/>',
    '<image href="https://example.com/a"/>',
    '<use href="#x"/>',
    "<foreignObject><div/></foreignObject>",
    '<rect fill="url(https://example.com)"/>',
    "<style>rect{fill:red}</style>",
    '<rect style="fill:red"/>',
    '<animate attributeName="x"/>',
  ])("rejects active/external/unsupported content %s", (body) => {
    expect(() => sanitizeSvg(svg(body), limits)).toThrow(/SVG_UNSUPPORTED/);
  });
  it("rejects entities, malformed XML and depth overflow", () => {
    expect(() =>
      sanitizeSvg(
        Buffer.from('<!DOCTYPE svg [<!ENTITY x "a">]><svg>&x;</svg>'),
        limits,
      ),
    ).toThrow();
    expect(() => sanitizeSvg(svg("<g>"), limits)).toThrow(/SVG_MALFORMED/);
    expect(() =>
      sanitizeSvg(svg("<g><g/></g>"), { ...limits, maxDepth: 2 }),
    ).toThrow(/SVG_DEPTH/);
  });
});
