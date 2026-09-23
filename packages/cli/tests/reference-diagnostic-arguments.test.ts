import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const base = [
  "--project",
  "capture_00000000-0000-4000-8000-000000000001",
  "--request-id",
  "original",
];
it("requires a Job digest for the separately admitted read-only recovery plan and rejects write/URL overrides", () => {
  const args = [
    "figma",
    "reference-recovery-plan",
    ...base,
    "--expected-job",
    "a".repeat(64),
  ];
  expect(parseCaptureArguments(args)).toMatchObject({
    command: "figma-reference-recovery-plan",
    capture: {
      operation: "reference-recovery-plan",
      requestId: "original",
      expectedJob: "a".repeat(64),
    },
  });
  expect(() =>
    parseCaptureArguments(["figma", "reference-recovery-plan", ...base]),
  ).toThrow();
  for (const extra of [
    ["--job-id", "diagnostic_arbitrary"],
    ["--url", "https://private.invalid"],
    ["--confirm", "DOWNLOAD-ONE-DIAGNOSTIC-REFERENCE"],
    ["--path", "private"],
    ["--inspection", "metadata-only"],
    ["--expected-job", "b".repeat(64)],
  ])
    expect(() => parseCaptureArguments([...args, ...extra])).toThrow();
  expect(() =>
    parseCaptureArguments([
      "figma",
      "reference-diagnostic-inspect",
      ...base,
      "--expected-job",
      "a".repeat(64),
    ]),
  ).toThrow();
});
it("gates metadata-only inspection without changing the default or admitting arbitrary jobs", () => {
  expect(
    parseCaptureArguments(["figma", "reference-diagnostic-inspect", ...base]),
  ).toMatchObject({
    capture: {
      operation: "reference-diagnostic-inspect",
      requestId: "original",
    },
  });
  expect(
    parseCaptureArguments([
      "figma",
      "reference-diagnostic-inspect",
      ...base,
      "--inspection",
      "metadata-only",
    ]),
  ).toMatchObject({
    capture: {
      operation: "reference-diagnostic-inspect",
      requestId: "original",
      inspection: "metadata-only",
    },
  });
  for (const verb of [
    "reference-inspect",
    "reference-diagnostic-plan",
    "reference-diagnostic-download",
  ])
    expect(() =>
      parseCaptureArguments([
        "figma",
        verb,
        ...base,
        "--inspection",
        "metadata-only",
      ]),
    ).toThrow();
  for (const suffix of [
    ["--inspection", "full"],
    ["--inspection", "metadata-only", "--inspection", "metadata-only"],
    ["--job-id", "diagnostic_synthetic"],
  ])
    expect(() =>
      parseCaptureArguments([
        "figma",
        "reference-diagnostic-inspect",
        ...base,
        ...suffix,
      ]),
    ).toThrow();
});
it("admits explicit diagnostic planning without caller-selected acquisition IDs or URLs", () => {
  expect(
    parseCaptureArguments(["figma", "reference-diagnostic-plan", ...base]),
  ).toMatchObject({
    capture: { operation: "reference-diagnostic-plan", requestId: "original" },
  });
});
it("requires separate explicit diagnostic approval and download confirmations", () => {
  expect(
    parseCaptureArguments([
      "figma",
      "reference-diagnostic-approve",
      ...base,
      "--origin",
      "https://figma-alpha-api.s3.us-west-2.amazonaws.com",
      "--expected-proof",
      "a".repeat(64),
      "--confirm",
      "APPROVE-ONE-DIAGNOSTIC-REFERENCE",
    ]),
  ).toMatchObject({ capture: { operation: "reference-diagnostic-approve" } });
  expect(
    parseCaptureArguments([
      "figma",
      "reference-diagnostic-download",
      ...base,
      "--expected-approval",
      "b".repeat(64),
      "--confirm",
      "DOWNLOAD-ONE-DIAGNOSTIC-REFERENCE",
    ]),
  ).toMatchObject({ capture: { operation: "reference-diagnostic-download" } });
  for (const extra of [
    ["--url", "https://private.invalid"],
    ["--acquisition-id", "new"],
    ["--predecessor", "other"],
  ])
    expect(() =>
      parseCaptureArguments([
        "figma",
        "reference-diagnostic-plan",
        ...base,
        ...extra,
      ]),
    ).toThrow();
});
