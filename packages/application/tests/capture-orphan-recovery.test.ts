import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Outcome, ResourceSnapshot } from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
  CAPTURE_LIMITS,
} from "@design-studio/figma-capture";
import { SystemClock } from "@design-studio/host";
import { openCaptureProject } from "@design-studio/project-host";
import { LocalStore, type StoredJob } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import { FigmaHttpsTransport } from "../../figma-capture/dist/transport.js";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import type { CaptureWork } from "../../project-host/src/capture-work.js";
import { withCaptureInstallation } from "../../project-host/tests/capture-support.js";
import {
  type NativeCaptureInput,
  openNativeCapture,
} from "../src/capture-runtime.js";

const seam = vi.hoisted(() => ({ work: undefined as CaptureWork | undefined }));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor() {
      throw new Error(
        "Synthetic orphan recovery forbids real credential backend access",
      );
    }
  },
}));
vi.mock("@design-studio/project-host", async () => {
  const actual = await import("../../project-host/src/index.js");
  return {
    ...actual,
    acquireCaptureWork: (
      ...args: Parameters<typeof actual.acquireCaptureWork>
    ) => {
      const work = actual.acquireCaptureWork(...args);
      // The public module is replaced as a whole so tests use one actual native registry.
      seam.work = work;
      return work;
    },
  };
});
const value = <T>(outcome: Outcome<T>): T => {
  if (outcome.status !== "complete")
    throw new Error(`Synthetic recovery setup: ${outcome.error.code}`);
  return outcome.value;
};
const cases = (["inspect", "capture", "convert", "artifact"] as const).flatMap(
  (operation) =>
    [false, true].flatMap((claimed) =>
      [false, true].map((expired) => ({ operation, claimed, expired })),
    ),
);
it.skipIf(process.platform !== "win32").each(cases)(
  "quarantines orphan $operation claimed=$claimed expired=$expired without replay",
  async ({ operation, claimed, expired }) => {
    let db: LocalStore | undefined;
    const open = LocalStore.open.bind(LocalStore);
    const database = vi
      .spyOn(LocalStore, "open")
      .mockImplementation(async (options) => {
        db = await open({
          ...options,
          nativeBinding: path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
        });
        return db;
      });
    const network = vi
      .spyOn(FigmaHttpsTransport.prototype, "api")
      .mockRejectedValue(new Error("No recovery network"));
    const vault = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
      .mockRejectedValue(new Error("No recovery vault"));
    let elapsed = 0;
    const clock = vi
      .spyOn(SystemClock.prototype, "now")
      .mockImplementation(() => Date.now() + elapsed);
    try {
      await withCaptureInstallation(
        async (installation) => {
          let project = await openCaptureProject(installation);
          let runtime = await openNativeCapture(project);
          try {
            if (!db || !seam.work)
              throw new Error("Missing real native composition");
            const requestId = "orphan";
            const jobId = `capture_${canonicalDigest([project.projectId, project.principal.actorId, requestId])}`;
            const selection = { fileKey: "OrphanSynthetic", nodeId: "1:2" };
            const policy = {
              id: `native_${seam.work.policySha256}`,
              projectId: project.projectId,
              sourceId: `figma_${canonicalDigest([project.projectId, selection])}`,
              artifactRootId: project.artifactRootId,
              ...selection,
              credential: project.reference,
              imageOrigins: [],
            };
            const url =
              "https://www.figma.com/design/OrphanSynthetic/selection?node-id=1-2";
            const request = {
              schemaVersion: "1.0",
              projectId: project.projectId,
              captureId: jobId,
              policyId: policy.id,
              policySha256: canonicalDigest(policy),
              selectionUrl: url,
              credential: project.reference,
            };
            const resources: ResourceSnapshot = {
              schemaVersion: "1.0",
              id: "orphan_resources",
              projectId: project.projectId,
              components: {
                schemaVersion: "1.0",
                projectId: project.projectId,
                revision: "none",
                definitions: [],
                mappings: [],
              },
              tokens: {
                schemaVersion: "1.0",
                projectId: project.projectId,
                revision: "none",
                collections: [],
                selectedModes: {},
                definitions: [],
                resolved: [],
                adapters: [],
              },
              assets: [],
              fonts: [],
            };
            const seed = await seam.work.policy.issue({
              jobId: "orphan_seed",
              requestId: "orphan_seed",
              signal: new AbortController().signal,
            });
            const input = value(await db.stage(canonicalBytes(request), seed));
            const resource = value(
              await db.stage(canonicalBytes(resources), seed),
            );
            value(await db.commit([input, resource], seed));
            const context = await seam.work.policy.issue({
              jobId,
              requestId,
              signal: new AbortController().signal,
            });
            let record = value(
              await db.jobs.create(
                {
                  id: jobId,
                  operation: "capture",
                  input: {
                    id: input.artifact.id,
                    sha256: input.artifact.sha256,
                  },
                  resources: {
                    snapshotId: resource.artifact.id,
                    sha256: resource.artifact.sha256,
                    componentRegistryRevision: "none",
                    tokenRegistryRevision: "none",
                    selectedModes: {},
                  },
                  handlerId: CAPTURE_HANDLER_ID,
                  handlerVersion: CAPTURE_HANDLER_VERSION,
                  authorityRef: policy.id,
                  resourceKeys: ["orphan_source"],
                  deadline: context.deadline,
                  budget: { ...CAPTURE_LIMITS },
                },
                context,
              ),
            );
            const expected = (item: StoredJob) => {
              if (!item.job.lease) throw new Error("Missing synthetic claim");
              return {
                state: item.job.status,
                rowVersion: item.rowVersion,
                leaseId: item.job.lease.id,
                ownerId: item.job.lease.ownerId,
                fencingToken: item.generation,
                resources: item.resources,
              };
            };
            if (claimed) {
              record = value(
                await db.jobs.claim(
                  jobId,
                  { state: record.job.status, rowVersion: record.rowVersion },
                  "departed_owner",
                  30000,
                  context,
                ),
              );
              record = value(
                await db.jobs.update(
                  jobId,
                  expected(record),
                  {
                    kind: "reserve-usage",
                    id: "spent",
                    usage: {
                      inputBytes: 0,
                      outputBytes: 0,
                      externalCalls: 1,
                      modelTokens: 0,
                      costMicros: 0,
                    },
                  },
                  context,
                ),
              );
              value(
                await db.jobs.stage(
                  jobId,
                  expected(record),
                  Buffer.from("synthetic-retained-attempt"),
                  context,
                ),
              );
            }
            const originalDeadline = record.job.deadline;
            const id = project.projectId;
            await runtime.close();
            await project.close();
            elapsed = expired ? 60000 : 0;
            project = await openCaptureProject(installation, id);
            runtime = await openNativeCapture(project);
            const args: NativeCaptureInput = {
              operation,
              requestId,
              ...(operation === "capture" ? { url } : {}),
              ...(operation === "artifact"
                ? ({
                    role: "nodes",
                    outputRelative: "must-not-export.json",
                  } as const)
                : {}),
            };
            const result = await runtime.execute(
              args,
              new AbortController().signal,
            );
            expect(result).toMatchObject({
              status: "interrupted",
              error: { code: "INTERRUPTED" },
              value: { jobStatus: "interrupted" },
            });
            if (!db || !seam.work) throw new Error("Missing reopened owner");
            const inspect = await seam.work.policy.issue({
              jobId,
              requestId,
              signal: new AbortController().signal,
            });
            const saved = value(await db.jobs.get(jobId, inspect));
            expect(saved.job.deadline).toBe(originalDeadline);
            expect(saved.job.receipt).toBeUndefined();
            if (claimed) {
              expect(saved.effects[0]?.state).toBe("reserved");
              expect(
                value(await db.jobs.getStages(jobId, inspect)),
              ).toMatchObject([{ disposition: "recovery-needed" }]);
            }
            expect(network).not.toHaveBeenCalled();
            expect(vault).not.toHaveBeenCalled();
          } finally {
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
      network.mockRestore();
      vault.mockRestore();
      clock.mockRestore();
      seam.work = undefined;
    }
  },
  30000,
);
