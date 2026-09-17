import { PassThrough } from "node:stream";
import { ApplicationError } from "@design-studio/application";
import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@design-studio/application/installed", () => ({
  openInstalledProject: calls.acquire,
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  Socket: class extends PassThrough {},
}));
vi.mock("../src/channel.js", () => ({
  PrivateChannel: class {
    close = calls.close;
  },
}));
vi.mock("@design-studio/application", async (original) => ({
  ...(await original<typeof import("@design-studio/application")>()),
  listenHttp: calls.listen,
}));

import { serve } from "../src/service.js";

beforeEach(() => {
  vi.clearAllMocks();
  calls.close.mockImplementation(() => {});
});
it("preserves typed acquisition failure and closes the channel without inventing project cleanup", async () => {
  const primary = new ApplicationError("ACTION_REQUIRED", 409);
  calls.acquire.mockRejectedValue(primary);
  await expect(serve(0, "3")).rejects.toBe(primary);
  expect(calls.close).toHaveBeenCalledOnce();
  expect(calls.listen).not.toHaveBeenCalled();
});
it("preserves primary and secondary failure when channel close itself fails", async () => {
  const primary = new ApplicationError("ACTION_REQUIRED", 409);
  const secondary = new Error("Owned channel close failed.");
  calls.acquire.mockRejectedValue(primary);
  calls.close.mockImplementation(() => {
    throw secondary;
  });
  await expect(serve(0, "3")).rejects.toMatchObject({
    code: "INTERRUPTED",
    cause: primary,
  });
});
it("closes a partially acquired project on application startup failure and always releases fd3", async () => {
  const primary = new ApplicationError("FORBIDDEN", 403);
  const closeProject = vi.fn(async () => true);
  calls.acquire.mockResolvedValue({
    application: async () => {
      throw primary;
    },
    close: closeProject,
  });
  await expect(serve(0, "3")).rejects.toBe(primary);
  expect(closeProject).toHaveBeenCalledOnce();
  expect(calls.close).toHaveBeenCalledOnce();
});
it("does not lose incomplete project shutdown or its retry capability when startup fails", async () => {
  const primary = new ApplicationError("FORBIDDEN", 403);
  const closeProject = vi.fn(async () => false);
  calls.acquire.mockResolvedValue({
    application: async () => {
      throw primary;
    },
    close: closeProject,
  });
  const error = await serve(0, "3").catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "INTERRUPTED", cause: primary });
  expect(calls.close).toHaveBeenCalledOnce();
  expect(error).toHaveProperty("close");
});
it("closes fd3 even when cleanup of an acquired project throws", async () => {
  const primary = new ApplicationError("FORBIDDEN", 403);
  const secondary = new Error("Owned project close failed.");
  calls.acquire.mockResolvedValue({
    application: async () => {
      throw primary;
    },
    close: async () => {
      throw secondary;
    },
  });
  await expect(serve(0, "3")).rejects.toMatchObject({
    code: "INTERRUPTED",
    cause: primary,
    cleanupFailures: [secondary],
  });
  expect(calls.close).toHaveBeenCalledOnce();
});
