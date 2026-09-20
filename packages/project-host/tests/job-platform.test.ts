import { expect, it } from "vitest";
import { supportsNativeJob } from "./job-platform.js";

it.each([
  ["win32", "x64", true],
  ["win32", "arm64", false],
  ["win32", "ia32", false],
  ["linux", "x64", false],
  ["darwin", "arm64", false],
] as const)(
  "native Job test admission for %s/%s is %s",
  (platform, architecture, expected) => {
    expect(supportsNativeJob(platform, architecture)).toBe(expected);
  },
);
