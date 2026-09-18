import { expect, test } from "vitest";
import {
  decodeInventory,
  encodeInventory,
} from "../src/installation-manifest.js";

test("candidate inventory is canonical, bounded and has no Windows path aliases", () => {
  const file = {
    path: "packages/cli/dist/main.js",
    bytes: 12,
    sha256: "1".repeat(64),
  };
  const good = [file];
  expect(decodeInventory(encodeInventory(good))).toEqual(good);
  for (const filename of [
    "../bad",
    "C:/bad",
    "a\\b",
    "a/CON",
    "a/file.",
    "a//b",
    "a:b",
    "a/%2e",
    "a/\u00e9",
  ]) {
    expect(() => encodeInventory([{ ...file, path: filename }])).toThrow();
  }
  expect(() =>
    encodeInventory([...good, { ...file, path: "PACKAGES/cli/dist/main.js" }]),
  ).toThrow();
  expect(() =>
    decodeInventory(Buffer.from(`${encodeInventory(good).toString()} `)),
  ).toThrow();
  expect(() =>
    encodeInventory([{ ...file, bytes: 512 * 1024 * 1024 + 1 }]),
  ).toThrow();
});
