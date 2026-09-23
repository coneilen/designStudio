import type { AssetResource, Budget } from "@design-studio/contracts";
import { PNG } from "pngjs";
import { AssetError, bound, fail, inputLimit } from "./core.js";
import { validatePng } from "./png.js";

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
  bound("INPUT_BYTES", bytes.byteLength, 26214400);
  if (classify(bytes) !== "image/png")
    fail(
      "RASTER_UNSUPPORTED",
      "Only bounded static noninterlaced PNG decoding is implemented",
    );
  const b = Buffer.from(bytes);
  const { width, height, depth, srgb } = validatePng(b, limits);
  try {
    const decoded = PNG.sync.read(b, {
      checkCRC: true,
      skipRescale: depth === 16,
    });
    const samples: unknown = decoded.data;
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      !(samples instanceof Uint8Array || samples instanceof Uint16Array) ||
      (depth === 16) !== samples instanceof Uint16Array ||
      samples.length !== width * height * 4
    )
      fail("PNG_MALFORMED", "Decoder dimensions disagree");
    let alpha: AssetResource["alpha"] = "opaque";
    for (let i = 3; i < samples.length; i += 4)
      if (samples[i] !== (depth === 16 ? 65535 : 255)) {
        alpha = "straight";
        break;
      }
    const rgba =
      samples instanceof Uint16Array
        ? Uint8Array.from(samples, (value) =>
            Math.floor((value * 255) / 65535 + 0.5),
          )
        : samples;
    if (samples instanceof Uint16Array) samples.fill(0);
    return {
      mediaType: "image/png",
      width,
      height,
      colorSpace: srgb ? "srgb" : "unknown",
      alpha,
      rgba,
    };
  } catch (error) {
    if (error instanceof AssetError) throw error;
    if (error instanceof Error)
      fail("PNG_MALFORMED", "PNG decompression or decoding failed");
    throw error;
  }
}
