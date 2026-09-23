import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const base = [
  "--project",
  "capture_00000000-0000-4000-8000-000000000001",
  "--request-id",
  "original",
];
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
