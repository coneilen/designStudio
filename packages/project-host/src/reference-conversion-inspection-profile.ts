import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "./reference-offline-profile.js";

export const REFERENCE_CONVERSION_INSPECTION_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-conversion-inspection-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
  commands: Object.freeze(["figma-reference-conversion-inspect"]),
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
  storageSchema: 5,
});
export const referenceConversionInspectionPolicyBytes = () =>
  Buffer.from(JSON.stringify(REFERENCE_CONVERSION_INSPECTION_POLICY));
export const REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256 = digest(
  referenceConversionInspectionPolicyBytes(),
);
export function validateReferenceConversionInspectionPolicy(
  bytes: Uint8Array,
): void {
  if (!Buffer.from(bytes).equals(referenceConversionInspectionPolicyBytes()))
    refuse("Conversion inspection requires the exact read-only supplement.");
}
