import type { Artifact } from "@design-studio/contracts";
import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { snapshotCommandOperation } from "../src/command-lifetime.js";

const ports = vi.hoisted(() => ({
  publish: vi.fn(),
  close: vi.fn(async () => {}),
  registryClose: vi.fn(async () => {}),
}));
vi.mock("../src/installed-download.js", () => ({
  publishInstalledDownload: ports.publish,
}));
vi.mock("../src/catalog.js", () => ({
  loadCatalog: async () => ({
    identity: "owned",
    manifestBytes: new Uint8Array(),
  }),
}));
vi.mock("@design-studio/project-host", async (original) => ({
  ...(await original<typeof import("@design-studio/project-host")>()),
  WindowsFixtureProjects: {
    open: async () => ({
      openFixtureProject: async () => ({}),
      close: ports.registryClose,
    }),
  },
}));

import { openProject } from "../src/installed-project.js";

it("retains project and installation ownership until a download callback actually settles", async () => {
  let finish: ((artifact: Artifact) => void) | undefined;
  ports.publish.mockImplementation(
    () =>
      new Promise<Artifact>((resolve) => {
        finish = resolve;
      }),
  );
  const guard = { close: vi.fn(() => {}) };
  const installation = {
    identity: "owned-test",
    paths: {
      node: "node",
      bootstrapEntry: "bootstrap",
      cliEntry: "cli",
      rendererEntry: "renderer",
      fixtureCatalogRoot: "fixtures",
      browserRoot: "browser",
      sqliteBinding: "sqlite",
    },
    recheck: async () => {},
    checkCurrent: async () => {},
    close: ports.close,
  };
  const project = await openProject(installation, guard, false);
  const clock = createFakeClock(Date.now());
  const operation = snapshotCommandOperation({
    requestId: "download",
    deadline: new Date(clock.now() + 100).toISOString(),
    clock,
    signal: new AbortController().signal,
  });
  const artifact: Artifact = {
    id: "artifact",
    sha256: "a".repeat(64),
    byteLength: 1,
    path: "copy.bin",
    mediaType: "application/octet-stream",
  };
  const pending = project.publish(
    artifact,
    Uint8Array.of(1),
    "copy.bin",
    operation,
  );
  clock.advance(100);
  expect(await project.close()).toBe(false);
  expect(ports.registryClose).not.toHaveBeenCalled();
  expect(ports.close).not.toHaveBeenCalled();
  expect(guard.close).not.toHaveBeenCalled();
  expect(ports.publish.mock.calls[0]?.[6]).toBe(operation);
  await expect(
    project.publish(artifact, Uint8Array.of(1), "copy.bin", operation),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  finish?.(artifact);
  await pending;
  expect(await project.close()).toBe(true);
  expect(await project.close()).toBe(true);
  expect(ports.registryClose).toHaveBeenCalledOnce();
  expect(ports.close).toHaveBeenCalledOnce();
  expect(guard.close).toHaveBeenCalledOnce();
});
