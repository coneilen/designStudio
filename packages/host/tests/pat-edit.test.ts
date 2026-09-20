import { expect, it } from "vitest";
import { PatEditBoundary } from "../src/pat-edit.js";

it("validates the full clipboard before insertion and zeroes only owned copies", () => {
  let clipboard = Buffer.from("first\r\nsecond\0", "utf16le");
  let inserts = 0;
  let clears = 0;
  let reads = 0;
  let field = Buffer.alloc(0);
  const source = Buffer.from(clipboard);
  const edit = new PatEditBoundary({
    clipboard: () => {
      reads++;
      return clipboard;
    },
    length: () => field.length / 2,
    selection: () => ({ start: 0, end: field.length / 2 }),
    insert: (bytes) => {
      inserts++;
      field = Buffer.from(bytes.subarray(0, bytes.length - 2));
    },
    read: () => Buffer.concat([field, Buffer.alloc(2)]),
    clear: () => {
      clears++;
      field.fill(0);
      field = Buffer.alloc(0);
    },
    changed: () => {},
    rejected: () => {},
  });
  expect(reads).toBe(0);
  expect(edit.paste()).toBe(false);
  expect(inserts).toBe(0);
  expect(clears).toBe(1);
  expect(clipboard.every((byte) => byte === 0)).toBe(true);
  expect(source.toString("utf16le")).toBe("first\r\nsecond\0");
  clipboard = Buffer.from("synthetic-valid\0", "utf16le");
  expect(edit.paste()).toBe(true);
  expect(inserts).toBe(1);
  const token = edit.submit();
  expect(token?.toString()).toBe("synthetic-valid");
  token?.fill(0);
  field.fill(0);
  source.fill(0);
});
