import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";

export const CAPTURE_REFERENCE_ORIGIN =
  "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
export const CAPTURE_REFERENCE_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  commands: Object.freeze([
    "figma-reference-plan",
    "figma-reference-approve",
    "figma-reference-download",
    "figma-reference-inspect",
  ]),
  origin: CAPTURE_REFERENCE_ORIGIN,
  approvalLifetimeMs: 300000,
  maxApprovals: 32,
  maxDurationMs: 30000,
  maxExternalCalls: 1,
  maxDnsQueries: 1,
  maxAttempts: 1,
  maxInputBytes: 26214400,
  maxOutputBytes: 26214400,
  maxRasterPixels: 6553600,
  maxHistoryJobs: 1000,
  maxEvidenceBytes: 65536,
});
export function captureReferencePolicyBytes(): Buffer {
  return Buffer.from(JSON.stringify(CAPTURE_REFERENCE_POLICY));
}
export const CAPTURE_REFERENCE_POLICY_SHA256 = digest(
  captureReferencePolicyBytes(),
);
export function validateCaptureReferencePolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(captureReferencePolicyBytes()))
    refuse("Reference acquisition requires the exact closed supplement.");
}
