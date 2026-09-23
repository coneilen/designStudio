import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "./capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "./capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "./capture-reference-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";

export const REFERENCE_VALIDATION_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-retained-validation-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
  captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  commands: Object.freeze(["figma-reference-recovery-plan"]),
  access: "read-only",
  egress: "deny",
  maxExternalCalls: 0,
  maxDnsQueries: 0,
  maxPublications: 0,
  maxDurationMs: 30000,
  maxInputBytes: 26214400,
  maxRasterPixels: 6553600,
  maxEvidenceBytes: 65536,
  maxResponseBytes: 8192,
  maxHistoryJobs: 1000,
  maxInventoryEntries: 20000,
});
export const referenceValidationPolicyBytes = () =>
  Buffer.from(JSON.stringify(REFERENCE_VALIDATION_POLICY));
export const REFERENCE_VALIDATION_POLICY_SHA256 = digest(
  referenceValidationPolicyBytes(),
);
export function validateReferenceValidationPolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(referenceValidationPolicyBytes()))
    refuse("Retained validation requires the exact read-only supplement.");
}
