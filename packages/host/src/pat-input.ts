import { HostBoundaryError } from "./guards.js";

export const PAT_MAX_BYTES = 4096;
export const PAT_CLIPBOARD_MAX_BYTES = 16384;
function invalid(): never {
  throw new HostBoundaryError(
    "INVALID_INPUT",
    "Enter one PAT containing 1..4096 printable ASCII characters; no whitespace or multiline input.",
  );
}
export function validatePatBytes(bytes: Uint8Array): void {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.buffer instanceof SharedArrayBuffer ||
    bytes.byteLength < 1 ||
    bytes.byteLength > PAT_MAX_BYTES ||
    bytes.some((byte) => byte < 33 || byte > 126)
  )
    invalid();
}
export function decodePatUtf16(input: Uint8Array): Buffer {
  if (
    !(input instanceof Uint8Array) ||
    input.buffer instanceof SharedArrayBuffer ||
    input.byteLength < 4 ||
    input.byteLength > PAT_CLIPBOARD_MAX_BYTES ||
    input.byteLength % 2
  )
    invalid();
  const view = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let length = 0;
  let terminated = false;
  for (let offset = 0; offset < view.length; offset += 2) {
    const value = view.readUInt16LE(offset);
    if (terminated) {
      if (value !== 0) invalid();
    } else if (value === 0) terminated = true;
    else {
      if (value < 33 || value > 126 || ++length > PAT_MAX_BYTES) invalid();
    }
  }
  if (!terminated || !length) invalid();
  const result = Buffer.alloc(length);
  for (let index = 0; index < length; index++)
    result[index] = view.readUInt16LE(index * 2);
  return result;
}
export function patUtf16(bytes: Uint8Array): Buffer {
  validatePatBytes(bytes);
  const result = Buffer.alloc((bytes.length + 1) * 2);
  for (let index = 0; index < bytes.length; index++)
    result.writeUInt16LE(bytes[index] ?? 0, index * 2);
  return result;
}
export function replacementLength(
  length: number,
  start: number,
  end: number,
  inserted: number,
): number {
  if (
    [length, start, end, inserted].some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > PAT_MAX_BYTES,
    ) ||
    start > end ||
    end > length ||
    length - (end - start) + inserted > PAT_MAX_BYTES
  )
    invalid();
  return length - (end - start) + inserted;
}
