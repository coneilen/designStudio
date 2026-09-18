import { performance } from "node:perf_hooks";
import type { JsonObject } from "@design-studio/contracts";
import * as kernel from "@design-studio/design-ir";
import { afterEach, expect, it, vi } from "vitest";
import * as boundary from "../src/boundary.js";
import { convertFigmaSnapshot } from "../src/index.js";

function input(children: number, unknownProperties = 0) {
  const document: JsonObject = {
    id: "1:2",
    type: "FRAME",
    name: "Original work-count fixture",
    absoluteBoundingBox: { x: 0, y: 0, width: 240, height: 160 },
    children: Array.from({ length: children }, (_, index) => ({
      id: `2:${index}`,
      type: "RECTANGLE",
      absoluteBoundingBox: { x: index % 200, y: 0, width: 1, height: 1 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    })),
  };
  for (let index = 0; index < unknownProperties; index++)
    document[`future_${index}`] = index;
  const bytes = Buffer.from(JSON.stringify({ nodes: { "1:2": { document } } }));
  return {
    manifest: {
      schemaVersion: "1.0",
      format: "figma-rest-nodes-v1",
      selectionUrl:
        "https://www.figma.com/design/SyntheticFixture/Original?node-id=1-2",
      structure: {
        id: "raw",
        path: "raw.json",
        mediaType: "application/json",
        byteLength: bytes.length,
        sha256: kernel.hashBytes(bytes),
      },
      assets: [],
      fonts: [],
    },
    structureBytes: bytes,
    projectId: "project_work",
    designId: "design_work",
    intakeId: "intake_work",
    actorId: "actor_work",
    observedAt: "2026-09-18T00:00:00Z",
  };
}

afterEach(() => vi.restoreAllMocks());

it("rejects oversized reports at the configured entry boundary without truncation", () => {
  try {
    convertFigmaSnapshot(input(0, 2048), { maxReportEntries: 128 });
    throw new Error("Expected a report limit.");
  } catch (error) {
    expect(error).toBeInstanceOf(boundary.FigmaImportError);
    if (!(error instanceof boundary.FigmaImportError)) throw error;
    expect(error.diagnostic.limit).toEqual({
      measured: 129,
      allowed: 128,
      unit: "node",
    });
  }
  expect(() =>
    convertFigmaSnapshot(input(0), { maxReportEntries: 200_001 }),
  ).toThrow("Invalid conversion budget");
});

it("keeps loss and diagnostic deduplication work bounded for thousands of properties", () => {
  const original = Array.prototype.some;
  let comparisons = 0;
  vi.spyOn(Array.prototype, "some").mockImplementation(function (
    this: unknown[],
    predicate,
    receiver,
  ) {
    return original.call(this, (value, index, array) => {
      if (
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string" &&
        /^(loss|diagnostic)_/.test(value.id)
      )
        comparisons++;
      return predicate.call(receiver, value, index, array);
    });
  });
  const result = convertFigmaSnapshot(input(0, 2048));
  expect(
    result.report.losses.filter((loss) => loss.pointer.includes("/future_")),
  ).toHaveLength(2048);
  expect(comparisons).toBeLessThan(2048 * 4);
});

it("checks the deadline at every source property instead of after the whole inventory", () => {
  const digest = kernel.canonicalDigest;
  let now = 0;
  let propertyLosses = 0;
  vi.spyOn(kernel, "canonicalDigest").mockImplementation((value) => {
    const hash = digest(value);
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      typeof value[1] === "string" &&
      value[1].includes("/future_")
    ) {
      propertyLosses++;
      now = 100;
    }
    return hash;
  });
  expect(() =>
    convertFigmaSnapshot(input(0, 1024), { deadline: 100, now: () => now }),
  ).toThrow("deadline expired");
  expect(propertyLosses).toBe(1);
});

it("resolves evidence only by its complete artifact identity", () => {
  const validate = kernel.validateProvenance;
  vi.spyOn(kernel, "validateProvenance").mockImplementation(
    (design, snapshot, resolve) => {
      if (!resolve) throw new Error("Missing resolver.");
      return validate(design, snapshot, (entry) =>
        resolve({
          ...entry,
          artifact: { ...entry.artifact, sha256: "0".repeat(64) },
        }),
      );
    },
  );
  expect(() => convertFigmaSnapshot(input(0))).toThrow(
    "Unknown evidence artifact",
  );
});

it("validates the complete projection once, not once per evidence resolution", () => {
  const spy = vi.spyOn(boundary, "shape");
  function work(children: number) {
    spy.mockClear();
    const result = convertFigmaSnapshot(input(children));
    const wholeProjection = spy.mock.calls.filter(
      ([name, value]) =>
        name === "JsonValue" && value === result.conversionEvidence,
    );
    const namedProjection = spy.mock.calls.filter(
      ([name]) => name === "FigmaConversionEvidence",
    );
    expect(wholeProjection).toHaveLength(1);
    expect(namedProjection).toHaveLength(1);
    return {
      wholeVisits:
        wholeProjection.length * result.conversionEvidence.entries.length,
      totalCalls: spy.mock.calls.length,
    };
  }
  const small = work(16);
  const large = work(32);
  expect(large.wholeVisits).toBeLessThanOrEqual(2 * small.wholeVisits);
  expect(large.totalCalls).toBeLessThanOrEqual(2 * small.totalCalls);
});

it("stops at the next evidence resolution when its deadline expires", () => {
  const validate = kernel.validateProvenance;
  let now = 0;
  let resolutions = 0;
  vi.spyOn(kernel, "validateProvenance").mockImplementation(
    (design, snapshot, resolve) => {
      if (!resolve)
        throw new Error("Expected real source evidence resolution.");
      return validate(design, snapshot, (entry) => {
        resolutions++;
        const value = resolve(entry);
        if (resolutions === 1) now = 100;
        return value;
      });
    },
  );
  expect(() =>
    convertFigmaSnapshot(input(16), { deadline: 100, now: () => now }),
  ).toThrow("deadline expired");
  expect(resolutions).toBe(2);
});

it("records a bounded 256-child synthetic observation without a timing threshold", () => {
  const selected = input(256);
  const start = performance.now();
  const result = convertFigmaSnapshot(selected);
  const elapsedMs = performance.now() - start;
  expect(result.sourceMap.entries).toHaveLength(257);
  expect(result.source.consistency.guarantee).toBe("unknown");
  console.info(
    JSON.stringify({
      observation: "synthetic-conversion-not-a-performance-guarantee",
      children: 256,
      inputBytes: selected.structureBytes.length,
      elapsedMs: Math.round(elapsedMs),
    }),
  );
});
