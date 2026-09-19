import { expect, it } from "vitest";
import { parseCaptureArguments } from "../src/capture-main.js";

const project = "capture_11111111-1111-4111-8111-111111111111";
it("admits one explicit selected-frame native capture with a logical idempotency key", () => {
  expect(
    parseCaptureArguments([
      "figma",
      "capture",
      "--project",
      project,
      "--url",
      "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
      "--request-id",
      "one",
    ]),
  ).toMatchObject({
    command: "figma-capture",
    project,
    capture: { operation: "capture", requestId: "one" },
  });
});
it("rejects arbitrary roots, origin grants, tokens and unbound inspection flags", () => {
  for (const flag of ["--root", "--token", "--origin", "--url"]) {
    expect(() =>
      parseCaptureArguments([
        "figma",
        "inspect",
        "--project",
        project,
        "--request-id",
        "one",
        flag,
        "secret",
      ]),
    ).toThrow();
  }
});
