import { expect, it } from "vitest";
import { extendedDrivePath, nativeDrivePath } from "../src/windows-paths.js";

it("adds an internal extended-length prefix without changing canonical drive-path identity", () => {
  const filename = `C:\\owned space\\${"segment\\".repeat(40)}unicode-\u03bb.bin`;
  expect(filename.length).toBeGreaterThan(260);
  expect(extendedDrivePath(filename)).toBe(`\\\\?\\${filename}`);
  expect(nativeDrivePath(`\\\\?\\${filename}`)).toBe(filename);
  expect(extendedDrivePath("d:\\owned\\file.bin")).toBe(
    "\\\\?\\d:\\owned\\file.bin",
  );
});

it.each([
  "\\\\?\\C:\\owned\\file.bin",
  "\\\\.\\C:\\owned\\file.bin",
  "\\\\?\\UNC\\server\\share\\file.bin",
  "\\\\server\\share\\file.bin",
  "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.bin",
  "\\??\\C:\\owned\\file.bin",
  "\\Device\\HarddiskVolume1\\file.bin",
  "\\rooted.bin",
  "C:relative.bin",
  "relative.bin",
  "C:/owned/file.bin",
  "C:\\owned\\..\\file.bin",
  "C:\\owned\\.\\file.bin",
  "C:\\owned\\\\file.bin",
  "C:\\owned\\file.bin:stream",
  "C:\\owned\\file. ",
  "C:\\owned\\NUL.txt",
  "C:\\owned\\wild*.bin",
  "C:\\owned\\bad\0.bin",
  `C:\\${"a".repeat(256)}\\file.bin`,
  `C:\\${"a\\".repeat(16381)}file.bin`,
])(
  "rejects caller namespace or noncanonical path %j before native conversion",
  (filename) => {
    expect(() => extendedDrivePath(filename)).toThrow();
  },
);

it.each([
  "\\\\?\\UNC\\server\\share\\file.bin",
  "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\file.bin",
  "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.bin",
  "\\\\.\\C:\\owned\\file.bin",
  "C:\\owned\\file.bin",
  "\\\\?\\C:\\owned\\..\\file.bin",
])(
  "rejects unexpected native-returned namespace %j instead of stripping it blindly",
  (filename) => {
    expect(() => nativeDrivePath(filename)).toThrow();
  },
);
