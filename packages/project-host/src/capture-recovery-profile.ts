import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";

export const CAPTURE_RECOVERY_CONFIRMATION =
  "AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA";
export const CAPTURE_RECOVERY_POLICY = Object.freeze({
  version: 1,
  kind: "figma-capture-recovery-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  commands: Object.freeze(["figma-recover"]),
  evidenceVersion: 1,
  confirmation: CAPTURE_RECOVERY_CONFIRMATION,
  maxHistoryJobs: 1000,
  maxInventoryEntries: 20000,
  maxEvidenceBytes: 65536,
  maxDurationMs: 30000,
});
export function captureRecoveryPolicyBytes(): Buffer {
  return Buffer.from(JSON.stringify(CAPTURE_RECOVERY_POLICY));
}
export const CAPTURE_RECOVERY_POLICY_SHA256 = digest(
  captureRecoveryPolicyBytes(),
);
export function validateCaptureRecoveryPolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(captureRecoveryPolicyBytes()))
    refuse("Recovery requires the exact closed capture policy supplement.");
}
