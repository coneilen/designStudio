import * as api from "@design-studio/project-host";
import { expect, test } from "vitest";

test("built package exposes only the trusted Windows factory, never native/path/test factories", () => {
  expect(Object.keys(api).sort()).toEqual([
    "CaptureStartupCleanupRequired",
    "WindowsFixtureProjects",
    "acquireCaptureWork",
    "assertCaptureWork",
    "openCaptureCredentials",
    "openCaptureProject",
    "registerCaptureInstallationGuards",
    "registerFixtureInstallationGuards",
    "startCapturePatDialog",
    "verifyCaptureInstallation",
    "verifyFixtureInstallation",
  ]);
  expect(typeof api.WindowsFixtureProjects.open).toBe("function");
  expect("openInternal" in api.WindowsFixtureProjects).toBe(false);
  expect("openAtTestRoot" in api).toBe(false);
  expect("loadNative" in api).toBe(false);
  expect("nativeCapturePolicy" in api).toBe(false);
});
