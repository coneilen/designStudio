import { inflateSync } from "node:zlib";
import type { Budget } from "@design-studio/contracts";
import { AssetError, bound, fail } from "./core.js";

/** Structural ICC validation only; no tag evaluation, strings, or color transforms. */
export function validatePngProfile(
  compressed: Buffer,
  grayscale: boolean,
  limits: Budget,
  remainingNodes: number,
): void {
  const malformed = () =>
    fail("PNG_MALFORMED", "Invalid embedded color profile.");
  let profile: Buffer | undefined;
  try {
    const inflated: unknown = inflateSync(compressed, {
      maxOutputLength: Math.min(26214400, limits.maxOutputBytes),
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
    profile = inflated.buffer;
    const bytes = profile;
    const matches = (offset: number, text: string) =>
      bytes.subarray(offset, offset + 4).equals(Buffer.from(text, "ascii"));
    if (
      inflated.engine.bytesWritten !== compressed.length ||
      profile.length < 132 ||
      profile.readUInt32BE(0) !== profile.length ||
      !matches(36, "acsp") ||
      !matches(16, grayscale ? "GRAY" : "RGB ") ||
      !["XYZ ", "Lab "].some((value) => matches(20, value)) ||
      profile[10] !== 0 ||
      profile[11] !== 0 ||
      profile.readUInt32BE(64) > 3 ||
      profile.subarray(100, 128).some((v) => v !== 0)
    )
      malformed();
    if (
      (profile[8] !== 2 && profile[8] !== 4) ||
      !["scnr", "mntr", "prtr", "spac"].some((value) => matches(12, value))
    )
      fail(
        "PNG_COLOR_UNSUPPORTED",
        "Unsupported embedded profile version or class.",
      );
    const count = profile.readUInt32BE(128);
    bound("PNG_CHUNKS", count, remainingNodes);
    const tableEnd = 132 + count * 12;
    if (tableEnd > profile.length) malformed();
    const tags = new Set<number>();
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < count; i++) {
      const at = 132 + i * 12;
      const tag = profile.readUInt32BE(at);
      const start = profile.readUInt32BE(at + 4);
      const size = profile.readUInt32BE(at + 8);
      if (
        tags.has(tag) ||
        start < tableEnd ||
        start % 4 ||
        size < 8 ||
        start + size > profile.length
      )
        malformed();
      if (profile.readUInt32BE(start + 4) !== 0) malformed();
      tags.add(tag);
      spans.push({ start, end: start + size });
    }
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i++) {
      const previous = spans[i - 1];
      const current = spans[i];
      if (
        previous &&
        current &&
        current.start < previous.end &&
        (current.start !== previous.start || current.end !== previous.end)
      )
        malformed();
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    )
      fail(
        "PNG_INTERMEDIATE_BYTES",
        "Embedded profile expansion exceeds the allocation bound.",
      );
    malformed();
  } finally {
    profile?.fill(0);
  }
}
