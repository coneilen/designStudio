import { deflateSync, inflateSync } from "node:zlib";
import { canonicalBytes } from "@design-studio/design-ir";
import { HostBoundaryError } from "@design-studio/host";
import type { RenderWire } from "./worker.js";

const MAXIMUM = 25 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function packResources(
  value: Record<string, unknown> & { fonts: unknown[]; images: unknown[] },
  logicalSize: number,
): Uint8Array {
  const buffers: Buffer[] = [];
  const pack = (entry: unknown) => {
    if (
      !object(entry) ||
      typeof entry.bytes !== "string" ||
      "wireByteLength" in entry
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid binary resource entry.",
      );
    const { bytes, ...fields } = entry;
    const raw = Buffer.from(bytes, "base64");
    if (raw.toString("base64") !== bytes)
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid resource encoding.",
      );
    buffers.push(raw);
    return { ...fields, wireByteLength: raw.length };
  };
  const metadata = canonicalBytes({
    ...value,
    fonts: value.fonts.map(pack),
    images: value.images.map(pack),
  });
  const size =
    12 + metadata.byteLength + buffers.reduce((n, b) => n + b.length, 0);
  if (size > MAXIMUM)
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render binary envelope byte limit.",
    );
  const header = Buffer.alloc(12);
  header.write("DSB1", "ascii");
  header.writeUInt32BE(metadata.byteLength, 4);
  header.writeUInt32BE(logicalSize, 8);
  return Buffer.concat([header, metadata, ...buffers]);
}
export function encodeResourceWire(value: RenderWire): Uint8Array {
  // Models have passed admission; canonical base64 needs no JSON escaping.
  // Count its characters instead of materializing a second multi-MiB JSON body.
  const metadata = {
    ...value,
    fonts: value.fonts.map((f) => ({ ...f, bytes: "" })),
    images: value.images.map((image) => ({ ...image, bytes: "" })),
  };
  const size =
    canonicalBytes(metadata).byteLength +
    value.fonts.reduce((n, f) => n + f.bytes.length, 0) +
    value.images.reduce((n, image) => n + image.bytes.length, 0);
  if (size > Math.min(MAXIMUM, value.budget.maxInputBytes))
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render envelope logical input limit.",
    );
  return packResources({ ...value }, size);
}
export function encodeWire(value: unknown): Uint8Array {
  const json = canonicalBytes(value);
  if (json.byteLength > MAXIMUM)
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render envelope expansion limit.",
    );
  if (
    object(value) &&
    Array.isArray(value.fonts) &&
    Array.isArray(value.images)
  ) {
    return packResources(
      { ...value, fonts: value.fonts, images: value.images },
      json.byteLength,
    );
  }
  const header = Buffer.alloc(8);
  header.write("DSR1", "ascii");
  header.writeUInt32BE(json.byteLength, 4);
  return Buffer.concat([header, deflateSync(json, { level: 1 })]);
}
export function decodeEnvelope(
  bytes: Uint8Array,
  logicalLimit = MAXIMUM,
): unknown {
  if (bytes.byteLength > MAXIMUM)
    throw new HostBoundaryError("INPUT_LIMIT", "Render envelope byte limit.");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 4).toString("ascii") !== "DSB1")
    return JSON.parse(decodePayload(bytes, logicalLimit));
  if (b.length > MAXIMUM || b.length < 12)
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render binary envelope byte limit.",
    );
  const metaSize = b.readUInt32BE(4),
    logicalSize = b.readUInt32BE(8);
  if (
    !metaSize ||
    metaSize > b.length - 12 ||
    metaSize > Math.min(MAXIMUM, logicalLimit) ||
    !logicalSize ||
    logicalSize > Math.min(MAXIMUM, logicalLimit)
  )
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render binary envelope logical limit.",
    );
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(12, 12 + metaSize),
    ),
  );
  if (
    !object(value) ||
    !Array.isArray(value.fonts) ||
    !Array.isArray(value.images)
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid binary resource metadata.",
    );
  let offset = 12 + metaSize,
    base64Size = 0;
  const slices: {
    entry: Record<string, unknown>;
    start: number;
    end: number;
  }[] = [];
  for (const entry of [...value.fonts, ...value.images]) {
    if (
      !object(entry) ||
      !Number.isSafeInteger(entry.wireByteLength) ||
      typeof entry.wireByteLength !== "number" ||
      entry.wireByteLength < 0 ||
      entry.wireByteLength > b.length - offset ||
      "bytes" in entry
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid binary resource length.",
      );
    const size = entry.wireByteLength;
    delete entry.wireByteLength;
    entry.bytes = "";
    base64Size += 4 * Math.ceil(size / 3);
    slices.push({ entry, start: offset, end: offset + size });
    offset += size;
  }
  if (
    offset !== b.length ||
    Buffer.byteLength(JSON.stringify(value)) + base64Size !== logicalSize
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Binary envelope logical/trailing length mismatch.",
    );
  for (const slice of slices)
    slice.entry.bytes = b.subarray(slice.start, slice.end).toString("base64");
  return value;
}
export function logicalBytes(bytes: Uint8Array): number {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 4).toString("ascii") === "DSB1" && b.length >= 12)
    return b.readUInt32BE(8);
  if (b.subarray(0, 4).toString("ascii") === "DSR1" && b.length >= 8)
    return b.readUInt32BE(4);
  return b.length;
}
export function decodePayload(
  bytes: Uint8Array,
  logicalLimit = MAXIMUM,
): string {
  if (bytes.byteLength > MAXIMUM)
    throw new HostBoundaryError("INPUT_LIMIT", "Render envelope byte limit.");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 4).toString("ascii") === "DSB1")
    return JSON.stringify(decodeEnvelope(bytes, logicalLimit));
  if (b.subarray(0, 4).toString("ascii") !== "DSR1") {
    if (b.length > logicalLimit)
      throw new HostBoundaryError("INPUT_LIMIT", "Logical render input limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  }
  if (b.length < 9)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Truncated renderer envelope.",
    );
  const size = b.readUInt32BE(4);
  if (!size || size > Math.min(MAXIMUM, logicalLimit))
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Render envelope expansion limit.",
    );
  const result: unknown = inflateSync(b.subarray(8), {
    maxOutputLength: size,
    info: true,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("buffer" in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !("engine" in result) ||
    typeof result.engine !== "object" ||
    result.engine === null ||
    !("bytesWritten" in result.engine) ||
    result.engine.bytesWritten !== b.length - 8 ||
    result.buffer.length !== size
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Renderer compressed stream length mismatch.",
    );
  return new TextDecoder("utf-8", { fatal: true }).decode(result.buffer);
}
