import { expect, it } from "vitest";
import {
  CAPTURE_POLICY,
  CAPTURE_POLICY_SHA256,
  capturePolicyBytes,
} from "../src/capture-profile.js";
import {
  CAPTURE_RECOVERY_POLICY,
  CAPTURE_RECOVERY_POLICY_SHA256,
  captureRecoveryPolicyBytes,
  validateCaptureRecoveryPolicy,
} from "../src/capture-recovery-profile.js";
import { digest } from "../src/installation-manifest.js";

it("supplements rather than mutates the existing capture policy and namespace", () => {
  expect(capturePolicyBytes().toString()).toBe(
    '{"version":1,"kind":"figma-capture-v1","platform":"win32-x64","credentialProvider":"figma_rest","credentialStore":"windows-credential-manager","roles":["capture","pat-helper"],"commands":["project-create","credential-setup","credential-status","credential-update","credential-remove","figma-capture","figma-inspect","figma-convert","figma-artifact"],"maxTokenBytes":4096,"inputTimeoutMs":300000,"adminTimeoutMs":30000,"journalRecords":1024,"journalNormalReserve":8,"apiOrigins":["https://api.figma.com"],"maxExternalCalls":4,"captureTimeoutMs":30000,"imageOrigins":[]}',
  );
  expect(CAPTURE_POLICY.commands).not.toContain("figma-recover");
  expect(CAPTURE_RECOVERY_POLICY.capturePolicySha256).toBe(
    CAPTURE_POLICY_SHA256,
  );
  expect(CAPTURE_RECOVERY_POLICY.commands).toEqual(["figma-recover"]);
  expect(CAPTURE_RECOVERY_POLICY_SHA256).toBe(
    digest(captureRecoveryPolicyBytes()),
  );
  expect(CAPTURE_RECOVERY_POLICY_SHA256).not.toBe(CAPTURE_POLICY_SHA256);
});

it("accepts only exact canonical recovery supplement bytes", () => {
  expect(() =>
    validateCaptureRecoveryPolicy(captureRecoveryPolicyBytes()),
  ).not.toThrow();
  for (const bytes of [
    capturePolicyBytes(),
    Buffer.from(`${captureRecoveryPolicyBytes().toString()}\n`),
    Buffer.from(
      JSON.stringify({
        ...CAPTURE_RECOVERY_POLICY,
        commands: ["figma-recover", "reset"],
      }),
    ),
    Buffer.from(
      JSON.stringify({
        ...CAPTURE_RECOVERY_POLICY,
        capturePolicySha256: "0".repeat(64),
      }),
    ),
  ])
    expect(() => validateCaptureRecoveryPolicy(bytes)).toThrow();
});
