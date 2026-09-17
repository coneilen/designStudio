import { expect, it } from "vitest";
import { phaseReport } from "./phase-report.js";

const sample = {
  version: 1,
  timeOrigin: 0,
  pid: 123,
  instance: 1,
  role: 1,
  incomplete: 0,
  exitFallback: 0,
  samplingErrors: 0,
  droppedSamples: 0,
  samples: 0,
  maxGapMs: 12,
  ticks: 1,
  groups: [],
  ends: [],
  records: [],
};
it("accepts bounded numeric captures and preserves incomplete state", () => {
  expect(
    phaseReport(Buffer.from(JSON.stringify(sample)), "123-1.json"),
  ).toEqual(sample);
  expect(
    phaseReport(
      Buffer.from(JSON.stringify({ ...sample, incomplete: 1 })),
      "123-1.json",
    ).incomplete,
  ).toBe(1);
});
it("rejects secret/path fields, filename mismatches and oversized data", () => {
  for (const extra of [
    { token: "secret" },
    { path: "C:\\private" },
    { message: "raw" },
  ])
    expect(() =>
      phaseReport(
        Buffer.from(JSON.stringify({ ...sample, ...extra })),
        "123-1.json",
      ),
    ).toThrow();
  expect(() =>
    phaseReport(Buffer.from(JSON.stringify(sample)), "../123-1.json"),
  ).toThrow();
  expect(() =>
    phaseReport(Buffer.from(JSON.stringify(sample)), "999-1.json"),
  ).toThrow();
  expect(() => phaseReport(Buffer.alloc(16385), "123-1.json")).toThrow();
});
