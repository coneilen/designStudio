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
  assertReferenceValidationInstallation,
  decodeReleasePolicy,
} from "../src/installation.js";
import {
  REFERENCE_VALIDATION_POLICY,
  REFERENCE_VALIDATION_POLICY_SHA256,
  referenceValidationPolicyBytes,
  validateReferenceValidationPolicy,
} from "../src/reference-validation-profile.js";

it("admits only v6 exact zero-egress validation without changing the four historical policy hashes", () => {
  expect(CAPTURE_DIAGNOSTIC_POLICY_SHA256).toBe(
    "289fed0ea9eb48aa78cdff02abebb78edd4aa53e3fa3814e880168ad5c3286e9",
  );
  expect(REFERENCE_VALIDATION_POLICY).toMatchObject({
    access: "read-only",
    egress: "deny",
    maxExternalCalls: 0,
    maxDnsQueries: 0,
    maxPublications: 0,
    maxInputBytes: 26214400,
    maxDurationMs: 30000,
  });
  expect(() =>
    validateReferenceValidationPolicy(referenceValidationPolicyBytes()),
  ).not.toThrow();
  expect(() =>
    validateReferenceValidationPolicy(
      Buffer.from(`${referenceValidationPolicyBytes()}\n`),
    ),
  ).toThrow();
  const policy = {
    version: 6,
    kind: "figma-capture-v1",
    manifestSha256: "a".repeat(64),
    capturePolicySha256: CAPTURE_POLICY_SHA256,
    captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
    captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
    captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
    referenceValidationPolicySha256: REFERENCE_VALIDATION_POLICY_SHA256,
  };
  expect(decodeReleasePolicy(Buffer.from(JSON.stringify(policy)))).toEqual(
    policy,
  );
  for (const candidate of [
    ...[1, 2, 3, 4, 5].map((version) => ({ ...policy, version })),
    { ...policy, referenceValidationPolicySha256: undefined },
    { ...policy, referenceValidationPolicySha256: "0".repeat(64) },
    { ...policy, captureDiagnosticPolicySha256: "0".repeat(64) },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(candidate))),
    ).toThrow();
  expect(() =>
    assertReferenceValidationInstallation({
      identity: REFERENCE_VALIDATION_POLICY_SHA256,
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
