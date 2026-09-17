import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";

const catalogBytes = Buffer.from("synthetic unavailable fixture");
const options = {
  applicationId: "design-studio" as const,
  catalogIdentity: createHash("sha256").update(catalogBytes).digest("hex"),
  catalogBytes,
  trustedImmutableInstallation: true as const,
  fixtures: [
    {
      projectId: "fixture",
      artifactRootId: "blobs",
      permissionScope: "private",
    },
  ],
};

test("labeled missing-native mock is lazy and explicit, never a fake attestation", async () => {
  vi.resetModules();
  vi.doMock("koffi", () => {
    throw new Error("injected missing optional prebuild");
  });
  try {
    const { WindowsFixtureProjects } = await import("../src/index.js");
    expect(typeof WindowsFixtureProjects.open).toBe("function");
    await expect(WindowsFixtureProjects.open(options)).rejects.toMatchObject({
      code:
        process.platform === "win32"
          ? "PROVIDER_UNAVAILABLE"
          : "UNSUPPORTED_HOST",
      unavailable: true,
    });
  } finally {
    vi.doUnmock("koffi");
    vi.resetModules();
  }
});

test("labeled unsupported-host seam rejects before loading native capabilities", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("Missing process platform descriptor.");
  vi.resetModules();
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { loadNative } = await import("../src/native.js");
    await expect(loadNative()).rejects.toMatchObject({
      code: "UNSUPPORTED_HOST",
      unavailable: true,
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.resetModules();
  }
});
