import { expect, it, vi } from "vitest";
import { runCaptureCommand } from "../src/capture-main.js";

const seam = vi.hoisted(() => ({
  project: vi.fn(async () => {
    throw new Error("Recovery must not open an unadmitted project");
  }),
  close: vi.fn(async () => {}),
  guard: vi.fn(),
}));
vi.mock("@design-studio/project-host", async (original) => ({
  ...(await original<typeof import("@design-studio/project-host")>()),
  verifyCaptureInstallation: async () => ({
    profile: "figma-capture-v1",
    identity: "a".repeat(64),
    paths: {},
    recheck: async () => {},
    checkCurrent: async () => {},
    close: seam.close,
  }),
  registerCaptureInstallationGuards: () => ({ close: seam.guard }),
  openCaptureProject: seam.project,
}));

it("rejects an old or structural installation before project/runtime/vault effects", async () => {
  const result = await runCaptureCommand([
    "figma",
    "recover",
    "--project",
    "capture_11111111-1111-4111-8111-111111111111",
    "--request-id",
    "failed_request",
    "--failed-job-id",
    `capture_${"b".repeat(64)}`,
    "--next-request-id",
    "next_request",
  ]);
  expect(result).toMatchObject({
    operation: "recover",
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });
  expect(seam.project).not.toHaveBeenCalled();
  expect(seam.close).toHaveBeenCalledTimes(1);
  expect(seam.guard).toHaveBeenCalledTimes(1);
});
it("denies reference actions before opening any project for a legacy or forged lease", async () => {
  seam.close.mockClear();
  seam.guard.mockClear();
  for (const command of ["reference-plan", "reference-inspect"]) {
    expect(
      await runCaptureCommand([
        "figma",
        command,
        "--project",
        "capture_11111111-1111-4111-8111-111111111111",
        "--request-id",
        "original",
      ]),
    ).toMatchObject({
      operation: command,
      status: "failed",
      error: { code: "ACTION_REQUIRED" },
    });
  }
  expect(seam.project).not.toHaveBeenCalled();
  expect(seam.close).toHaveBeenCalledTimes(2);
  expect(seam.guard).toHaveBeenCalledTimes(2);
});
