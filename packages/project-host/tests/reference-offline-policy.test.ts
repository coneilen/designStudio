import { expect, it } from "vitest";
import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "../src/capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "../src/capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../src/capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../src/capture-reference-profile.js";
import {
  assertReferenceOfflineInstallation,
  decodeReleasePolicy,
} from "../src/installation.js";
import {
  REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
  referenceConversionInspectionPolicyBytes,
  validateReferenceConversionInspectionPolicy,
} from "../src/reference-conversion-inspection-profile.js";
import {
  REFERENCE_OFFLINE_POLICY,
  REFERENCE_OFFLINE_POLICY_SHA256,
  referenceOfflinePolicyBytes,
  validateReferenceOfflinePolicy,
} from "../src/reference-offline-profile.js";
import { REFERENCE_VALIDATION_POLICY_SHA256 } from "../src/reference-validation-profile.js";

it("admits only the exact v7 zero-egress supplement without changing historical policies", () => {
  expect([
    CAPTURE_POLICY_SHA256,
    CAPTURE_RECOVERY_POLICY_SHA256,
    CAPTURE_REFERENCE_POLICY_SHA256,
    CAPTURE_DIAGNOSTIC_POLICY_SHA256,
    REFERENCE_VALIDATION_POLICY_SHA256,
  ]).toEqual([
    "5daab947bf525c2f202a2595e8828146db49c2d6fc15583167136845e3f6ac3b",
    "fe388c83378e4379e788a1be509c1868788dac4ba853b314950bab49c3218c19",
    "bcb61b4f10b07a12bb4fd162b1ea25d59a485d130623a542df9fb55a691626a8",
    "289fed0ea9eb48aa78cdff02abebb78edd4aa53e3fa3814e880168ad5c3286e9",
    "75505f5b603fed24222b8dcece2a3a9b8a4d59ae5a5d235827a35e9a73dd7896",
  ]);
  expect(REFERENCE_OFFLINE_POLICY).toMatchObject({
    egress: "deny",
    maxExternalCalls: 0,
    maxDnsQueries: 0,
    maxInputBytes: 26214400,
    maxDurationMs: 30000,
  });
  validateReferenceOfflinePolicy(referenceOfflinePolicyBytes());
  expect(() =>
    validateReferenceOfflinePolicy(
      Buffer.from(`${referenceOfflinePolicyBytes()}\n`),
    ),
  ).toThrow();
  const policy = {
    version: 7,
    kind: "figma-capture-v1",
    manifestSha256: "a".repeat(64),
    capturePolicySha256: CAPTURE_POLICY_SHA256,
    captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
    captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
    captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
    referenceValidationPolicySha256: REFERENCE_VALIDATION_POLICY_SHA256,
    referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
  };
  const bytes = Buffer.from(JSON.stringify(policy));
  expect(REFERENCE_OFFLINE_POLICY_SHA256).toBe(
    "28b61943d1cb75719fc3d471d5fa711c5105d0dadb93a53b5aade0969c912038",
  );
  const v8 = {
    ...policy,
    version: 8,
    referenceConversionInspectionPolicySha256:
      REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
  };
  const v8bytes = Buffer.from(JSON.stringify(v8));
  expect(REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256).toBe(
    "dcab19262e9fe1af2c20216abaeedfe88081405b9a53caff571ca4b122fd28b3",
  );
  expect(v8bytes.length).toBe(816);
  expect(v8bytes.length).toBeLessThanOrEqual(1024);
  expect(decodeReleasePolicy(v8bytes)).toEqual(v8);
  validateReferenceConversionInspectionPolicy(
    referenceConversionInspectionPolicyBytes(),
  );
  for (const changed of [
    { ...v8, referenceConversionInspectionPolicySha256: "0".repeat(64) },
    { ...v8, referenceConversionInspectionPolicySha256: undefined },
    {
      ...v8,
      referenceOfflinePolicySha256:
        REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
    },
    { ...v8, version: 7 },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(changed))),
    ).toThrow();
  expect(() =>
    validateReferenceConversionInspectionPolicy(
      Buffer.from(`${referenceConversionInspectionPolicyBytes()}\n`),
    ),
  ).toThrow();
  expect(bytes.length).toBeLessThanOrEqual(1024);
  expect(decodeReleasePolicy(bytes)).toEqual(policy);
  for (const version of [1, 2, 3, 4, 5, 6])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify({ ...policy, version }))),
    ).toThrow();
  for (const changed of [
    { ...policy, referenceOfflinePolicySha256: "0".repeat(64) },
    { ...policy, referenceOfflinePolicySha256: undefined },
    { ...policy, network: true },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(changed))),
    ).toThrow();
  expect(() =>
    assertReferenceOfflineInstallation({
      identity: REFERENCE_OFFLINE_POLICY_SHA256,
      profile: "figma-capture-v1",
      paths: {
        node: "fake",
        bootstrapEntry: "fake",
        cliEntry: "fake",
        dialogEntry: "fake",
        sqliteBinding: "fake",
      },
      recheck: async () => {},
      checkCurrent: async () => {},
      close: async () => {},
    }),
  ).toThrow();
});
