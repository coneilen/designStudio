import { readFileSync } from "node:fs";
import type { ResourceSnapshot } from "@design-studio/contracts";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import { inspectFont, sha256, verifyFont } from "../src/index.js";

const root = new URL("../../../tests/fixtures/foundation/", import.meta.url);
const font = readFileSync(new URL("assets/ABeeZee-Regular.ttf", root));
const notice = readFileSync(new URL("assets/OFL.txt", root));
const resources: ResourceSnapshot = JSON.parse(
  readFileSync(new URL("resources.json", root), "utf8"),
);
const face = resources.fonts[0];
if (!face) throw new Error("Pinned fixture face is required");

describe("actual font byte/face/rights/coverage", () => {
  it("binds coverage evidence to exact font bytes and unnormalized requested text", () => {
    expect(inspectFont(font, "Hello", DEFAULT_BUDGETS)).toMatchObject({
      sha256: sha256(font),
      byteLength: font.length,
      textSha256: sha256("Hello"),
    });
    expect(inspectFont(font, "H\u00e9", DEFAULT_BUDGETS).textSha256).not.toBe(
      inspectFont(font, "He\u0301", DEFAULT_BUDGETS).textSha256,
    );
  });
  it("reads actual names, style, weight and version from pinned OFL bytes", () => {
    const result = verifyFont(
      font,
      face,
      "Hello",
      notice,
      "redistribute",
      () => true,
      DEFAULT_BUDGETS,
    );
    expect(result).toMatchObject({
      family: "ABeeZee",
      postScriptName: "ABeeZee-Regular",
      weight: 400,
      style: "normal",
      missingCodePoints: [],
    });
    expect(result.version).toContain("1.003");
    expect(result.fsType).toBeTypeOf("number");
  });
  it.each([
    { family: "Arial" },
    { weight: 700 },
    { style: "italic" as const },
    { postScriptName: "Fake-Regular" },
    { version: "Version 99" },
  ])("rejects missing/substituted/synthesized face %j", (change) => {
    expect(() =>
      verifyFont(
        font,
        { ...face, ...change },
        "Hello",
        notice,
        "redistribute",
        () => true,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/FONT_FACE/);
  });
  it("rejects modified font and license bytes", () => {
    const modified = Buffer.from(font);
    modified[100] = (modified[100] ?? 0) ^ 1;
    expect(() =>
      verifyFont(
        modified,
        face,
        "Hello",
        notice,
        "redistribute",
        () => true,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/BYTE_IDENTITY/);
    expect(() =>
      verifyFont(
        font,
        face,
        "Hello",
        notice.subarray(1),
        "redistribute",
        () => true,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/BYTE_IDENTITY/);
  });
  it("never infers redistribution from installation or embedding flags", () => {
    expect(() =>
      verifyFont(
        font,
        { ...face, license: { ...face.license, redistribution: "unknown" } },
        "a",
        notice,
        "redistribute",
        () => true,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/RIGHTS_UNVERIFIED/);
    expect(() =>
      verifyFont(
        font,
        face,
        "a",
        notice,
        "local-render",
        () => false,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/RIGHTS_UNVERIFIED/);
  });
  it("reports missing glyphs without normalizing or substituting text", () => {
    expect(() =>
      verifyFont(
        font,
        face,
        "Hello\u{1f984}",
        notice,
        "redistribute",
        () => true,
        DEFAULT_BUDGETS,
      ),
    ).toThrow(/FONT_GLYPHS/);
    expect(
      inspectFont(font, "\u{1f984}", DEFAULT_BUDGETS).missingCodePoints,
    ).toEqual([0x1f984]);
  });
  it("rejects truncated/unsupported font tables", () => {
    expect(() =>
      inspectFont(font.subarray(0, 100), "a", DEFAULT_BUDGETS),
    ).toThrow(/FONT_MALFORMED/);
    expect(() =>
      inspectFont(Buffer.from("wOF2"), "a", DEFAULT_BUDGETS),
    ).toThrow(/FONT_UNSUPPORTED/);
  });
});
