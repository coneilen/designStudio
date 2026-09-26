import { CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "./reference-offline-profile.js";

export const REFERENCE_FORK_POLICY = Object.freeze({
  version: 1,
  kind: "figma-reference-fork-v1",
  capturePolicySha256: CAPTURE_POLICY_SHA256,
  referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
  commands: Object.freeze([
    "figma-reference-fork",
    "figma-reference-fork-result",
  ]),
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
export const referenceForkPolicyBytes = () =>
  Buffer.from(JSON.stringify(REFERENCE_FORK_POLICY));
export const REFERENCE_FORK_POLICY_SHA256 = digest(referenceForkPolicyBytes());
export function validateReferenceForkPolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(referenceForkPolicyBytes()))
    refuse("Verified-input fork requires the exact independent supplement.");
}
