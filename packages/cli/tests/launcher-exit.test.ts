import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, it, vi } from "vitest";

const owned = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  child: undefined as ChildProcess | undefined,
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
        [path.resolve("packages\\cli\\tests\\fixtures\\exited-service.mjs")],
        options,
      );
      return owned.child;
    },
  };
});

import { launchLocalSession } from "../src/launcher.js";

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
