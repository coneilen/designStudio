import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Artifact } from "@design-studio/contracts";
import { createFakeClock } from "@design-studio/contracts/testing";
import { hashBytes } from "@design-studio/design-ir";
import { ProjectFileSystem } from "@design-studio/host";
import type {
  FixtureProjectBinding,
  FixtureProjectRegistry,
} from "@design-studio/project-host";
import { afterEach, expect, it, vi } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import {
  type CommandOperation,
  snapshotCommandOperation,
} from "../src/command-lifetime.js";
import { downloadResult } from "../src/download.js";
import { publishInstalledDownload } from "../src/installed-download.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "../src/routes.js";
import { openAtTestRoot, ownedTest } from "./project-root.js";

const windows = it.runIf(
  process.platform === "win32" && process.arch === "x64",
);
const bytes = Uint8Array.of(4, 5, 6);
const sha256 = hashBytes(bytes);
const source: Artifact = {
  id: `sha256_${sha256}`,
  sha256,
  path: `blobs/${sha256}`,
  byteLength: bytes.length,
  mediaType: "application/octet-stream",
};
afterEach(() => vi.restoreAllMocks());
async function fixture(
  test: (
    registry: FixtureProjectRegistry,
    binding: FixtureProjectBinding,
  ) => Promise<void>,
) {
  const catalog = await loadCatalog(
    path.resolve("tests\\fixtures\\foundation"),
  );
  await ownedTest(async (root, own) => {
    const scope = {
      projectId: PROJECT_ID,
      artifactRootId: ARTIFACT_ROOT,
      permissionScope: PERMISSION_SCOPE,
    };
    const registry = own(
      await openAtTestRoot(
        {
          applicationId: "design-studio",
          catalogIdentity: catalog.identity,
          catalogBytes: catalog.manifestBytes,
          trustedImmutableInstallation: true,
          fixtures: [scope],
        },
        root,
      ),
    );
    await test(registry, await registry.createFixtureProject(scope));
  });
}
function command() {
  const clock = createFakeClock(Date.now());
  const controller = new AbortController();
  const operation = snapshotCommandOperation({
    requestId: "download_original",
    deadline: new Date(clock.now() + 100).toISOString(),
    signal: controller.signal,
    clock,
  });
  return { clock, controller, operation };
}
windows(
  "expires during installation recheck without issuing policy or publishing, and awaits the pending check",
  async () => {
    await fixture(async (registry, binding) => {
      const { operation, clock } = command();
      let finish: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let settled = false;
      const principal = vi.fn(() => registry.currentPrincipal());
      const stage = vi.spyOn(ProjectFileSystem.prototype, "stage");
      const result = publishInstalledDownload(
        { recheck: async () => gate },
        { currentPrincipal: principal },
        binding,
        source,
        bytes,
        "late.bin",
        operation,
      ).finally(() => {
        settled = true;
      });
      clock.advance(100);
      await Promise.resolve();
      expect(settled).toBe(false);
      finish?.();
      await expect(result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(principal).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      await expect(
        lstat(path.join(binding.paths.outputs, "late.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
  30000,
);
windows(
  "rejects expired or cancelled issuance before staging and preserves the original signal/deadline on every native operation",
  async () => {
    await fixture(async (registry, binding) => {
      const expired = command();
      const originalStage = ProjectFileSystem.prototype.stage;
      const stage = vi.spyOn(ProjectFileSystem.prototype, "stage");
      const delayedBinding = {
        ...binding,
        recheck: async () => {
          await binding.recheck();
          expired.clock.advance(100);
        },
      };
      await expect(
        publishInstalledDownload(
          { recheck: async () => {} },
          registry,
          delayedBinding,
          source,
          bytes,
          "issue.bin",
          expired.operation,
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(stage).not.toHaveBeenCalled();
      const cancelled = command();
      await expect(
        publishInstalledDownload(
          {
            recheck: async () => {
              cancelled.controller.abort();
            },
          },
          registry,
          binding,
          source,
          bytes,
          "cancel.bin",
          cancelled.operation,
        ),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(stage).not.toHaveBeenCalled();
      const valid = command();
      stage.mockRestore();
      const checkedStage = vi
        .spyOn(ProjectFileSystem.prototype, "stage")
        .mockImplementation(async function (
          this: ProjectFileSystem,
          request,
          content,
          context,
        ) {
          expect(context.deadline).toBe(valid.operation.deadline);
          expect(context.signal).toBe(valid.operation.signal);
          expect(context.clock).toBe(valid.operation.clock);
          expect(context.requestId).toBe(valid.operation.requestId);
          return originalStage.call(this, request, content, context);
        });
      // Call the real installed composition and native publication; no successful fake boundary.
      const result = await publishInstalledDownload(
        { recheck: async () => {} },
        registry,
        binding,
        source,
        bytes,
        "good.bin",
        valid.operation,
      );
      expect(checkedStage).toHaveBeenCalledOnce();
      expect(
        downloadResult(result, valid.operation, source, "good.bin"),
      ).toEqual(result);
    });
  },
  30000,
);
windows.each(["stage", "publish", "barrier", "binding"] as const)(
  "does not mint completion evidence when %s finishes after the original deadline",
  async (phase) => {
    await fixture(async (registry, binding) => {
      const { operation, clock } = command();
      if (phase === "stage") {
        const original = ProjectFileSystem.prototype.stage;
        vi.spyOn(ProjectFileSystem.prototype, "stage").mockImplementation(
          async function (this: ProjectFileSystem, ...args) {
            const result = await original.apply(this, args);
            clock.advance(100);
            return result;
          },
        );
      }
      if (phase === "publish") {
        const original = ProjectFileSystem.prototype.publish;
        vi.spyOn(ProjectFileSystem.prototype, "publish").mockImplementation(
          async function (this: ProjectFileSystem, ...args) {
            const result = await original.apply(this, args);
            clock.advance(100);
            return result;
          },
        );
      }
      if (phase === "barrier") {
        const original = ProjectFileSystem.prototype.ensurePublicationDurable;
        vi.spyOn(
          ProjectFileSystem.prototype,
          "ensurePublicationDurable",
        ).mockImplementation(async function (this: ProjectFileSystem, ...args) {
          const result = await original.apply(this, args);
          clock.advance(100);
          return result;
        });
      }
      let checks = 0;
      const checkedBinding = {
        ...binding,
        recheck: async () => {
          await binding.recheck();
          checks++;
          if (phase === "binding" && checks === 3) clock.advance(100);
        },
      };
      await expect(
        publishInstalledDownload(
          { recheck: async () => {} },
          registry,
          checkedBinding,
          source,
          bytes,
          "timed.bin",
          operation,
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      if (phase === "stage")
        await expect(
          lstat(path.join(binding.paths.outputs, "timed.bin")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      else
        expect(
          new Uint8Array(
            await readFile(path.join(binding.paths.outputs, "timed.bin")),
          ),
        ).toEqual(bytes);
    });
  },
  30000,
);
windows(
  "accepts delayed delivery only for the exact native result proven complete within the same command",
  async () => {
    await fixture(async (registry, binding) => {
      const { operation, clock, controller } = command();
      const originalClose = ProjectFileSystem.prototype.close;
      vi.spyOn(ProjectFileSystem.prototype, "close").mockImplementation(
        async function (this: ProjectFileSystem) {
          await originalClose.call(this);
          // Publication/barrier/current-policy checks already completed; only owned cleanup/delivery is delayed.
          clock.advance(100);
          controller.abort();
        },
      );
      const result = await publishInstalledDownload(
        { recheck: async () => {} },
        registry,
        binding,
        source,
        bytes,
        "complete.bin",
        operation,
      );
      expect(clock.now()).toBe(Date.parse(operation.deadline));
      const copiedOperation: CommandOperation = { ...operation };
      await expect(
        Promise.resolve().then(() =>
          downloadResult({ ...result }, operation, source, "complete.bin"),
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(() =>
        downloadResult(result, copiedOperation, source, "complete.bin"),
      ).toThrow();
      expect(() =>
        downloadResult(
          result,
          {
            ...operation,
            deadline: new Date(clock.now() + 30000).toISOString(),
          },
          source,
          "complete.bin",
        ),
      ).toThrow();
      expect(() =>
        downloadResult(
          result,
          { ...operation, signal: new AbortController().signal },
          source,
          "complete.bin",
        ),
      ).toThrow();
      expect(() =>
        downloadResult(
          result,
          { ...operation, requestId: "another" },
          source,
          "complete.bin",
        ),
      ).toThrow();
      expect(() =>
        downloadResult(result, operation, source, "different.bin"),
      ).toThrow();
      expect(() =>
        downloadResult(
          result,
          operation,
          { ...source, sha256: "a".repeat(64) },
          "complete.bin",
        ),
      ).toThrow();
      expect(downloadResult(result, operation, source, "complete.bin")).toBe(
        result,
      );
      expect(() =>
        downloadResult(result, operation, source, "complete.bin"),
      ).toThrow();
    });
  },
  30000,
);
