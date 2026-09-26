import { expect, test } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const args = [
  "figma",
  "reference-fork",
  "--project",
  "capture_00000000-0000-4000-8000-000000000001",
  "--request-id",
  "original",
  "--expected-job",
  "a".repeat(64),
  "--expected-recovery",
  "b".repeat(64),
  "--confirm",
  "FORK-VERIFIED-INPUTS-AND-CONVERT-OFFLINE",
];
test("fork command binds exact recorded origin and requires explicit fresh-destination conversion confirmation", () => {
  expect(parseCaptureArguments(args)).toMatchObject({
    command: "figma-reference-fork",
    capture: {
      operation: "reference-fork",
      requestId: "original",
      expectedJob: "a".repeat(64),
      expectedRecovery: "b".repeat(64),
    },
  });
});
test.each([
  "--url",
  "--destination",
  "--stage",
  "--output",
  "--expected-proof",
])("fork rejects unsupported %s authority", (option) => {
  expect(() => parseCaptureArguments([...args, option, "forbidden"])).toThrow();
});
test.each([6, 8, 10])("fork requires bound argument at %s", (index) => {
  const changed = [...args];
  changed[index + 1] = "invalid";
  expect(() => parseCaptureArguments(changed)).toThrow();
});
test("fork-result admits only exact completed receipt without output-write arguments", () => {
  const input = [
    "figma",
    "reference-fork-result",
    "--project",
    args[3]!,
    "--request-id",
    "inspect",
    "--expected-receipt",
    "c".repeat(64),
  ];
  expect(parseCaptureArguments(input)).toMatchObject({
    command: "figma-reference-fork-result",
    capture: { expectedReceipt: "c".repeat(64) },
  });
  expect(() =>
    parseCaptureArguments([...input, "--output", "report.json"]),
  ).toThrow();
  expect(() => parseCaptureArguments(input.slice(0, -2))).toThrow();
});
