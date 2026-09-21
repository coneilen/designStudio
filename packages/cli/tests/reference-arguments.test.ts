import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const base = [
  "--project",
  "capture_11111111-1111-4111-8111-111111111111",
  "--request-id",
  "original",
];
const origin = "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
it("separates preview, explicit approval and one-shot download without URL/path knobs", () => {
  for (const verb of ["reference-plan", "reference-inspect"])
    expect(parseCaptureArguments(["figma", verb, ...base])).toMatchObject({
      capture: { operation: verb, requestId: "original" },
    });
  expect(
    parseCaptureArguments([
      "figma",
      "reference-approve",
      ...base,
      "--origin",
      origin,
      "--expected-proof",
      "a".repeat(64),
      "--confirm",
      "APPROVE-ONE-SELECTED-REFERENCE",
    ]),
  ).toMatchObject({ capture: { operation: "reference-approve", origin } });
  expect(
    parseCaptureArguments([
      "figma",
      "reference-download",
      ...base,
      "--expected-approval",
      "a".repeat(64),
      "--confirm",
      "DOWNLOAD-ONE-APPROVED-REFERENCE",
    ]),
  ).toMatchObject({ capture: { operation: "reference-download" } });
  for (const extra of [
    ["--url", `${origin}/arbitrary.png`],
    ["--path", "private.json"],
    ["--artifact", "sha256_proof"],
    ["--next-request-id", "new"],
    ["--retry", "true"],
  ])
    expect(() =>
      parseCaptureArguments(["figma", "reference-plan", ...base, ...extra]),
    ).toThrow();
  for (const badOrigin of [
    `${origin}/`,
    `${origin}:443`,
    "https://*.amazonaws.com",
    "https://foreign.invalid",
  ])
    expect(() =>
      parseCaptureArguments([
        "figma",
        "reference-approve",
        ...base,
        "--origin",
        badOrigin,
        "--expected-proof",
        "a".repeat(64),
        "--confirm",
        "APPROVE-ONE-SELECTED-REFERENCE",
      ]),
    ).toThrow();
  for (const verb of ["reference-approve", "reference-download"])
    expect(() => parseCaptureArguments(["figma", verb, ...base])).toThrow();
});
