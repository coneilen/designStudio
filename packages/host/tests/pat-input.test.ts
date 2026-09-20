import { expect, it } from "vitest";
import {
  decodePatUtf16,
  patUtf16,
  replacementLength,
} from "../src/pat-input.js";

it("accepts only complete bounded printable ASCII UTF-16 before edit insertion", () => {
  for (const length of [1, 4096]) {
    const input = Buffer.alloc((length + 1) * 2);
    for (let index = 0; index < length; index++)
      input.writeUInt16LE(65, index * 2);
    const bytes = decodePatUtf16(input);
    expect(bytes.byteLength).toBe(length);
    expect(patUtf16(bytes)).toEqual(input);
    bytes.fill(0);
  }
});
it("rejects multiline, NUL/trailing data, truncation, oversized allocation and non-ASCII", () => {
  for (const input of [
    Buffer.alloc(2),
    Buffer.from("first\r\nsecond\0", "utf16le"),
    Buffer.from("first\0second\0", "utf16le"),
    Buffer.from("no-terminator", "utf16le"),
    Buffer.from("non-ascii-\u00e9\0", "utf16le"),
    Buffer.from("space inside\0", "utf16le"),
    Buffer.alloc(16386),
    Buffer.from([65, 0, 0]),
    Buffer.from(`${"x".repeat(4097)}\0`, "utf16le"),
  ])
    expect(() => decodePatUtf16(input)).toThrow();
});
it("validates replacement bounds before native control can truncate", () => {
  expect(replacementLength(4096, 0, 4096, 4096)).toBe(4096);
  expect(replacementLength(1, 0, 1, 0)).toBe(0);
  for (const args of [
    [4096, 4096, 4096, 1],
    [5, 4, 1, 2],
    [5, 0, 6, 1],
    [-1, 0, 0, 1],
  ])
    expect(() =>
      replacementLength(
        args[0] ?? -1,
        args[1] ?? -1,
        args[2] ?? -1,
        args[3] ?? -1,
      ),
    ).toThrow();
});
