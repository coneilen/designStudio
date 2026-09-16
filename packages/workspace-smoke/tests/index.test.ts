import { describe, expect, it } from "vitest";
import { fingerprintFixture } from "../src/index.js";

describe("synthetic fixture fingerprint", () => {
  it("returns the SHA-256 known-answer digest of empty bytes", () => {
    expect(fingerprintFixture(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("returns the SHA-256 known-answer digest of abc", () => {
    expect(fingerprintFixture(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes only the supplied byte view, not its backing buffer", () => {
    const bytes = Uint8Array.of(0, 97, 98, 99, 255);
    expect(fingerprintFixture(bytes.subarray(1, 4))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is repeatable without mutating the fixture", () => {
    const bytes = Uint8Array.of(0, 255, 13, 10);
    const original = bytes.slice();
    expect(fingerprintFixture(bytes)).toBe(fingerprintFixture(bytes));
    expect(bytes).toEqual(original);
  });

  it("distinguishes binary bytes and line endings", () => {
    expect(fingerprintFixture(Uint8Array.of(255))).not.toBe(
      fingerprintFixture(Uint8Array.of(254)),
    );
    expect(fingerprintFixture(Buffer.from("abc\r\n"))).not.toBe(
      fingerprintFixture(Buffer.from("abc\n")),
    );
  });
});
