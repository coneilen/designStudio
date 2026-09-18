import type { Budget, FontResource } from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  bound,
  fail,
  inputLimit,
  type RightsAuthority,
  type RightsUse,
  sha256,
  verifyBytes,
  verifyRights,
} from "./core.js";
import { classify } from "./media.js";

function slice(bytes: Buffer, offset: number, length: number): Buffer {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  )
    fail("FONT_MALFORMED", "Font table range is outside the file");
  return bytes.subarray(offset, offset + length);
}

function names(table: Buffer) {
  if (table.length < 6 || table.readUInt16BE(0) !== 0)
    fail("FONT_UNSUPPORTED", "Only name table format 0 is supported");
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  slice(table, 6, count * 12);
  if (storage < 6 + count * 12)
    fail("FONT_MALFORMED", "Overlapping name strings");
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const record = slice(table, 6 + i * 12, 12);
    const value = slice(
      table,
      storage + record.readUInt16BE(10),
      record.readUInt16BE(8),
    );
    // Pin Windows Unicode English or Unicode-platform names, not host-locale-dependent selection.
    if (
      (record.readUInt16BE(0) === 3 &&
        [1, 10].includes(record.readUInt16BE(2)) &&
        record.readUInt16BE(4) === 0x409) ||
      record.readUInt16BE(0) === 0
    ) {
      if (value.length % 2) fail("FONT_MALFORMED", "Odd UTF-16 name length");
      let text: string;
      try {
        text = new TextDecoder("utf-16be", { fatal: true }).decode(value);
      } catch {
        fail("FONT_MALFORMED", "Invalid font name encoding");
      }
      const id = record.readUInt16BE(6);
      const prior = found.get(id);
      if (prior !== undefined && prior !== text)
        fail("FONT_UNSUPPORTED", "Conflicting Unicode font names");
      found.set(id, text);
    }
  }
  const required = (id: number) => {
    const value = found.get(id);
    if (!value)
      fail("FONT_UNSUPPORTED", "Required Unicode face identity is missing");
    return value;
  };
  return {
    family: found.get(16) ?? required(1),
    subfamily: found.get(17) ?? required(2),
    version: required(5),
    postScriptName: required(6),
  };
}

