import { PassThrough } from "node:stream";
import { ApplicationError } from "@design-studio/application";
import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  listen: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  emit: vi.fn(),
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
    read = calls.read;
    write = calls.write;
  },
}));
vi.mock("../src/service-evidence.js", () => ({
  emitServiceQuiescence: calls.emit,
}));
vi.mock("@design-studio/application", async (original) => ({
  ...(await original<typeof import("@design-studio/application")>()),
  listenHttp: calls.listen,
}));

import { serve } from "../src/service.js";

beforeEach(() => {
  vi.clearAllMocks();
  calls.close.mockImplementation(() => {});
  calls.emit.mockResolvedValue(undefined);
  calls.write.mockResolvedValue(undefined);
});
it("preserves typed acquisition failure and closes the channel without inventing project cleanup", async () => {
  const primary = new ApplicationError("ACTION_REQUIRED", 409);
  calls.acquire.mockRejectedValue(primary);
  await expect(serve(0, "3")).rejects.toBe(primary);
  expect(calls.close).toHaveBeenCalledOnce();
  expect(calls.listen).not.toHaveBeenCalled();
  expect(calls.emit).not.toHaveBeenCalled();
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
  expect(calls.emit).toHaveBeenCalledOnce();
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
  expect(calls.emit).not.toHaveBeenCalled();
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
  expect(calls.emit).not.toHaveBeenCalled();
});
it("emits quiescence only after idle read rejection closes the API and acquired project", async () => {
  const order: string[] = [];
  const primary = new ApplicationError("TRANSPORT_UNAVAILABLE", 503);
  calls.read.mockRejectedValue(primary);
  calls.acquire.mockResolvedValue({
    application: async () => ({
      facade: {},
      newClient: () => ({ credential: "x".repeat(43) }),
    }),
    close: async () => {
      order.push("project");
      return true;
    },
  });
  calls.listen.mockResolvedValue({
    port: 47119,
    authenticator: {},
    close: async () => {
      order.push("api");
    },
  });
  calls.emit.mockImplementation(async () => {
    order.push("evidence");
  });
  await expect(serve(0, "3")).rejects.toBe(primary);
  expect(calls.write).toHaveBeenCalledWith({
    kind: "ready",
    port: 47119,
    credential: "x".repeat(43),
  });
  expect(order).toEqual(["api", "project", "evidence"]);
  expect(calls.close).toHaveBeenCalledOnce();
});
it("retains the operational failure when the bounded teardown-evidence write fails", async () => {
  const primary = new ApplicationError("FORBIDDEN", 403);
  const writeFailure = new Error("Owned evidence write failed.");
  calls.acquire.mockResolvedValue({
    application: async () => {
      throw primary;
    },
    close: async () => true,
  });
  calls.emit.mockRejectedValue(writeFailure);
  await expect(serve(0, "3")).rejects.toMatchObject({
    code: "INTERRUPTED",
    cause: primary,
    cleanupFailures: [writeFailure],
  });
  expect(calls.close).toHaveBeenCalledOnce();
});
