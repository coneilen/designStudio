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

it("validates version two native timing and per-phase CPU/RSS without accepting payload fields", () => {
  const current = {
    ...sample,
    version: 2,
    groups: [
      {
        mode: "rehash",
        phase: "file-pins",
        calls: 1,
        totalMs: 10,
        maxMs: 10,
        count: 2,
        activeMax: 1,
        handlesMax: 100,
        rssBytesMax: 10000,
        cpuUserUs: 100,
        cpuSystemUs: 50,
      },
    ],
    native: {
      samplingErrors: 0,
      groups: [{ kind: "pin", calls: 2, totalMs: 10, maxMs: 6 }],
    },
  };
  const parse = (value: unknown) =>
    phaseReport(Buffer.from(JSON.stringify(value)), "123-1.json");
  expect(parse(current)).toEqual(current);
  for (const native of [
    { ...current.native, path: "private" },
    { ...current.native, samplingErrors: 1 },
    {
      ...current.native,
      groups: [{ ...current.native.groups[0], kind: ["pin"] }],
    },
    {
      ...current.native,
      groups: [...current.native.groups, ...current.native.groups],
    },
    {
      ...current.native,
      groups: [
        { ...current.native.groups[0], kind: "CreateFileW-private-path" },
      ],
    },
    { ...current.native, groups: [{ ...current.native.groups[0], maxMs: -1 }] },
  ])
    expect(() => parse({ ...current, native })).toThrow();
  expect(
    parse({
      ...current,
      incomplete: 1,
      native: { ...current.native, samplingErrors: 1 },
    }).incomplete,
  ).toBe(1);
  expect(() =>
    parse({
      ...current,
      groups: [{ ...current.groups[0], cpuUserUs: -1 }],
    }),
  ).toThrow();
});
