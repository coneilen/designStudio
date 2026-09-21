import { expect, it } from "vitest";
import { CAPTURE_POLICY_SHA256 } from "../src/capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../src/capture-recovery-profile.js";
import {
  CAPTURE_REFERENCE_ORIGIN,
  CAPTURE_REFERENCE_POLICY_SHA256,
  captureReferencePolicyBytes,
  validateCaptureReferencePolicy,
} from "../src/capture-reference-profile.js";
import {
  assertCaptureReferenceInstallation,
  decodeReleasePolicy,
} from "../src/installation.js";

it("preserves both historical policies and requires the exact reference supplement", () => {
  expect(CAPTURE_POLICY_SHA256).toBe(
    "5daab947bf525c2f202a2595e8828146db49c2d6fc15583167136845e3f6ac3b",
  );
  expect(CAPTURE_RECOVERY_POLICY_SHA256).toBe(
    "fe388c83378e4379e788a1be509c1868788dac4ba853b314950bab49c3218c19",
  );
  expect(CAPTURE_REFERENCE_ORIGIN).toBe(
    "https://figma-alpha-api.s3.us-west-2.amazonaws.com",
  );
  expect(() =>
    validateCaptureReferencePolicy(captureReferencePolicyBytes()),
  ).not.toThrow();
  expect(() =>
    validateCaptureReferencePolicy(
      Buffer.from(`${captureReferencePolicyBytes()}\n`),
    ),
  ).toThrow();
});

it("requires canonical version-4 release metadata and denies structural leases", () => {
  const policy = {
    version: 4,
    kind: "figma-capture-v1",
    manifestSha256: "a".repeat(64),
    capturePolicySha256: CAPTURE_POLICY_SHA256,
    captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
    captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  };
  expect(decodeReleasePolicy(Buffer.from(JSON.stringify(policy)))).toEqual(
    policy,
  );
  for (const candidate of [
    { ...policy, version: 3 },
    { ...policy, captureReferencePolicySha256: undefined },
    { ...policy, captureReferencePolicySha256: "0".repeat(64) },
    { ...policy, reference: true },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(candidate))),
    ).toThrow();
  expect(() =>
    assertCaptureReferenceInstallation({
      identity: CAPTURE_REFERENCE_POLICY_SHA256,
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
