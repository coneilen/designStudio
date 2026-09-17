import { expect, test } from "vitest";
import {
  captureInstallationForTest,
  traceInstallation,
} from "../src/installation-diagnostics.js";

test("private diagnostics are absent by default and capture only bounded numeric phase data", () => {
  expect(traceInstallation(false)).toBeUndefined();
  const capture = captureInstallationForTest(() => 10);
  try {
    const trace = traceInstallation(false);
    if (!trace) throw new Error("Test trace not installed.");
    const started = trace.time();
    trace.phase("file-pins", started, 3);
    expect(() => capture.close()).toThrow(/active/);
    trace.end(true);
    expect(capture.samples.map((sample) => sample.phase)).toEqual([
      "start",
      "file-pins",
      "end",
    ]);
    expect(capture.samples[1]).toMatchObject({
      count: 3,
      handles: 10,
      active: 1,
      success: 1,
    });
    for (const sample of capture.samples)
      for (const [key, value] of Object.entries(sample))
        if (!["mode", "phase"].includes(key))
          expect(typeof value).toBe("number");
  } finally {
    capture.close();
  }
  expect(traceInstallation(true)).toBeUndefined();
});

test("sampling faults at start phase and end cannot strand active traces or replace primary outcomes", () => {
  for (const failingCall of [1, 2, 3]) {
    let calls = 0;
    const samplingError = new Error("injected handle sampler failure");
    const capture = captureInstallationForTest(() => {
      if (++calls === failingCall) throw samplingError;
      return 10;
    });
    const primary = new Error("original authority or cleanup failure");
    let observed: unknown;
    try {
      const trace = traceInstallation(false);
      if (!trace) throw new Error("Expected trace.");
      try {
        trace.phase("file-pins", trace.time(), 1);
        throw primary;
      } finally {
        trace.end(false);
        trace.end(false);
      }
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(primary);
    expect(() => capture.close()).toThrow(/diagnostic capture failed/i);
    expect(traceInstallation(false)).toBeUndefined();
    expect(capture.failure).toMatchObject({ samplingErrors: 1 });
  }
});

test("sample cap admits exactly 2048 records and reports overflow only after quiescence", () => {
  const capture = captureInstallationForTest(() => 10);
  const trace = traceInstallation(false);
  if (!trace) throw new Error("Expected trace.");
  for (let index = 1; index < 2048; index++)
    trace.phase("prepare", trace.time());
  expect(capture.samples).toHaveLength(2048);
  expect(() => trace.phase("prepare", trace.time())).not.toThrow();
  expect(() => capture.close()).toThrow(/still active/);
  expect(() => trace.end(true)).not.toThrow();
  trace.end(true);
  expect(capture.samples).toHaveLength(2048);
  expect(capture.failure).toMatchObject({
    overflowed: true,
    droppedSamples: 2,
  });
  expect(() => capture.close()).toThrow(/diagnostic capture failed/i);
  const next = captureInstallationForTest(() => 20);
  next.close();
});

test("overflow on a later trace start does not leave phantom activity", () => {
  const capture = captureInstallationForTest(() => 10);
  const first = traceInstallation(false);
  if (!first) throw new Error("Expected trace.");
  for (let index = 1; index < 2047; index++)
    first.phase("prepare", first.time());
  first.end(true);
  expect(capture.samples).toHaveLength(2048);
  const second = traceInstallation(false);
  expect(second).toBeDefined();
  second?.end(true);
  expect(() => capture.close()).toThrow(/diagnostic capture failed/i);
  expect(capture.failure).toMatchObject({
    overflowed: true,
    droppedSamples: 2,
  });
  expect(traceInstallation(false)).toBeUndefined();
});
