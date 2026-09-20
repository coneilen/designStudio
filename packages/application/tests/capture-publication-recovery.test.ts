import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  OperationContext,
  StagedArtifact,
} from "@design-studio/contracts";
import { ProjectFileSystem, SystemClock } from "@design-studio/host";
import {
  openCaptureCredentials,
  openCaptureProject,
} from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import {
  NativeCaptureCommandCleanupRequired,
  runCaptureCommand,
} from "../../cli/src/capture-main.js";
import { FigmaHttpsTransport } from "../../figma-capture/dist/transport.js";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import { WindowsNtfsPublisher } from "../../host/dist/windows-publication.js";
import { loadNative } from "../../project-host/src/native.js";
import { withCaptureInstallation } from "../../project-host/tests/capture-support.js";
import { openNativeCapture } from "../src/capture-runtime.js";
import { NativeCaptureCleanupRequired } from "../src/capture-runtime-internal.js";

const fault = vi.hoisted(() => ({
  target: "",
  renamed: false,
  failures: 0,
  root: "",
}));
vi.mock("@design-studio/project-host", async () => {
  const actual = await import("../../project-host/src/index.js");
  const installation = await import("../../project-host/src/installation.js");
  return {
    ...actual,
    verifyCaptureInstallation: () =>
      installation.verifyCaptureInstalledRoot(fault.root),
  };
});
vi.mock("../../host/dist/windows-native.js", async (original) => {
  const actual =
    await original<typeof import("../../host/dist/windows-native.js")>();
  return {
    ...actual,
    loadWindowsBindings: async () => {
      const native = await actual.loadWindowsBindings();
      return {
        ...native,
        rename: (...args: Parameters<typeof native.rename>) => {
          native.rename(...args);
          if (
            fault.target === "managed"
              ? args[1].includes("\\blobs\\")
              : args[1].endsWith(fault.target) && fault.target
          )
            fault.renamed = true;
        },
        flush: (...args: Parameters<typeof native.flush>) => {
          if (
            fault.failures > 0 &&
            (fault.renamed ||
              (fault.target === "managed"
                ? native.inspect(args[0]).path.includes("\\blobs\\")
                : fault.target &&
                  native.inspect(args[0]).path.endsWith(fault.target)))
          ) {
            fault.renamed = false;
            fault.failures--;
            throw new Error("Synthetic post-rename flush fault");
          }
          native.flush(...args);
        },
      };
    },
  };
});
it
  .skipIf(process.platform !== "win32")
  .each(["intake", "job", "conversion", "export"] as const)(
  "retains and reconciles exact visible %s with fresh cleanup authority only",
  async (kind) => {
    let elapsed = 0;
    const clock = vi
      .spyOn(SystemClock.prototype, "now")
      .mockImplementation(() => Date.now() + elapsed);
    const open = LocalStore.open.bind(LocalStore);
    const commits = vi.spyOn(LocalStore.prototype, "commit");
    let jobCommits = 0;
    const database = vi
      .spyOn(LocalStore, "open")
      .mockImplementation(async (options) => {
        const store = await open({
          ...options,
          nativeBinding: path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
        });
        const commitJob = store.jobs.commitJob.bind(store.jobs);
        vi.spyOn(store.jobs, "commitJob").mockImplementation((...args) => {
          jobCommits++;
          return commitJob(...args);
        });
        return store;
      });
    let stored: Buffer | undefined;
    const read = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
      .mockImplementation(async () =>
        stored ? Buffer.from(stored) : undefined,
      );
    const write = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "write")
      .mockImplementation(async (bytes) => {
        stored = Buffer.from(bytes);
      });
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockImplementation(async (operation, _version, _secret, budget) => {
        if (kind === "job") {
          fault.target = "managed";
          fault.failures = 2;
        }
        const json =
          operation === "metadata"
            ? { file: { version: "synthetic_v1" } }
            : operation === "nodes"
              ? {
                  version: "synthetic_v1",
                  nodes: {
                    "1:2": {
                      document: {
                        id: "1:2",
                        type: "FRAME",
                        name: "Synthetic",
                        absoluteBoundingBox: {
                          x: 0,
                          y: 0,
                          width: 2,
                          height: 2,
                        },
                        children: [],
                      },
                    },
                  },
                }
              : {
                  images: {
                    "1:2": "https://images.capture.invalid/reference.png",
                  },
                };
        const bytes = Buffer.from(JSON.stringify(json));
        budget.dnsQuery();
        budget.receive(bytes.length);
        budget.decoded(bytes.length);
        return { status: 200, bytes, mediaType: "application/json" };
      });
    let pending:
      | {
          files: ProjectFileSystem;
          staged: StagedArtifact;
          context: OperationContext;
        }
      | undefined;
    const publish = ProjectFileSystem.prototype.publish;
    const publishing = vi
      .spyOn(ProjectFileSystem.prototype, "publish")
      .mockImplementation(async function (
        this: ProjectFileSystem,
        staged,
        context,
      ) {
        const result = await publish.call(this, staged, context);
        if (
          result.status !== "complete" &&
          result.error.code === "OUTPUT_UNCERTAIN"
        )
          pending = { files: this, staged, context };
        return result;
      });
    try {
      await withCaptureInstallation(
        async (installation) => {
          fault.root = path.dirname(
            path.dirname(installation.paths.bootstrapEntry),
          );
          const project = await openCaptureProject(installation);
          const admin = await openCaptureCredentials(project);
          try {
            expect(
              await admin.execute(
                "setup",
                project.reference.id,
                new AbortController().signal,
                Buffer.from("synthetic-recovery-pat"),
              ),
            ).toMatchObject({ status: "complete" });
          } finally {
            admin.close();
          }
          const runtime = await openNativeCapture(project);
          try {
            if (kind === "intake") {
              fault.target = "managed";
              fault.failures = 2;
            }
            const captured = await runtime.execute(
              {
                operation: "capture",
                requestId: "one",
                url: "https://www.figma.com/design/PublicationSynthetic/selection?node-id=1-2",
              },
              new AbortController().signal,
            );
            let result = captured;
            if (kind === "conversion" || kind === "export") {
              expect(captured).toMatchObject({ status: "partial" });
              fault.target = kind === "export" ? "uncertain.json" : "managed";
              fault.failures = 2;
              result = await runtime.execute(
                kind === "export"
                  ? {
                      operation: "artifact",
                      requestId: "one",
                      role: "nodes",
                      outputRelative: fault.target,
                    }
                  : { operation: "convert", requestId: "one" },
                new AbortController().signal,
              );
            }
            expect(result).toMatchObject({
              error: { code: "OUTPUT_UNCERTAIN" },
            });
            expect(pending).toBeDefined();
            if (!pending) throw new Error("Missing real uncertain publication");
            const originalDeadline = pending.context.deadline;
            elapsed = 60000;
            expect(
              await publish.call(
                pending.files,
                pending.staged,
                pending.context,
              ),
            ).not.toMatchObject({ status: "complete" });
            const calls = network.mock.calls.length;
            const reads = read.mock.calls.length;
            const originalCommits = commits.mock.calls.length;
            const originalJobCommits = jobCommits;
            let owner: NativeCaptureCleanupRequired | undefined;
            try {
              await runtime.close();
            } catch (error) {
              expect(error).toBeInstanceOf(NativeCaptureCleanupRequired);
              if (error instanceof NativeCaptureCleanupRequired) owner = error;
            }
            expect(owner?.pending).toMatchObject([{ kind }]);
            expect(owner?.operationCode).toBe("OUTPUT_UNCERTAIN");
            expect(owner?.cleanupCode).toBe("OUTPUT_UNCERTAIN");
            await expect(owner?.close()).resolves.toBeUndefined();
            await expect(runtime.close()).resolves.toBeUndefined();
            expect(pending.context.deadline).toBe(originalDeadline);
            expect(network).toHaveBeenCalledTimes(calls);
            expect(read).toHaveBeenCalledTimes(reads);
            expect(commits).toHaveBeenCalledTimes(originalCommits);
            expect(jobCommits).toBe(originalJobCommits);
            if (kind === "export") {
              const projectId = project.projectId;
              await project.close();
              fault.target = "cli-uncertain.json";
              fault.failures = 2;
              let commandOwner: NativeCaptureCommandCleanupRequired | undefined;
              try {
                await runCaptureCommand([
                  "figma",
                  "artifact",
                  "--project",
                  projectId,
                  "--request-id",
                  "one",
                  "--role",
                  "nodes",
                  "--output",
                  fault.target,
                ]);
              } catch (error) {
                if (error instanceof NativeCaptureCommandCleanupRequired)
                  commandOwner = error;
                else throw error;
              }
              expect(commandOwner?.result).toMatchObject({
                status: "interrupted",
                error: { code: "INTERRUPTED" },
              });
              expect(commandOwner?.operationCode).toBe("OUTPUT_UNCERTAIN");
              expect(commandOwner?.cleanupCode).toBe("OUTPUT_UNCERTAIN");
              expect(commandOwner?.result.error?.message).toContain(
                "Process exit is OS release, not recovery proof",
              );
              const native = await loadNative();
              const principal = vi
                .spyOn(native, "principal")
                .mockReturnValue("S-1-5-21-1-2-3-1234");
              try {
                await expect(commandOwner?.close()).rejects.toBe(commandOwner);
                expect(commandOwner?.cleanupCode).toBe("ACTION_REQUIRED");
                expect(commandOwner?.operationCode).toBe("OUTPUT_UNCERTAIN");
              } finally {
                principal.mockRestore();
              }
              await commandOwner?.close();
              await commandOwner?.close();
              expect(network).toHaveBeenCalledTimes(calls);
              expect(read).toHaveBeenCalledTimes(reads);
              const reopened = await openCaptureProject(
                installation,
                projectId,
              );
              const slow = await openNativeCapture(reopened);
              let releaseBarrier = () => {};
              let atBarrier = () => {};
              const gate = new Promise<void>((resolve) => {
                releaseBarrier = resolve;
              });
              const entered = new Promise<void>((resolve) => {
                atBarrier = resolve;
              });
              const resume = WindowsNtfsPublisher.prototype.resume;
              const resuming = vi
                .spyOn(WindowsNtfsPublisher.prototype, "resume")
                .mockImplementationOnce(async function (
                  this: WindowsNtfsPublisher,
                  ...args
                ) {
                  atBarrier();
                  await gate;
                  return resume.apply(this, args);
                });
              try {
                fault.target = "slow-uncertain.json";
                fault.failures = 1;
                expect(
                  await slow.execute(
                    {
                      operation: "artifact",
                      requestId: "one",
                      role: "nodes",
                      outputRelative: fault.target,
                    },
                    new AbortController().signal,
                  ),
                ).toMatchObject({ error: { code: "OUTPUT_UNCERTAIN" } });
                const closing = slow.close().catch((error: unknown) => error);
                await entered;
                await expect(reopened.close()).rejects.toThrow();
                const retained = await closing;
                expect(retained).toBeInstanceOf(NativeCaptureCleanupRequired);
                if (!(retained instanceof NativeCaptureCleanupRequired))
                  throw new Error("Missing retained native callback owner");
                expect(retained.cleanupCode).toBe("INTERRUPTED");
                const joined = retained.close();
                releaseBarrier();
                await joined;
                expect(resuming).toHaveBeenCalledTimes(1);
                await slow.close();
              } finally {
                releaseBarrier();
                resuming.mockRestore();
                await slow.close();
                await reopened.close();
              }
            }
          } finally {
            fault.failures = 0;
            await runtime.close();
            await project.close();
          }
        },
        {
          sqlite: await readFile(
            path.resolve(
              ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
            ),
          ),
        },
      );
    } finally {
      database.mockRestore();
      commits.mockRestore();
      read.mockRestore();
      write.mockRestore();
      network.mockRestore();
      publishing.mockRestore();
      clock.mockRestore();
      stored?.fill(0);
      fault.target = "";
      fault.renamed = false;
      fault.failures = 0;
    }
  },
  30000,
);
