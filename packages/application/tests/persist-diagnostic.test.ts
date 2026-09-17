import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { persistDiagnostic } from "./persist-diagnostic.js";

it("retains validated failure reports after only candidate data is cleaned", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f08-report-test-"));
  try {
    const candidate = path.join(root, "candidate");
    await mkdir(candidate);
    await writeFile(
      path.join(candidate, "temporary.txt"),
      "owned temporary data",
    );
    const target = path.join(root, "report.json");
    const report = {
      version: 1,
      timeOrigin: 0,
      pid: 123,
      instance: 1,
      role: 1,
      incomplete: 1,
      exitFallback: 1,
      samplingErrors: 0,
      droppedSamples: 1,
      samples: 0,
      maxGapMs: 12,
      ticks: 1,
      groups: [],
      ends: [],
      records: [],
    };
    await persistDiagnostic(target, {
      version: 1,
      testOnly: true,
      functionalPassed: false,
      captureComplete: false,
      measurement: undefined,
      reports: [report],
    });
    await rm(candidate, { recursive: true });
    const saved = JSON.parse(await readFile(target, "utf8"));
    expect(saved.functionalPassed).toBe(false);
    expect(saved.captureComplete).toBe(false);
    expect(saved.reports).toEqual([report]);
    await expect(
      persistDiagnostic(target, {
        version: 1,
        testOnly: true,
        functionalPassed: true,
        captureComplete: true,
        measurement: undefined,
        reports: [],
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});
it("refuses secret fields rather than persisting unchecked diagnostic content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f08-report-test-"));
  try {
    await expect(
      persistDiagnostic(path.join(root, "report.json"), {
        version: 1,
        testOnly: true,
        functionalPassed: true,
        captureComplete: false,
        measurement: { path: "private" },
        reports: [],
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});
