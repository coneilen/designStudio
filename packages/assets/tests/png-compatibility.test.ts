import { deflateSync } from "node:zlib";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import { decodeRaster } from "../src/media.js";
import {
  chromaticities,
  chunk,
  header,
  iccp,
  image,
  integers,
  profile,
  signature,
  srgb,
} from "./png-fixtures.js";

const limits = { ...DEFAULT_BUDGETS };
const decode = (bytes: Buffer) => decodeRaster(bytes, limits);
describe("independently authored bounded PNG compatibility", () => {
  it.each([
    [0, [10, 20, 30, 40, 50, 60], [15, 25, 35, 45, 55, 65]],
    [1, [10, 20, 30, 30, 30, 30], [15, 25, 35, 30, 30, 30]],
    [2, [10, 20, 30, 40, 50, 60], [5, 5, 5, 5, 5, 5]],
    [3, [10, 20, 30, 35, 40, 45], [10, 15, 20, 18, 18, 18]],
    [4, [10, 20, 30, 30, 30, 30], [5, 5, 5, 5, 5, 5]],
  ] as const)(
    "decodes authored scanline filter %i at exact dimensions",
    (filter, first, second) => {
      const raw = Buffer.from([filter, ...first, filter, ...second]);
      const result = decode(image(2, 8, raw, [], [], 2, 2));
      expect(result).toMatchObject({ width: 2, height: 2, alpha: "opaque" });
      expect([...result.rgba]).toEqual([
        10, 20, 30, 255, 40, 50, 60, 255, 15, 25, 35, 255, 45, 55, 65, 255,
      ]);
    },
  );
  it("allows exact shared ICC tag ranges but rejects partial overlap and duplicate signatures", () => {
    const shared = Buffer.alloc(188);
    profile().copy(shared, 0, 0, 132);
    shared.writeUInt32BE(shared.length);
    shared.writeUInt32BE(3, 128);
    for (const [i, tag] of ["rTRC", "gTRC", "bTRC"].entries()) {
      shared.write(tag, 132 + i * 12);
      shared.writeUInt32BE(168, 136 + i * 12);
      shared.writeUInt32BE(20, 140 + i * 12);
    }
    shared.write("curv", 168);
    expect(decode(image(6, 8, undefined, [iccp(shared)])).colorSpace).toBe(
      "unknown",
    );
    const partial = Buffer.from(shared);
    partial.writeUInt32BE(172, 148);
    partial.writeUInt32BE(16, 152);
    expect(() => decode(image(6, 8, undefined, [iccp(partial)]))).toThrow(
      /PNG_MALFORMED/,
    );
    const duplicate = Buffer.from(shared);
    duplicate.write("rTRC", 144);
    expect(() => decode(image(6, 8, undefined, [iccp(duplicate)]))).toThrow(
      /PNG_MALFORMED/,
    );
  });
  it.each([
    [0, 1, [0, 128], [255, 255, 255, 255]],
    [0, 2, [0, 128], [170, 170, 170, 255]],
    [0, 4, [0, 112], [119, 119, 119, 255]],
    [0, 8, [0, 73], [73, 73, 73, 255]],
    [0, 16, [0, 128, 0], [128, 128, 128, 255]],
    [2, 8, [0, 10, 20, 30], [10, 20, 30, 255]],
    [2, 16, [0, 0, 0, 128, 0, 255, 255], [0, 128, 255, 255]],
    [4, 8, [0, 73, 99], [73, 73, 73, 99]],
    [4, 16, [0, 128, 0, 64, 0], [128, 128, 128, 64]],
    [6, 8, [0, 10, 20, 30, 40], [10, 20, 30, 40]],
    [6, 16, [0, 0, 0, 128, 0, 255, 255, 64, 0], [0, 128, 255, 64]],
  ])("normalizes color %i depth %i", (color, depth, raw, expected) => {
    const bytes = image(
      Number(color),
      Number(depth),
      Buffer.from(raw as number[]),
    );
    const original = Buffer.from(bytes);
    const result = decode(bytes);
    expect([...result.rgba]).toEqual(expected);
    expect(result).toMatchObject({
      width: 1,
      height: 1,
      colorSpace: "unknown",
    });
    expect(bytes).toEqual(original);
  });
  it.each([1, 2, 4, 8])("decodes palette and alpha at depth %i", (depth) => {
    const bytes = image(3, depth, Buffer.of(0, 1 << (8 - depth)), [
      chunk("PLTE", Buffer.from([10, 20, 30, 40, 50, 60])),
      chunk("tRNS", Buffer.from([255, 77])),
    ]);
    expect([...decode(bytes).rgba]).toEqual([40, 50, 60, 77]);
    expect(decode(bytes).alpha).toBe("straight");
  });
  it("does not attest opacity lost by 16-bit alpha rounding", () => {
    const result = decode(
      image(6, 16, Buffer.from([0, 0, 0, 128, 0, 255, 255, 255, 254])),
    );
    expect([...result.rgba]).toEqual([0, 128, 255, 255]);
    expect(result.alpha).toBe("straight");
  });
  it("accepts repeated text before and after consecutive IDAT without color promotion", () => {
    const text = chunk("tEXt", Buffer.from("Synthetic\0not-for-diagnostics"));
    const bytes = image(
      6,
      8,
      undefined,
      [text, text, chromaticities()],
      [text, text],
    );
    expect(decode(bytes).colorSpace).toBe("unknown");
    expect([...decode(bytes).rgba]).toEqual([10, 20, 30, 255]);
    expect(
      decode(image(6, 8, undefined, [srgb(), chromaticities()])).colorSpace,
    ).toBe("srgb");
  });
  it("rejects conflicting color declarations, not merely unknown color", () => {
    expect(() =>
      decode(image(6, 8, undefined, [srgb(), integers("gAMA", [100000])])),
    ).toThrow(/PNG_COLOR_CONFLICT/);
  });
  it.each([
    ["unknown critical", [chunk("ABCD")]],
    ["reserved bit", [chunk("abca")]],
    [
      "duplicate palette",
      [chunk("PLTE", Buffer.of(1, 2, 3)), chunk("PLTE", Buffer.of(1, 2, 3))],
    ],
    ["invalid transparency", [chunk("tRNS", Buffer.of(0))]],
  ])("rejects %s", (_name, chunks) => {
    expect(() => decode(image(6, 8, undefined, chunks as Buffer[]))).toThrow(
      /PNG_/,
    );
  });
  it("rejects Adam7 explicitly without entering pngjs's unbounded interlace inflater", () => {
    const bytes = Buffer.concat([
      signature,
      header(6, 8, 1, 1, 1),
      chunk("IDAT", deflateSync(Buffer.of(0, 10, 20, 30, 255))),
      chunk("IEND"),
    ]);
    expect(() => decode(bytes)).toThrow(/PNG_INTERLACE_UNSUPPORTED/);
  });
  it("retains opaque bounded ICC bytes without attesting sRGB or evaluating tags", () => {
    const bytes = image(6, 8, undefined, [iccp()]);
    const original = Buffer.from(bytes);
    expect(decode(bytes)).toMatchObject({
      colorSpace: "unknown",
      alpha: "opaque",
    });
    expect([...decode(bytes).rgba]).toEqual([10, 20, 30, 255]);
    expect(bytes).toEqual(original);
    expect(
      decode(image(0, 8, Buffer.of(0, 42), [iccp(profile(true))])).colorSpace,
    ).toBe("unknown");
  });
  it.each([
    ["declared size", (p: Buffer) => p.writeUInt32BE(p.length + 1)],
    ["signature", (p: Buffer) => p.write("bad!", 36)],
    ["color model", (p: Buffer) => p.write("GRAY", 16)],
    ["tag offset", (p: Buffer) => p.writeUInt32BE(0xfffffff0, 136)],
    ["tag length", (p: Buffer) => p.writeUInt32BE(0xfffffff0, 140)],
    ["tag overlap header", (p: Buffer) => p.writeUInt32BE(128, 136)],
    [
      "reserved field",
      (p: Buffer) => {
        p[100] = 1;
      },
    ],
  ] as const)("rejects ICC %s", (_name, edit) => {
    const p = profile();
    edit(p);
    expect(() => decode(image(6, 8, undefined, [iccp(p)]))).toThrow(
      /PNG_MALFORMED/,
    );
  });
  it("enforces exact ICC bounds, completion and conflicts", () => {
    const bytes = image(6, 8, undefined, [iccp()]);
    expect(() =>
      decodeRaster(bytes, { ...limits, maxExpandedNodes: 4 }),
    ).toThrow(/PNG_CHUNKS/);
    expect(
      decodeRaster(bytes, { ...limits, maxExpandedNodes: 5 }).colorSpace,
    ).toBe("unknown");
    expect(() =>
      decodeRaster(bytes, { ...limits, maxOutputBytes: 163 }),
    ).toThrow(/PNG_INTERMEDIATE_BYTES/);
    expect(
      decodeRaster(bytes, { ...limits, maxOutputBytes: 164 }).colorSpace,
    ).toBe("unknown");
    expect(() => decode(image(6, 8, undefined, [srgb(), iccp()]))).toThrow(
      /PNG_COLOR_CONFLICT/,
    );
    expect(() =>
      decode(
        image(6, 8, undefined, [
          chunk(
            "iCCP",
            Buffer.concat([
              Buffer.from("Synthetic\0\0"),
              deflateSync(profile()),
              Buffer.of(0),
            ]),
          ),
        ]),
      ),
    ).toThrow(/PNG_MALFORMED/);
    const bomb = image(6, 8, undefined, [iccp(Buffer.alloc(100000))]);
    expect(() =>
      decodeRaster(bomb, { ...limits, maxOutputBytes: 1000 }),
    ).toThrow(/PNG_INTERMEDIATE_BYTES/);
  });
  it.each([
    ["zero dimension", header(6, 8, 0)],
    ["overflow dimensions", header(6, 8, 0x7fffffff, 0x7fffffff)],
    ["invalid RGB depth", header(2, 4)],
    ["invalid palette depth", header(3, 16)],
    ["invalid grayalpha depth", header(4, 2)],
    ["invalid color type", header(1, 8)],
    ["invalid interlace", header(6, 8, 1, 1, 2)],
  ] as const)("rejects header %s before allocation", (_name, hdr) => {
    expect(() =>
      decode(Buffer.concat([signature, hdr, chunk("IEND")])),
    ).toThrow();
  });
  it.each([
    ["missing palette", image(3, 8, Buffer.of(0, 0))],
    [
      "grayscale palette",
      image(0, 8, Buffer.of(0, 0), [chunk("PLTE", Buffer.of(1, 2, 3))]),
    ],
    [
      "oversized palette for bit depth",
      image(3, 1, Buffer.of(0, 0), [chunk("PLTE", Buffer.alloc(9))]),
    ],
    [
      "out of range palette index",
      image(3, 8, Buffer.of(0, 1), [chunk("PLTE", Buffer.of(1, 2, 3))]),
    ],
    ["late color metadata", image(6, 8, undefined, [], [srgb()])],
    ["duplicate color metadata", image(6, 8, undefined, [srgb(), srgb()])],
    ["invalid filter", image(6, 8, Buffer.of(5, 1, 2, 3, 4))],
    ["short scanline", image(6, 8, Buffer.of(0, 1))],
    ["extra scanline", image(6, 8, Buffer.alloc(10))],
    ["raster bomb", image(6, 8, Buffer.alloc(1000000))],
    ["trailing bytes", Buffer.concat([image(), Buffer.of(0)])],
    ["truncation", image().subarray(0, -1)],
    [
      "CRC",
      (() => {
        const b = image();
        b[29] = (b[29] ?? 0) ^ 1;
        return b;
      })(),
    ],
  ] as const)("rejects %s", (_name, bytes) => {
    expect(() => decode(bytes)).toThrow(/PNG_MALFORMED/);
  });
  it("validates all IDAT sequences and exact zlib completion", () => {
    const compressed = deflateSync(Buffer.of(0, 10, 20, 30, 255));
    const wrap = (data: Buffer[]) =>
      Buffer.concat([signature, header(), ...data, chunk("IEND")]);
    expect([
      ...decode(
        wrap([
          chunk("IDAT", compressed.subarray(0, 3)),
          chunk("IDAT", compressed.subarray(3)),
        ]),
      ).rgba,
    ]).toEqual([10, 20, 30, 255]);
    expect(() =>
      decode(
        wrap([
          chunk("IDAT", compressed.subarray(0, 3)),
          chunk("tEXt", Buffer.from("Synthetic\0text")),
          chunk("IDAT", compressed.subarray(3)),
        ]),
      ),
    ).toThrow(/PNG_MALFORMED/);
    for (const stream of [
      compressed.subarray(0, -1),
      Buffer.concat([compressed, Buffer.of(0)]),
      Buffer.concat([compressed, compressed]),
    ])
      expect(() => decode(wrap([chunk("IDAT", stream)]))).toThrow(
        /PNG_MALFORMED/,
      );
  });
  it("bounds exact scanline and 16-bit intermediate allocation, input and chunk counts", () => {
    expect(() =>
      decodeRaster(image(), { ...limits, maxOutputBytes: 4 }),
    ).toThrow(/PNG_INTERMEDIATE_BYTES/);
    expect(decodeRaster(image(), { ...limits, maxOutputBytes: 5 }).width).toBe(
      1,
    );
    const bytes = image(0, 16, Buffer.of(0, 128, 0));
    expect(() => decodeRaster(bytes, { ...limits, maxOutputBytes: 7 })).toThrow(
      /PNG_INTERMEDIATE_BYTES/,
    );
    expect(decodeRaster(bytes, { ...limits, maxOutputBytes: 8 }).width).toBe(1);
    expect(() =>
      decodeRaster(bytes, { ...limits, maxExpandedNodes: 2 }),
    ).toThrow(/PNG_CHUNKS/);
    expect(decodeRaster(bytes, { ...limits, maxExpandedNodes: 3 }).width).toBe(
      1,
    );
    expect(() =>
      decodeRaster(bytes, { ...limits, maxInputBytes: bytes.length - 1 }),
    ).toThrow(/INPUT_BYTES/);
    expect(
      decodeRaster(bytes, { ...limits, maxInputBytes: bytes.length }).width,
    ).toBe(1);
  });
  it("skips bounded ancillary text without inflating it and never promotes unknown semantics", () => {
    const compressedText = chunk(
      "zTXt",
      Buffer.concat([
        Buffer.from("Synthetic\0\0"),
        deflateSync(Buffer.alloc(1000000)),
      ]),
    );
    const international = chunk("iTXt", Buffer.from("Synthetic\0\0\0\0\0text"));
    const result = decode(
      image(6, 8, undefined, [srgb(), compressedText], [international]),
    );
    expect(result.colorSpace).toBe("srgb");
    expect(
      decode(image(6, 8, undefined, [srgb(), chunk("vpAg")])).colorSpace,
    ).toBe("unknown");
  });
  it("applies exact authored transparency keys to RGB and gray", () => {
    expect([
      ...decode(
        image(0, 8, Buffer.of(0, 42), [chunk("tRNS", Buffer.of(0, 42))]),
      ).rgba,
    ]).toEqual([0, 0, 0, 0]);
    expect([
      ...decode(
        image(2, 8, Buffer.of(0, 10, 20, 30), [
          chunk("tRNS", Buffer.of(0, 10, 0, 20, 0, 30)),
        ]),
      ).rgba,
    ]).toEqual([0, 0, 0, 0]);
  });
});
