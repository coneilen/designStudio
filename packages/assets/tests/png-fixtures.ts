import { crc32, deflateSync } from "node:zlib";

export const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
export function header(
  color = 6,
  depth = 8,
  width = 1,
  height = 1,
  interlace = 0,
): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width);
  data.writeUInt32BE(height, 4);
  data.set([depth, color, 0, 0, interlace], 8);
  return chunk("IHDR", data);
}
export function image(
  color = 6,
  depth = 8,
  raw = Buffer.from([0, 10, 20, 30, 255]),
  before: Buffer[] = [],
  after: Buffer[] = [],
  width = 1,
  height = 1,
): Buffer {
  return Buffer.concat([
    signature,
    header(color, depth, width, height),
    ...before,
    chunk("IDAT", deflateSync(raw)),
    ...after,
    chunk("IEND"),
  ]);
}
export const srgb = () => chunk("sRGB", Buffer.of(0));
export function integers(type: string, values: number[]) {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    data.writeUInt32BE(value, index * 4);
  });
  return chunk(type, data);
}
export const chromaticities = () =>
  integers("cHRM", [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]);
export function profile(grayscale = false): Buffer {
  const bytes = Buffer.alloc(164);
  bytes.writeUInt32BE(bytes.length);
  bytes[8] = 4;
  bytes.write("mntr", 12);
  bytes.write(grayscale ? "GRAY" : "RGB ", 16);
  bytes.write("XYZ ", 20);
  bytes.writeUInt16BE(2026, 24);
  bytes.writeUInt16BE(1, 26);
  bytes.writeUInt16BE(1, 28);
  bytes.write("acsp", 36);
  bytes.writeUInt32BE(1, 128);
  bytes.write("wtpt", 132);
  bytes.writeUInt32BE(144, 136);
  bytes.writeUInt32BE(20, 140);
  bytes.write("XYZ ", 144);
  return bytes;
}
export function iccp(bytes = profile()) {
  return chunk(
    "iCCP",
    Buffer.concat([Buffer.from("Synthetic\0\0"), deflateSync(bytes)]),
  );
}