function cmapLookup(table: Buffer, glyphCount: number): (cp: number) => number {
  if (table.length < 4 || table.readUInt16BE(0) !== 0)
    fail("FONT_MALFORMED", "Invalid cmap header");
  const count = table.readUInt16BE(2);
  slice(table, 4, count * 8);
  let chosen: Buffer | undefined;
  let priority = 0;
  for (let i = 0; i < count; i++) {
    const r = slice(table, 4 + i * 8, 8);
    const platform = r.readUInt16BE(0);
    const encoding = r.readUInt16BE(2);
    const offset = r.readUInt32BE(4);
    const format = slice(table, offset, 2).readUInt16BE(0);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding)))
      continue;
    if (format !== 4 && format !== 12) continue;
    const length =
      format === 12
        ? slice(table, offset, 8).readUInt32BE(4)
        : slice(table, offset, 4).readUInt16BE(2);
    const subtable = slice(table, offset, length);
    if (format > priority) {
      chosen = subtable;
      priority = format;
    }
  }
  if (!chosen) fail("FONT_UNSUPPORTED", "Unicode cmap format 4 or 12 required");
  const b = chosen;
  const validGlyph = (glyph: number) => {
    if (glyph >= glyphCount)
      fail("FONT_MALFORMED", "cmap references a nonexistent glyph");
    return glyph;
  };
  if (priority === 12) {
    if (b.length < 16) fail("FONT_MALFORMED", "Truncated cmap12");
    const groups = b.readUInt32BE(12);
    slice(b, 16, groups * 12);
    let previous = -1;
    for (let i = 0; i < groups; i++) {
      const pos = 16 + i * 12;
      const start = b.readUInt32BE(pos);
      const end = b.readUInt32BE(pos + 4);
      if (start <= previous || end < start || end > 0x10ffff)
        fail("FONT_MALFORMED", "Invalid cmap12 group ordering");
      validGlyph(b.readUInt32BE(pos + 8) + end - start);
      previous = end;
    }
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const pos = 16 + mid * 12;
        if (cp < b.readUInt32BE(pos)) hi = mid - 1;
        else if (cp > b.readUInt32BE(pos + 4)) lo = mid + 1;
        else
          return validGlyph(b.readUInt32BE(pos + 8) + cp - b.readUInt32BE(pos));
      }
      return 0;
    };
  }
  if (b.length < 16 || b.readUInt16BE(6) % 2)
    fail("FONT_MALFORMED", "Invalid cmap4 header");
  const segments = b.readUInt16BE(6) / 2;
  if (!segments) fail("FONT_MALFORMED", "Empty cmap4");
  slice(b, 0, 16 + segments * 8);
  const starts = 16 + segments * 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  let previous = -1;
  for (let i = 0; i < segments; i++) {
    const start = b.readUInt16BE(starts + i * 2);
    const end = b.readUInt16BE(14 + i * 2);
    if (start <= previous || end < start)
      fail("FONT_MALFORMED", "Invalid cmap4 segments");
    const offset = b.readUInt16BE(ranges + i * 2);
    if (
      offset &&
      (offset % 2 || ranges + i * 2 + offset < ranges + segments * 2)
    )
      fail("FONT_MALFORMED", "Invalid cmap4 glyph offset");
    if (offset) slice(b, ranges + i * 2 + offset, (end - start + 1) * 2);
    previous = end;
  }
  if (previous !== 0xffff) fail("FONT_MALFORMED", "Missing cmap4 sentinel");
  return (cp) => {
    if (cp > 0xffff) return 0;
    let lo = 0;
    let hi = segments - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = b.readUInt16BE(starts + mid * 2);
      if (cp < start) hi = mid - 1;
      else if (cp > b.readUInt16BE(14 + mid * 2)) lo = mid + 1;
      else {
        const delta = b.readInt16BE(deltas + mid * 2);
        const offset = b.readUInt16BE(ranges + mid * 2);
        const glyph = offset
          ? b.readUInt16BE(ranges + mid * 2 + offset + (cp - start) * 2)
          : cp;
        return validGlyph(offset && glyph === 0 ? 0 : (glyph + delta) & 0xffff);
      }
    }
    return 0;
  };
}

