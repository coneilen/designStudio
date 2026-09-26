import { expect, it } from "vitest";
import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "../src/capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "../src/capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../src/capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../src/capture-reference-profile.js";
import {
  assertReferenceForkInstallation,
  type CaptureInstallationLease,
  decodeReleasePolicy,
} from "../src/installation.js";
import { REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256 } from "../src/reference-conversion-inspection-profile.js";
import {
  REFERENCE_FORK_POLICY,
  REFERENCE_FORK_POLICY_SHA256,
  referenceForkPolicyBytes,
  validateReferenceForkPolicy,
} from "../src/reference-fork-profile.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "../src/reference-offline-profile.js";
import { REFERENCE_VALIDATION_POLICY_SHA256 } from "../src/reference-validation-profile.js";

const hashes = {
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
  captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  referenceValidationPolicySha256: REFERENCE_VALIDATION_POLICY_SHA256,
  referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
  referenceConversionInspectionPolicySha256:
    REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
  referenceForkPolicySha256: REFERENCE_FORK_POLICY_SHA256,
};
const release = (version: number) => ({
  version,
  kind: "figma-capture-v1",
  manifestSha256: "a".repeat(64),
  ...Object.fromEntries(Object.entries(hashes).slice(0, version - 1)),
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

it("adds an exact bounded release9 supplement while all seven earlier hashes stay fixed", () => {
  expect(Object.values(hashes).slice(0, 7)).toEqual([
    "5daab947bf525c2f202a2595e8828146db49c2d6fc15583167136845e3f6ac3b",
    "fe388c83378e4379e788a1be509c1868788dac4ba853b314950bab49c3218c19",
    "bcb61b4f10b07a12bb4fd162b1ea25d59a485d130623a542df9fb55a691626a8",
    "289fed0ea9eb48aa78cdff02abebb78edd4aa53e3fa3814e880168ad5c3286e9",
    "75505f5b603fed24222b8dcece2a3a9b8a4d59ae5a5d235827a35e9a73dd7896",
    "28b61943d1cb75719fc3d471d5fa711c5105d0dadb93a53b5aade0969c912038",
    "dcab19262e9fe1af2c20216abaeedfe88081405b9a53caff571ca4b122fd28b3",
  ]);
  expect(REFERENCE_FORK_POLICY).toEqual({
    version: 1,
    kind: "figma-reference-fork-v1",
    capturePolicySha256: CAPTURE_POLICY_SHA256,
    referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
    commands: ["figma-reference-fork", "figma-reference-fork-result"],
    access:
      "recorded-source-readonly-fresh-destination-write-committed-destination-readonly",
    egress: "deny",
    maxExternalCalls: 0,
    maxDnsQueries: 0,
    maxDurationMs: 30000,
    maxInputBytes: 26214400,
    maxRasterPixels: 6553600,
    maxResponseBytes: 8192,
    maxOutputs: 16,
    maxPublications: 16,
    sourceSchema: 5,
    destinationSchema: 6,
    sourceInventory: "selected-recorded-inputs-only",
    destinationResume: "blocked-no-replay",
    resultScope: "receipt-bound-committed-destination-only",
  });
  validateReferenceForkPolicy(referenceForkPolicyBytes());
  expect(REFERENCE_FORK_POLICY_SHA256).toBe(
    "01c348dcac3f74df5f7b72b5e362dd53e257f5a176a214075c259ca3bcc8522b",
  );
  expect(referenceForkPolicyBytes()).toHaveLength(765);
  expect(bytes(release(8))).toHaveLength(816);
  expect(bytes(release(9))).toHaveLength(911);
  expect(bytes(release(9)).length).toBeLessThanOrEqual(1024);
  for (let version = 2; version <= 9; version++)
    expect(decodeReleasePolicy(bytes(release(version)))).toEqual(
      release(version),
    );
  const fixture = {
    version: 1,
    manifestSha256: "a".repeat(64),
    catalogSha256: "b".repeat(64),
  };
  expect(decodeReleasePolicy(bytes(fixture))).toEqual(fixture);
});

it("bootstrap parsing refuses missing, changed, reordered, extra and retrofitted fork policy", () => {
  for (const field of Object.keys(hashes)) {
    for (const replacement of [undefined, "0".repeat(64)])
      expect(() =>
        decodeReleasePolicy(bytes({ ...release(9), [field]: replacement })),
      ).toThrow();
  }
  for (const changed of [
    { ...release(9), version: 10 },
    { ...release(9), extra: true },
    Object.fromEntries(Object.entries(release(9)).reverse()),
    ...Array.from({ length: 7 }, (_, index) => ({
      ...release(index + 2),
      referenceForkPolicySha256: REFERENCE_FORK_POLICY_SHA256,
    })),
  ])
    expect(() => decodeReleasePolicy(bytes(changed))).toThrow();
  expect(() =>
    decodeReleasePolicy(Buffer.from(`${bytes(release(9))}\n`)),
  ).toThrow();
  expect(() => decodeReleasePolicy(Buffer.alloc(1025))).toThrow(/bound/);
  for (const changed of [
    Buffer.from(`${referenceForkPolicyBytes()}\n`),
    bytes({ ...REFERENCE_FORK_POLICY, maxPublications: 17 }),
    bytes({ ...REFERENCE_FORK_POLICY, destinationResume: "replay" }),
  ])
    expect(() => validateReferenceForkPolicy(changed)).toThrow();
  expect(() =>
    assertReferenceForkInstallation({
      profile: "figma-capture-v1",
      identity: REFERENCE_FORK_POLICY_SHA256,
    } as CaptureInstallationLease),
  ).toThrow();
});
