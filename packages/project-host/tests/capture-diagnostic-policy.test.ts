import { expect, it } from "vitest";
import {
  CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  captureDiagnosticPolicyBytes,
  validateCaptureDiagnosticPolicy,
} from "../src/capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "../src/capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../src/capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../src/capture-reference-profile.js";
import {
  assertCaptureDiagnosticInstallation,
  decodeReleasePolicy,
} from "../src/installation.js";

it("requires a separately inventory-bound supplement without changing historical policy identities", () => {
  expect(CAPTURE_POLICY_SHA256).toBe(
    "5daab947bf525c2f202a2595e8828146db49c2d6fc15583167136845e3f6ac3b",
  );
  expect(CAPTURE_RECOVERY_POLICY_SHA256).toBe(
    "fe388c83378e4379e788a1be509c1868788dac4ba853b314950bab49c3218c19",
  );
  expect(CAPTURE_REFERENCE_POLICY_SHA256).toBe(
    "bcb61b4f10b07a12bb4fd162b1ea25d59a485d130623a542df9fb55a691626a8",
  );
  expect(() =>
    validateCaptureDiagnosticPolicy(captureDiagnosticPolicyBytes()),
  ).not.toThrow();
  expect(() =>
    validateCaptureDiagnosticPolicy(
      Buffer.from(`${captureDiagnosticPolicyBytes()}\n`),
    ),
  ).toThrow();
  const prior = {
    version: 4,
    kind: "figma-capture-v1",
    manifestSha256: "a".repeat(64),
    capturePolicySha256: CAPTURE_POLICY_SHA256,
    captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
    captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  };
  const current = {
    ...prior,
    version: 5,
    captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  };
  expect(decodeReleasePolicy(Buffer.from(JSON.stringify(prior)))).toEqual(
    prior,
  );
  expect(decodeReleasePolicy(Buffer.from(JSON.stringify(current)))).toEqual(
    current,
  );
  for (const value of [
    { ...current, version: 4 },
    { ...current, captureDiagnosticPolicySha256: "0".repeat(64) },
    { ...prior, version: 5 },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(value))),
    ).toThrow();
  expect(() =>
    assertCaptureDiagnosticInstallation({
      identity: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
      profile: "figma-capture-v1",
      paths: {
        node: "untrusted",
        bootstrapEntry: "untrusted",
        cliEntry: "untrusted",
        dialogEntry: "untrusted",
        sqliteBinding: "untrusted",
      },
      recheck: async () => {},
      checkCurrent: async () => {},
      close: async () => {},
    }),
  ).toThrow();
});
