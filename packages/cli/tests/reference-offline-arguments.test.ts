import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const base = [
  "--project",
  "capture_00000000-0000-4000-8000-000000000001",
  "--request-id",
  "original",
  "--expected-job",
  "a".repeat(64),
];
it.each(["reference-recovery-apply-plan", "reference-recovery-inspect"])(
  "accepts only closed offline %s input",
  (operation) => {
    expect(
      parseCaptureArguments(["figma", operation, ...base]).capture,
    ).toEqual({
      operation,
      requestId: "original",
      expectedJob: "a".repeat(64),
    });
    for (const extra of [
      "--url",
      "--path",
      "--job-id",
      "--artifact-id",
      "--confirm",
      "--expected-job",
    ])
      expect(() =>
        parseCaptureArguments([
          "figma",
          operation,
          ...base,
          extra,
          "untrusted",
        ]),
      ).toThrow();
  },
);
it("requires independent confirmation and current proof for apply and derived conversion", () => {
  const apply = [
    "figma",
    "reference-recovery-apply",
    ...base,
    "--expected-proof",
    "b".repeat(64),
    "--confirm",
    "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  ];
  expect(parseCaptureArguments(apply).capture?.operation).toBe(
    "reference-recovery-apply",
  );
  expect(() => parseCaptureArguments(apply.slice(0, -2))).toThrow();
  expect(() =>
    parseCaptureArguments([
      ...apply.slice(0, -1),
      "DOWNLOAD-ONE-DIAGNOSTIC-REFERENCE",
    ]),
  ).toThrow();
  const convert = [
    "figma",
    "convert-reference",
    ...base,
    "--expected-recovery",
    "c".repeat(64),
    "--confirm",
    "CONVERT-WITH-RECOVERED-REFERENCE",
  ];
  expect(parseCaptureArguments(convert).capture?.operation).toBe(
    "convert-reference",
  );
  expect(() =>
    parseCaptureArguments([
      ...convert.slice(0, -1),
      "RECOVER-VERIFIED-REFERENCE-OFFLINE",
    ]),
  ).toThrow();
});
