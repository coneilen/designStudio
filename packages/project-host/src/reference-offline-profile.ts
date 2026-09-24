import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "./capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "./capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "./capture-reference-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";
import { REFERENCE_VALIDATION_POLICY_SHA256 } from "./reference-validation-profile.js";

export const REFERENCE_OFFLINE_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-offline-publication-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
  captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  referenceValidationPolicySha256: REFERENCE_VALIDATION_POLICY_SHA256,
  commands: Object.freeze([
    "figma-reference-recovery-apply-plan",
    "figma-reference-recovery-apply",
    "figma-reference-recovery-inspect",
    "figma-convert-reference",
  ]),
  confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  conversionConfirmation: "CONVERT-WITH-RECOVERED-REFERENCE",
  egress: "deny",
  maxExternalCalls: 0,
  maxDnsQueries: 0,
  maxDurationMs: 30000,
  maxInputBytes: 26214400,
  maxRasterPixels: 6553600,
  maxEvidenceBytes: 65536,
  maxResponseBytes: 8192,
  maxRecoveryOutputs: 3,
  maxRecoveryEvents: 16,
  projectWriteScope: "single-recovery-and-bound-conversion-only",
  maxProjectRecoverySlots: 1,
  continuation: "reserved-without-file-intent-or-committed-replay",
});
export const referenceOfflinePolicyBytes = () =>
  Buffer.from(JSON.stringify(REFERENCE_OFFLINE_POLICY));
export const REFERENCE_OFFLINE_POLICY_SHA256 = digest(
  referenceOfflinePolicyBytes(),
);
export function validateReferenceOfflinePolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(referenceOfflinePolicyBytes()))
    refuse("Offline publication requires the exact write supplement.");
}
