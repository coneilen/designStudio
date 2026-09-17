import path from "node:path";
import { expect, test } from "vitest";
import {
  offlineRestorePaths,
  withOfflineRestoreDiagnostics,
} from "./offline-restore.js";

test("offline candidate restore uses unchanged defaults or explicit absolute test-only overrides", () => {
  const workspace = path.resolve("test-workspace");
  expect(offlineRestorePaths(workspace, {})).toEqual({
    store: path.join(workspace, ".tools", "pnpm-store"),
    cache: path.join(workspace, ".cache", "pnpm"),
  });
  const store = path.resolve("approved-store");
  const cache = path.resolve("approved-cache");
  expect(
    offlineRestorePaths(workspace, {
      FIXTURE_INSTALL_TEST_STORE: store,
      FIXTURE_INSTALL_TEST_CACHE: cache,
    }),
  ).toEqual({ store, cache });
  for (const value of ["relative", "../store", "", "C:relative", "bad\0path"]) {
    expect(() =>
      offlineRestorePaths(workspace, { FIXTURE_INSTALL_TEST_STORE: value }),
    ).toThrow(/absolute/);
    expect(() =>
      offlineRestorePaths(workspace, { FIXTURE_INSTALL_TEST_CACHE: value }),
    ).toThrow(/absolute/);
  }
  if (process.platform === "win32")
    expect(() =>
      offlineRestorePaths(workspace, {
        FIXTURE_INSTALL_TEST_STORE: "\\root-relative",
      }),
    ).toThrow(/absolute/);
});

test("nested restore diagnostics preserve cause and surface bounded code stdout and stderr", async () => {
  const failure = Object.assign(new Error("subprocess failed"), {
    code: 1,
    stdout: "ERR_PNPM_NO_OFFLINE_META: missing approved package metadata",
    stderr: "native stderr",
  });
  await expect(
    withOfflineRestoreDiagnostics(async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({
    cause: failure,
    message: expect.stringMatching(
      /code: 1[\s\S]*stdout: ERR_PNPM_NO_OFFLINE_META[\s\S]*stderr: native stderr/,
    ),
  });
  const oversized = {
    code: "E".repeat(1000),
    stdout: "x".repeat(100000),
    stderr: Buffer.alloc(100000, "y"),
  };
  try {
    await withOfflineRestoreDiagnostics(async () => {
      throw oversized;
    });
    throw new Error("Expected diagnostic failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toBe(oversized);
    expect(error.message.length).toBeLessThan(132000);
    expect(error.message).toContain("[truncated]");
  }
  await expect(
    withOfflineRestoreDiagnostics(async () => {
      throw null;
    }),
  ).rejects.toMatchObject({
    cause: null,
    message: expect.stringContaining("<unavailable>"),
  });
  expect(
    await withOfflineRestoreDiagnostics(async () => "unchanged success"),
  ).toBe("unchanged success");
});
