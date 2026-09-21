import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const proposal = [
  "figma",
  "recover",
  "--project",
  "capture_11111111-1111-4111-8111-111111111111",
  "--request-id",
  "failed_request",
  "--failed-job-id",
  `capture_${"a".repeat(64)}`,
  "--next-request-id",
  "next_request",
];
const confirmation = [
  "--expected-proof",
  "b".repeat(64),
  "--confirm",
  "AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA",
];
it("accepts separate bounded proposal and explicit-proof recording forms", () => {
  expect(parseCaptureArguments(proposal)).toMatchObject({
    command: "figma-recover",
    capture: {
      operation: "recover",
      requestId: "failed_request",
      nextRequestId: "next_request",
    },
  });
  expect([...proposal, ...confirmation]).toHaveLength(14);
  expect(parseCaptureArguments([...proposal, ...confirmation])).toMatchObject({
    capture: { expectedProof: "b".repeat(64), confirmation: confirmation[3] },
  });
});
it.each([
  "--url",
  "--token",
  "--root",
  "--policy",
  "--origin",
  "--reset",
  "--authorization",
  "--role",
])("refuses arbitrary recovery flag %s", (flag) => {
  expect(() =>
    parseCaptureArguments([...proposal, flag, "untrusted"]),
  ).toThrow();
});
it("refuses ambiguous, replay-changing, incomplete and excessive confirmations", () => {
  for (const args of [
    [...proposal, ...confirmation.slice(0, 2)],
    [...proposal, ...confirmation.slice(2)],
    [...proposal, ...confirmation.slice(0, 3), "yes"],
    [...proposal, "--next-request-id", "different"],
    [...proposal.slice(0, -1), "failed_request"],
    [...proposal.slice(0, -1), "x".repeat(257)],
    [...proposal, ...confirmation, "--json"],
    [...proposal.slice(0, 7), "capture_wrong", ...proposal.slice(8)],
  ])
    expect(() => parseCaptureArguments(args)).toThrow();
});
