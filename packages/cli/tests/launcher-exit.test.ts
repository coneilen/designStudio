import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const owned = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  child: undefined as ChildProcess | undefined,
  script: "exited-service.mjs",
}));
vi.mock("@design-studio/application/installed", () => ({
  acquireInstalledLauncher: async () => ({
    installation: {
      paths: { node: process.execPath, bootstrapEntry: "test-owned-entry" },
      recheck: async () => {},
    },
    close: owned.release,
  }),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      _node: string,
      _args: string[],
      options: Parameters<typeof actual.spawn>[2],
    ) => {
      owned.child = actual.spawn(
        process.execPath,
        [path.resolve("packages\\cli\\tests\\fixtures", owned.script)],
        options,
      );
      return owned.child;
    },
  };
});

import { launchLocalSession } from "../src/launcher.js";

beforeEach(() => {
  owned.release.mockClear();
  owned.child = undefined;
  owned.script = "exited-service.mjs";
});

it("releases controller ownership after the actual fixed child exits quiescent even though fd3 is already closed", async () => {
  const session = await launchLocalSession();
  const child = owned.child;
  if (!child) throw new Error("Missing owned child.");
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await session.close();
  await session.close();
  expect(owned.release).toHaveBeenCalledOnce();
}, 10000);
it("releases after an actual idle read failure tears down the service and records quiescence on stderr", async () => {
  owned.script = "idle-service-error.mjs";
  const session = await launchLocalSession();
  const child = owned.child;
  if (!child) throw new Error("Missing owned service.");
  const exit = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const control = child.stdio[3];
  if (!control || !("end" in control))
    throw new Error("Missing control stream.");
  control.end();
  await exit;
  await expect(session.close()).rejects.toMatchObject({
    code: "INTERRUPTED",
    cause: { code: "TRANSPORT_UNAVAILABLE" },
  });
  await expect(session.close()).rejects.toMatchObject({ code: "INTERRUPTED" });
  expect(owned.release).toHaveBeenCalledOnce();
}, 10000);
