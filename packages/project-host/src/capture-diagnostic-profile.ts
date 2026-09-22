import { CAPTURE_REFERENCE_POLICY_SHA256 } from "./capture-reference-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";

export const CAPTURE_DIAGNOSTIC_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-diagnostic-v1",
  referencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
  commands: Object.freeze([
    "figma-reference-diagnostic-plan",
    "figma-reference-diagnostic-approve",
    "figma-reference-diagnostic-download",
    "figma-reference-diagnostic-inspect",
  ]),
  predecessor: "completed-atomic-http200-invalid-input-no-png-one-settled-get",
  slot: "one-per-original-reference-receipt-no-chaining",
  approvalLifetimeMs: 300000,
  maxApprovals: 32,
  maxExternalCalls: 1,
  maxDnsQueries: 1,
  maxAttempts: 1,
  maxDurationMs: 30000,
  maxInputBytes: 26214400,
  maxOutputBytes: 26214400,
  maxRasterPixels: 6553600,
});
export const captureDiagnosticPolicyBytes = () =>
  Buffer.from(JSON.stringify(CAPTURE_DIAGNOSTIC_POLICY));
export const CAPTURE_DIAGNOSTIC_POLICY_SHA256 = digest(
  captureDiagnosticPolicyBytes(),
);
export function validateCaptureDiagnosticPolicy(bytes: Uint8Array) {
  if (!Buffer.from(bytes).equals(captureDiagnosticPolicyBytes()))
    refuse(
      "Diagnostic acquisition requires the exact separate native supplement.",
    );
}
