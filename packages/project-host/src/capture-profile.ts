import { digest } from "./installation-manifest.js";
import { refuse } from "./native.js";

export const CAPTURE_PROFILE = "figma-capture-v1" as const;
export const CAPTURE_POLICY = Object.freeze({
  version: 1,
  kind: CAPTURE_PROFILE,
  platform: "win32-x64",
  credentialProvider: "figma_rest",
  credentialStore: "windows-credential-manager",
  roles: Object.freeze(["capture", "pat-helper"]),
  commands: Object.freeze([
    "project-create",
    "credential-setup",
    "credential-status",
    "credential-update",
    "credential-remove",
  ]),
  maxTokenBytes: 4096,
  inputTimeoutMs: 300000,
  adminTimeoutMs: 30000,
  apiOrigins: Object.freeze([]),
  imageOrigins: Object.freeze([]),
});
export function capturePolicyBytes(): Buffer {
  return Buffer.from(JSON.stringify(CAPTURE_POLICY));
}
export const CAPTURE_POLICY_SHA256 = digest(capturePolicyBytes());
export function validateCapturePolicy(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(capturePolicyBytes()))
    refuse(
      "Capture policy is not the closed reviewed native credential profile.",
    );
}
