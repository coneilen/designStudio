import { crc32, inflateSync } from "node:zlib";
import type { Budget } from "@design-studio/contracts";
import { AssetError, bound, fail } from "./core.js";
import { validatePngProfile } from "./png-profile.js";

const standardChromaticities = [
  31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000,
];
const malformed = () =>
  fail("PNG_MALFORMED", "Invalid PNG structure or metadata.");
const singleton = new Set([
  "sRGB",
  "gAMA",
  "cHRM",
  "iCCP",
  "sBIT",
  "pHYs",
  "bKGD",
  "hIST",
  "tIME",
]);
const beforePalette = new Set(["sRGB", "gAMA", "cHRM", "iCCP", "sBIT"]);
const beforeData = new Set([...beforePalette, "pHYs", "bKGD", "hIST"]);

function keyword(data: Buffer): number {
  const end = data.indexOf(0);
  if (
    end < 1 ||
    end > 79 ||
    data[0] === 32 ||
    data[end - 1] === 32 ||
    data
      .subarray(0, end)
      .some(
        (v, i) =>
          v < 32 || (v > 126 && v < 161) || (v === 32 && data[i - 1] === 32),
      )
  )
    malformed();
  return end;
}
function textEnvelope(type: string, data: Buffer): void {
  const end = keyword(data);
  if (type === "tEXt") {
    if (data.subarray(end + 1).includes(0)) malformed();
  } else if (type === "zTXt") {
    if (data[end + 1] !== 0 || data.length <= end + 2) malformed();
  } else {
    if ((data[end + 1] !== 0 && data[end + 1] !== 1) || data[end + 2] !== 0)
      malformed();
    const languageEnd = data.indexOf(0, end + 3);
    const translatedEnd = data.indexOf(0, languageEnd + 1);
    if (languageEnd < end + 3 || translatedEnd < languageEnd + 1) malformed();
  }
  // Compressed text is opaque ancillary data: never inflate or expose it.
}

