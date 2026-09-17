import { validateContract } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import { exitCode, failure, success, unwrap } from "../src/response.js";

describe("one authoritative response boundary", () => {
  it("validates successful metadata and never accepts arbitrary data", () => {
    const result = success("request", {
      kind: "version",
      cliVersion: "1.0.0",
      contractVersion: "1.1.0",
      apiVersion: "v1",
      warnings: [],
    });
    expect(validateContract("ResponseEnvelope", result).success).toBe(true);
    expect(exitCode(result)).toBe(0);
  });
  it.each([
    ["INVALID_INPUT", 2],
    ["POLICY_FAILED", 3],
    ["VALIDATION_INCONCLUSIVE", 4],
    ["CONFLICT", 5],
    ["AUTH_REQUIRED", 5],
    ["ACTION_REQUIRED", 5],
    ["INTERNAL_ERROR", 1],
    ["DEADLINE_EXCEEDED", 1],
  ] as const)("maps %s without changing the typed reason", (code, expected) => {
    const result = failure("request", code);
    expect(validateContract("ResponseEnvelope", result).success).toBe(true);
    expect(exitCode(result)).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });
  it("does not turn partial or unavailable provider outcomes into success", () => {
    expect(() =>
      unwrap({
        schemaVersion: "1.0",
        projectId: "project",
        requestId: "request",
        status: "unavailable",
        error: {
          code: "TOOL_MISSING",
          message: "secret-input",
          retryable: false,
          diagnosticIds: [],
        },
        diagnosticIds: [],
      }),
    ).toThrow();
  });
});
