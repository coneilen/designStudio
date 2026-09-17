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