/** Validate allocation sizes and the complete zlib stream before pngjs allocates. */
export function validatePng(b: Buffer, limits: Budget) {
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let channels = 0;
  let rowBytes = 0;
  let inflatedSize = 0;
  let state: "header" | "before-data" | "data" | "after-data" | "end" =
    "header";
  let paletteEntries = 0;
  let transparent = false;
  let srgb = false;
  let unknownColor = false;
  let gamma: number | undefined;
  let standardChrm = true;
  let profile: Buffer | undefined;
  const seen = new Set<string>();
  const idats: Buffer[] = [];
  let chunks = 0;
  for (let offset = 8; offset < b.length; ) {
    bound("PNG_CHUNKS", ++chunks, Math.min(20000, limits.maxExpandedNodes));
    if (offset + 12 > b.length || state === "end") malformed();
    const size = b.readUInt32BE(offset);
    const end = offset + size + 12;
    if (size > 0x7fffffff || end > b.length) malformed();
    const name = b.subarray(offset + 4, offset + 8);
    if (name.some((v) => !((v >= 65 && v <= 90) || (v >= 97 && v <= 122))))
      malformed();
    if (((name[2] ?? 0) & 32) !== 0) malformed();
    const type = name.toString("ascii");
    const data = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4))
      malformed();
    if (state === "header" && type !== "IHDR") malformed();
    if (type !== "IDAT" && state === "data") state = "after-data";
    if (type === "IHDR") {
      if (state !== "header" || size !== 13) malformed();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      color = data[9] ?? -1;
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff)
        malformed();
      bound(
        "RASTER_PIXELS",
        width * height,
        Math.min(6553600, limits.maxRasterPixels),
      );
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validDepths[color]?.includes(depth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        (data[12] !== 0 && data[12] !== 1)
      )
        malformed();
      if (data[12] === 1)
        fail(
          "PNG_INTERLACE_UNSUPPORTED",
          "Adam7 decoding is not bounded by this implementation.",
        );
      channels = color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 1;
      rowBytes = Math.ceil((width * channels * depth) / 8);
      inflatedSize = (rowBytes + 1) * height;
      const allocationLimit = Math.min(26214400, limits.maxOutputBytes);
      bound("OUTPUT_BYTES", width * height * 4, allocationLimit);
      // pngjs materializes a 16-bit RGBA bitmap before its 8-bit normalization.
      bound(
        "PNG_INTERMEDIATE_BYTES",
        width * height * (depth === 16 ? 8 : 4),
        allocationLimit,
      );
      bound("PNG_INTERMEDIATE_BYTES", inflatedSize, allocationLimit);
      state = "before-data";
    } else if (type === "PLTE") {
      if (
        state !== "before-data" ||
        paletteEntries ||
        transparent ||
        seen.has("bKGD") ||
        seen.has("hIST") ||
        color === 0 ||
        color === 4 ||
        size < 3 ||
        size > 768 ||
        size % 3
      )
        malformed();
      paletteEntries = size / 3;
      if (color === 3 && paletteEntries > 2 ** depth) malformed();
    } else if (type === "tRNS") {
      if (state !== "before-data" || transparent) malformed();
      transparent = true;
      if (color === 3) {
        if (!paletteEntries || size < 1 || size > paletteEntries) malformed();
      } else if (color === 0 || color === 2) {
        if (size !== (color === 0 ? 2 : 6)) malformed();
        for (let i = 0; i < size; i += 2)
          if (data.readUInt16BE(i) >= 2 ** depth) malformed();
      } else malformed();
    } else if (type === "IDAT") {
      if (
        (state !== "before-data" && state !== "data") ||
        (color === 3 && !paletteEntries)
      )
        malformed();
      state = "data";
      idats.push(data);
    } else if (type === "IEND") {
      if (size || state !== "after-data" || !idats.length || end !== b.length)
        malformed();
      state = "end";
    } else {
      if (["acTL", "fcTL", "fdAT"].includes(type))
        fail(
          "PNG_ANIMATION_UNSUPPORTED",
          "Animated PNG is not a static reference.",
        );
      if (((name[0] ?? 0) & 32) === 0)
        fail("PNG_CRITICAL_UNSUPPORTED", "Unknown critical PNG chunk.");
      if (singleton.has(type)) {
        if (seen.has(type)) malformed();
        seen.add(type);
      }
      if (beforeData.has(type) && state !== "before-data") malformed();
      if (beforePalette.has(type) && paletteEntries) malformed();
      if (type === "sRGB") {
        if (size !== 1 || (data[0] ?? 4) > 3) malformed();
        srgb = true;
      } else if (type === "gAMA") {
        if (size !== 4 || data.readUInt32BE(0) === 0) malformed();
        gamma = data.readUInt32BE(0);
      } else if (type === "cHRM") {
        if (size !== 32) malformed();
        for (let i = 0; i < 8; i += 2) {
          const x = data.readUInt32BE(i * 4);
          const y = data.readUInt32BE((i + 1) * 4);
          if (!y || x + y > 100000) malformed();
        }
        standardChrm = standardChromaticities.every(
          (v, i) => data.readUInt32BE(i * 4) === v,
        );
      } else if (type === "iCCP") {
        const end = keyword(data);
        if (data[end + 1] !== 0 || data.length <= end + 2) malformed();
        profile = data.subarray(end + 2);
        unknownColor = true;
      } else if (type === "sBIT") {
        const samples = color === 3 ? 3 : channels;
        if (
          size !== samples ||
          data.some((v) => v === 0 || v > (color === 3 ? 8 : depth))
        )
          malformed();
      } else if (type === "pHYs") {
        if (size !== 9 || (data[8] ?? 2) > 1) malformed();
      } else if (type === "bKGD") {
        if (color === 3) {
          if (
            !paletteEntries ||
            size !== 1 ||
            (data[0] ?? 256) >= paletteEntries
          )
            malformed();
        } else {
          if (size !== (color === 0 || color === 4 ? 2 : 6)) malformed();
          for (let i = 0; i < size; i += 2)
            if (data.readUInt16BE(i) >= 2 ** depth) malformed();
        }
      } else if (type === "hIST") {
        if (!paletteEntries || size !== paletteEntries * 2) malformed();
      } else if (type === "tIME") {
        if (
          size !== 7 ||
          (data[2] ?? 0) < 1 ||
          (data[2] ?? 13) > 12 ||
          (data[3] ?? 0) < 1 ||
          (data[3] ?? 32) > 31 ||
          (data[4] ?? 24) > 23 ||
          (data[5] ?? 60) > 59 ||
          (data[6] ?? 61) > 60
        )
          malformed();
      } else if (["tEXt", "zTXt", "iTXt"].includes(type)) {
        textEnvelope(type, data);
      } else {
        // Copy safety constrains editors, not decoding unchanged originals.
        unknownColor = true;
      }
    }
    offset = end;
  }
  if (state !== "end") malformed();
  if (
    srgb &&
    (seen.has("iCCP") ||
      (gamma !== undefined && gamma !== 45455) ||
      !standardChrm)
  )
    fail("PNG_COLOR_CONFLICT", "Conflicting PNG color declarations.");
  if (profile)
    validatePngProfile(
      profile,
      color === 0 || color === 4,
      limits,
      Math.min(20000, limits.maxExpandedNodes) - chunks,
    );
  try {
    const compressed = Buffer.concat(idats);
    const inflated: unknown = inflateSync(compressed, {
      maxOutputLength: inflatedSize,
      info: true,
    });
    if (
      typeof inflated !== "object" ||
      !inflated ||
      !("buffer" in inflated) ||
      !Buffer.isBuffer(inflated.buffer) ||
      !("engine" in inflated) ||
      typeof inflated.engine !== "object" ||
      !inflated.engine ||
      !("bytesWritten" in inflated.engine)
    )
      fail("DECODER_CONTRACT", "Bounded inflate information is unavailable.");
    try {
      if (
        inflated.buffer.length !== inflatedSize ||
        inflated.engine.bytesWritten !== compressed.length
      )
        malformed();
      for (let row = 0; row < height; row++)
        if ((inflated.buffer[row * (rowBytes + 1)] ?? 5) > 4) malformed();
    } finally {
      inflated.buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    malformed();
  }
  return { width, height, depth, srgb: srgb && !unknownColor };
}