export function inspectFont(bytes: Uint8Array, text: string, limits: Budget) {
  inputLimit(bytes, limits);
  bound("FONT_TEXT_BYTES", Buffer.byteLength(text), limits.maxInputBytes);
  if (classify(bytes) !== "font/ttf")
    fail(
      "FONT_UNSUPPORTED",
      "Only standalone static TrueType sfnt fonts are supported",
    );
  const b = Buffer.from(bytes);
  if (b.length < 12) fail("FONT_MALFORMED", "Truncated sfnt header");
  const count = b.readUInt16BE(4);
  if (!count || count > 128)
    fail("FONT_UNSUPPORTED", "Font table count exceeds supported profile");
  slice(b, 12, count * 16);
  const tables = new Map<string, Buffer>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const record = slice(b, 12 + i * 16, 16);
    const tag = record.toString("ascii", 0, 4);
    const offset = record.readUInt32BE(8);
    const length = record.readUInt32BE(12);
    if (
      tables.has(tag) ||
      offset < 12 + count * 16 ||
      offset % 4 ||
      ranges.some(([start, end]) => offset < end && offset + length > start)
    )
      fail(
        "FONT_MALFORMED",
        "Duplicate, overlapping or misaligned font tables",
      );
    const table = slice(b, offset, length);
    let checksum = 0;
    for (let j = 0; j < length; j += 4) {
      let word = 0;
      for (let k = 0; k < 4; k++)
        word =
          (word * 256 +
            (tag === "head" && j === 8 ? 0 : (table[j + k] ?? 0))) >>>
          0;
      checksum = (checksum + word) >>> 0;
    }
    if (checksum !== record.readUInt32BE(4))
      fail("FONT_MALFORMED", "Invalid table checksum");
    tables.set(tag, table);
    ranges.push([offset, offset + length]);
  }
  if (
    ["fvar", "CFF ", "CFF2", "SVG ", "COLR", "CBDT", "sbix"].some((tag) =>
      tables.has(tag),
    )
  )
    fail(
      "FONT_UNSUPPORTED",
      "Variable, CFF and color/vector glyphs are outside the static TrueType profile",
    );
  const required = (tag: string, minimum: number) => {
    const value = tables.get(tag);
    if (!value || value.length < minimum)
      fail("FONT_MALFORMED", "Required font table missing or truncated");
    return value;
  };
  const head = required("head", 54);
  if (head.readUInt32BE(12) !== 0x5f0f3cf5)
    fail("FONT_MALFORMED", "Invalid font head magic");
  const glyphCount = required("maxp", 6).readUInt16BE(4);
  const loca = required("loca", 2);
  const glyf = required("glyf", 1);
  const locaFormat = head.readInt16BE(50);
  if (locaFormat !== 0 && locaFormat !== 1)
    fail("FONT_MALFORMED", "Invalid loca format");
  slice(loca, 0, (glyphCount + 1) * (locaFormat ? 4 : 2));
  let last = 0;
  for (let i = 0; i <= glyphCount; i++) {
    const offset = locaFormat
      ? loca.readUInt32BE(i * 4)
      : loca.readUInt16BE(i * 2) * 2;
    if (offset < last || offset > glyf.length)
      fail("FONT_MALFORMED", "Invalid glyph bounds");
    last = offset;
  }
  const os2 = required("OS/2", 64);
  const identity = names(required("name", 6));
  const lookup = cmapLookup(required("cmap", 4), glyphCount);
  const missingCodePoints = [
    ...new Set(
      [...text]
        .filter((char) => !["\n", "\r", "\t"].includes(char))
        .map((char) => char.codePointAt(0) ?? 0)
        .filter((cp) => !lookup(cp)),
    ),
  ];
  const style =
    (os2.readUInt16BE(62) & 1) !== 0
      ? ("italic" as const)
      : ("normal" as const);
  return {
    ...identity,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    textSha256: sha256(text),
    style,
    weight: os2.readUInt16BE(4),
    fsType: os2.readUInt16BE(8),
    missingCodePoints,
  };
}

export function verifyFont(
  bytes: Uint8Array,
  expected: FontResource,
  text: string,
  notice: Uint8Array,
  use: RightsUse,
  authority: RightsAuthority,
  limits: Budget,
) {
  inputLimit(bytes, limits);
  inputLimit(notice, limits);
  if (!validateContract("FontResource", expected).success)
    fail("FONT_REQUIREMENT", "Invalid font requirement");
  verifyBytes(
    bytes,
    expected.kind === "bundled"
      ? expected.artifact
      : {
          sha256: expected.expectedSha256,
          byteLength: expected.expectedByteLength,
        },
  );
  verifyRights(expected.license, bytes, notice, use, authority);
  const actual = inspectFont(bytes, text, limits);
  if (
    actual.family !== expected.family ||
    actual.postScriptName !== expected.postScriptName ||
    actual.style !== expected.style ||
    actual.weight !== expected.weight ||
    actual.version !== expected.version
  )
    fail(
      "FONT_FACE",
      "Requested face differs from actual font tables; synthesis/substitution is prohibited",
    );
  if (actual.missingCodePoints.length)
    fail(
      "FONT_GLYPHS",
      "Requested text contains missing glyphs; inspectFont provides code point details",
    );
  return actual;
}
