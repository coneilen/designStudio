import { expect, it, vi } from "vitest";
import {
  NativeCaptureCommandCleanupRequired,
  runCaptureCommand,
} from "../src/capture-main.js";

const seam = vi.hoisted(() => ({
  inspectionAdmitted: false,
  inspectionResult: {} as object,
  inspectionExecute: vi.fn(async () => seam.inspectionResult),
  inspectionClose: vi.fn(async () => {}),
  projectClose: vi.fn(async () => {}),
  project: vi.fn(async () => {
    if (seam.inspectionAdmitted) return { close: seam.projectClose };
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
  assertReferenceOfflineInstallation: () => {
    if (!seam.inspectionAdmitted) throw new Error("Not admitted");
  },
  assertReferenceConversionInspectionInstallation: () => {
    if (!seam.inspectionAdmitted) throw new Error("Not admitted");
  },
}));
vi.mock("@design-studio/application/capture", async (original) => ({
  ...(await original<typeof import("@design-studio/application/capture")>()),
  openNativeReferenceConversionInspection: async () => ({
    execute: seam.inspectionExecute,
    close: seam.inspectionClose,
  }),
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
  for (const command of [
    "reference-plan",
    "reference-inspect",
    "reference-diagnostic-plan",
    "reference-diagnostic-inspect",
  ]) {
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
  expect(seam.close).toHaveBeenCalledTimes(4);
  expect(seam.guard).toHaveBeenCalledTimes(4);
});
it("denies retained validation before project/database effects for a legacy or structural lease", async () => {
  seam.close.mockClear();
  seam.guard.mockClear();
  expect(
    await runCaptureCommand([
      "figma",
      "reference-recovery-plan",
      "--project",
      "capture_11111111-1111-4111-8111-111111111111",
      "--request-id",
      "original",
      "--expected-job",
      "a".repeat(64),
    ]),
  ).toMatchObject({
    operation: "reference-recovery-plan",
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });

  expect(seam.project).not.toHaveBeenCalled();
  expect(seam.close).toHaveBeenCalledTimes(1);
  expect(seam.guard).toHaveBeenCalledTimes(1);
});

it("preserves closed blocked inspection diagnostics only when CLI owner release succeeds", async () => {
  seam.inspectionAdmitted = true;
  const result = {
    schemaVersion: "1.0",
    operation: "reference-conversion-inspect",
    projectId: "capture_11111111-1111-4111-8111-111111111111",
    requestId: "original",
    status: "failed",
    reason: "integrity",
    error: {
      code: "ACTION_REQUIRED",
      message: "Closed failure.",
      retryable: false,
      diagnosticIds: [],
    },
    inspection: {
      verification: "conversion-readonly-v1",
      state: "blocked",
      detail: "verification-incomplete",
      diagnostic: { stage: "inventory-invalid" },
    },
  };
  seam.inspectionResult = result;
  const args = [
    "figma",
    "reference-conversion-inspect",
    "--project",
    result.projectId,
    "--request-id",
    "original",
    "--expected-job",
    "a".repeat(64),
    "--expected-recovery",
    "b".repeat(64),
  ];
  try {
    expect(await runCaptureCommand(args)).toEqual(result);
    seam.inspectionClose.mockRejectedValueOnce(
      new Error("Synthetic private close failure"),
    );
    const failed = await runCaptureCommand(args).catch(
      (error: unknown) => error,
    );
    if (!(failed instanceof NativeCaptureCommandCleanupRequired))
      throw new Error("Expected owned CLI cleanup failure.");
    expect(failed.result).toMatchObject({
      status: "interrupted",
      inspection: {
        verification: "conversion-readonly-v1",
        state: "blocked",
        detail: "verification-incomplete",
      },
    });
    expect(JSON.stringify(failed.result)).not.toMatch(
      /diagnostic"|private close/,
    );
    await failed.close();
  } finally {
    seam.inspectionAdmitted = false;
  }
});
