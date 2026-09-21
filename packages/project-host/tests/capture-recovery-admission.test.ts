import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CAPTURE_POLICY_SHA256,
  CAPTURE_PROFILE,
} from "../src/capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "../src/capture-recovery-profile.js";
import {
  assertCaptureRecoveryInstallation,
  decodeReleasePolicy,
  verifyCaptureInstalledRoot,
} from "../src/installation.js";
import { digest, encodeInventory } from "../src/installation-manifest.js";

const native = vi.hoisted(() => ({
  load: vi.fn(async () => {
    throw new Error("Native effects forbidden in metadata test");
  }),
}));
vi.mock("../src/native.js", async (original) => ({
  ...(await original<typeof import("../src/native.js")>()),
  loadNative: native.load,
}));
afterEach(() => vi.clearAllMocks());
const base = {
  version: 2,
  kind: CAPTURE_PROFILE,
  manifestSha256: "a".repeat(64),
  capturePolicySha256: CAPTURE_POLICY_SHA256,
};
it("retains exact legacy metadata and admits only the exact explicit recovery metadata variant", () => {
  expect(decodeReleasePolicy(Buffer.from(JSON.stringify(base)))).toEqual(base);
  const supplemented = {
    ...base,
    version: 3,
    captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
  };
  expect(
    decodeReleasePolicy(Buffer.from(JSON.stringify(supplemented))),
  ).toEqual(supplemented);
  for (const value of [
    { ...base, version: 3 },
    { ...base, captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256 },
    { ...supplemented, captureRecoveryPolicySha256: "0".repeat(64) },
    { ...supplemented, capturePolicySha256: "0".repeat(64) },
    { ...supplemented, recovery: true },
    { ...supplemented, version: 4 },
  ])
    expect(() =>
      decodeReleasePolicy(Buffer.from(JSON.stringify(value))),
    ).toThrow();
  expect(() =>
    decodeReleasePolicy(Buffer.from(`${JSON.stringify(supplemented)}\n`)),
  ).toThrow();
  expect(native.load).not.toHaveBeenCalled();
});
it("structural old or recovery-looking leases cannot mint native recovery authority", () => {
  for (const identity of [
    CAPTURE_POLICY_SHA256,
    CAPTURE_RECOVERY_POLICY_SHA256,
  ]) {
    expect(() =>
      assertCaptureRecoveryInstallation({
        identity,
        profile: CAPTURE_PROFILE,
        paths: {
          node: "untrusted",
          bootstrapEntry: "untrusted",
          cliEntry: "untrusted",
          dialogEntry: "untrusted",
          sqliteBinding: "untrusted",
        },
        recheck: async () => {},
        checkCurrent: async () => {},
        close: async () => {},
      }),
    ).toThrow();
  }
  expect(native.load).not.toHaveBeenCalled();
});
it.each([undefined, "0".repeat(64)])(
  "refuses missing or tampered supplemental inventory before native effects",
  async (supplement) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "capture-metadata-synthetic-"),
    );
    try {
      await mkdir(path.join(root, "bootstrap"));
      const files = [
        "packages/cli/dist/capture-main.js",
        "packages/project-host/dist/pat-dialog-helper.js",
        "native/better_sqlite3.node",
        "node_modules/@design-studio/figma-capture/dist/index.js",
        "node_modules/@design-studio/figma-import/dist/index.js",
        "node_modules/@design-studio/project-host/dist/index.js",
      ].map((name) => ({ path: name, bytes: 1, sha256: "1".repeat(64) }));
      files.push({
        path: "capture-policy.json",
        bytes: 1,
        sha256: CAPTURE_POLICY_SHA256,
      });
      if (supplement)
        files.push({
          path: "capture-recovery-policy.json",
          bytes: 1,
          sha256: supplement,
        });
      const manifest = encodeInventory(files);
      const bootstrap = encodeInventory(
        [
          "runtime/node.exe",
          "launch.mjs",
          "install.mjs",
          "release-policy.json",
          "node_modules/@design-studio/project-host/dist/installation.js",
        ].map((name) => ({ path: name, bytes: 1, sha256: "2".repeat(64) })),
      );
      await writeFile(path.join(root, "payload-inventory.json"), manifest);
      await writeFile(path.join(root, "bootstrap-inventory.json"), bootstrap);
      await writeFile(
        path.join(root, "bootstrap", "release-policy.json"),
        JSON.stringify({
          ...base,
          version: 3,
          manifestSha256: digest(manifest),
          captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
        }),
      );
      await expect(verifyCaptureInstalledRoot(root)).rejects.toThrow(
        /recovery supplement/i,
      );
      expect(native.load).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
