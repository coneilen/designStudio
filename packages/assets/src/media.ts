import { crc32, inflateSync } from "node:zlib";
import type { AssetResource, Budget } from "@design-studio/contracts";
import { PNG } from "pngjs";
import { AssetError, bound, fail, inputLimit } from "./core.js";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function classify(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 8).equals(pngSignature)) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (b.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) return "font/ttf";
  if (
    /^\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/u.test(
      b.subarray(0, 1024).toString("utf8"),
    )
  )
    return "image/svg+xml";
  return "application/octet-stream";
}

export interface DecodedRaster {
  mediaType: "image/png";
  width: number;
  height: number;
  colorSpace: AssetResource["colorSpace"];
  alpha: AssetResource["alpha"];
  rgba: Uint8Array;
}

export function decodeRaster(bytes: Uint8Array, limits: Budget): DecodedRaster {
  inputLimit(bytes, limits);
  if (classify(bytes) !== "image/png")
    fail(
      "RASTER_UNSUPPORTED",
      "Only bounded 8-bit noninterlaced RGB/RGBA PNG decoding is implemented",
    );
  const b = Buffer.from(bytes);
  let width = 0;
  let height = 0;
  let channels = 0;
  let state = "header";
  let srgb = false;
  const idats: Buffer[] = [];
  const ancillary = new Set<string>();
  let chunks = 0;
  for (let offset = 8; offset < b.length; ) {
    bound("PNG_CHUNKS", ++chunks, limits.maxExpandedNodes);
    if (offset + 12 > b.length) fail("PNG_MALFORMED", "Truncated chunk");
    const size = b.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > b.length) fail("PNG_MALFORMED", "Truncated chunk payload");
    const type = b.toString("ascii", offset + 4, offset + 8);
    const data = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4))
      fail("PNG_MALFORMED", "Invalid chunk CRC");
    if (state === "header" && type !== "IHDR")
      fail("PNG_MALFORMED", "IHDR must be first");
    if (type === "IHDR") {
      if (state !== "header" || size !== 13)
        fail("PNG_MALFORMED", "Invalid IHDR");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff)
        fail("PNG_MALFORMED", "Invalid dimensions");
      bound("RASTER_PIXELS", width * height, limits.maxRasterPixels);
      bound("OUTPUT_BYTES", width * height * 4, limits.maxOutputBytes);
      if (
        data[8] !== 8 ||
        (data[9] !== 2 && data[9] !== 6) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        fail(
          "PNG_UNSUPPORTED",
          "Only 8-bit RGB/RGBA, compression/filter 0, noninterlaced PNG is supported",
        );
      channels = data[9] === 2 ? 3 : 4;
      state = "before-data";
    } else if (type === "IDAT") {
      if (state !== "before-data" && state !== "data")
        fail("PNG_MALFORMED", "Nonconsecutive IDAT");
      state = "data";
      idats.push(data);
    } else if (type === "IEND") {
      if (size !== 0 || state !== "data" || end !== b.length)
        fail("PNG_MALFORMED", "Invalid or trailing IEND");
      state = "end";
    } else {
      if (state !== "before-data" || ancillary.has(type))
        fail("PNG_MALFORMED", "Invalid ancillary chunk order or repetition");
      ancillary.add(type);
      if (type === "sRGB" && size === 1 && (data[0] ?? 4) <= 3) srgb = true;
      else if (
        type === "gAMA" &&
        size === 4 &&
        data.readUInt32BE(0) === 45455
      ) {
        /* Accepted standard gamma, not proof of sRGB primaries. */
      } else if (type === "pHYs" && size === 9 && (data[8] ?? 2) <= 1) {
        /* Physical density does not change pixel decoding. */
      } else
        fail(
          "PNG_UNSUPPORTED",
          "Unsupported color, animation, metadata or ancillary chunk",
        );
    }
    offset = end;
  }
  if (state !== "end") fail("PNG_MALFORMED", "Missing IEND");
  const inflatedSize = (width * channels + 1) * height;
  // Preinflate with an exact cap: pngjs's sync inflater alone is not the allocation boundary.
  try {
    const compressed = Buffer.concat(idats);
    const inflated: unknown = inflateSync(compressed, {
      maxOutputLength: inflatedSize,
      info: true,
    });
    if (
      typeof inflated !== "object" ||
      inflated === null ||
      !("buffer" in inflated) ||
      !Buffer.isBuffer(inflated.buffer) ||
      !("engine" in inflated) ||
      typeof inflated.engine !== "object" ||
      inflated.engine === null ||
      !("bytesWritten" in inflated.engine)
    )
      fail(
        "DECODER_CONTRACT",
        "Runtime did not provide bounded inflate information",
      );
    if (
      inflated.buffer.length !== inflatedSize ||
      inflated.engine.bytesWritten !== compressed.length
    )
      fail("PNG_MALFORMED", "Unexpected compressed stream length");
    for (let row = 0; row < height; row++) {
      if ((inflated.buffer[row * (width * channels + 1)] ?? 5) > 4)
        fail("PNG_MALFORMED", "Invalid scanline filter");
    }
    const decoded = PNG.sync.read(b, { checkCRC: true, skipRescale: true });
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      decoded.data.length !== width * height * 4
    )
      fail("PNG_MALFORMED", "Decoder dimensions disagree");
    let alpha: AssetResource["alpha"] = "opaque";
    for (let i = 3; i < decoded.data.length; i += 4)
      if (decoded.data[i] !== 255) {
        alpha = "straight";
        break;
      }
    return {
      mediaType: "image/png",
      width,
      height,
      colorSpace: srgb ? "srgb" : "unknown",
      alpha,
      rgba: decoded.data,
    };
  } catch (error) {
    if (error instanceof AssetError) throw error;
    if (error instanceof Error)
      fail("PNG_MALFORMED", "PNG decompression or decoding failed");
    throw error;
  }
}
