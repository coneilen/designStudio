import { expect, it } from "vitest";
import { failure } from "../src/response.js";
import { diagnosticLine, safeDiagnosticLine } from "../src/telemetry.js";
import { installedFailure } from "./installed-result.js";

it("preserves valid nonzero CLI error evidence without raw stderr or payload leakage", () => {
  const stdout = JSON.stringify(failure("r", "ACTION_REQUIRED"));
  const stderr = `SECRET_MARKER\n${diagnosticLine("job-fault", 5034, "DEADLINE_EXCEEDED")}`;
  const result = installedFailure(stdout, stderr);
  expect(result).toContain("ACTION_REQUIRED");
  expect(result).toContain("DEADLINE_EXCEEDED");
  expect(result).toContain("5034");
  expect(result).not.toContain("SECRET_MARKER");
  expect(installedFailure("not JSON", stderr)).toBe("INVALID_ENVELOPE");
});
it("does not accept forged diagnostic fields or raw secrets masquerading as timing", () => {
  expect(
    safeDiagnosticLine(
      JSON.stringify({
        type: "fixture-diagnostic",
        stage: "job-fault",
        elapsedMs: 1,
        token: "secret",
      }),
    ),
  ).toBeUndefined();
  expect(
    safeDiagnosticLine(
      JSON.stringify({
        type: "fixture-diagnostic",
        stage: "secret",
        elapsedMs: 1,
      }),
    ),
  ).toBeUndefined();
  expect(
    safeDiagnosticLine(
      JSON.stringify({
        type: "fixture-diagnostic",
        stage: "job-fault",
        elapsedMs: 1,
        code: "secret",
      }),
    ),
  ).toBeUndefined();
});
