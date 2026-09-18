import { mkdir } from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "@design-studio/design-ir";
import { ProjectFileSystem } from "@design-studio/host";
import { expect, it } from "vitest";
import { renderStaged } from "../src/renderer.js";
import { fixtureInputs, workerHarness } from "./support.js";

it.skipIf(process.env.F06_RENDER_SMOKE !== "1")(
  "real renderer stages immutable physical descriptors and retains partial stage ownership",
  async () => {
    const harness = await workerHarness();
    const artifactRoot = path.join(harness.root, "artifacts");
    await mkdir(artifactRoot);
    const filesystem = await ProjectFileSystem.create({
      projectId: "project_synthetic",
      authority: harness.authority,
      roots: [
        {
          id: "render_outputs",
          path: artifactRoot,
          access: "read-write",
          trustedExclusiveAccess: true,
          managedBlobs: true,
        },
      ],
    });
    try {
      const { request, accepted } = await fixtureInputs("image-crop-transform");
      const options = {
        projectId: "project_synthetic",
        providerId: "renderer_static",
        artifactRootId: "render_outputs",
        authority: harness.authority,
        rightsAuthority: (_license: unknown, hash: string) =>
          request.profile.fontHashes
            .concat(request.profile.assetHashes)
            .some((ref) => ref.sha256 === hash),
        resolveInputs: async () => accepted,
        filesystem,
        worker: harness.host,
      };
      const prepared = await renderStaged(
        request,
        harness.context("stage"),
        options,
      );
      expect(prepared.outcome.status, JSON.stringify(prepared.outcome)).toBe(
        "complete",
      );
      expect(prepared.staged).toHaveLength(6);
      expect(
        prepared.staged.every(
          (s) => s.artifact.mediaType === "application/octet-stream",
        ),
      ).toBe(true);
      expect(prepared.evidence?.artifacts[0]).toMatchObject({
        role: "preview",
        mediaType: "image/png",
      });
      expect(prepared.cleanup).toMatchObject({
        status: "complete",
        value: { jobEmptyObserved: true },
      });
      expect(prepared.recoveryRequired).toBe(false);
      if (prepared.outcome.status === "complete") {
        expect(prepared.outcome.value.boundsMap.preview.sha256).toBe(
          prepared.staged[0]?.artifact.sha256,
        );
        expect(prepared.outcome.value.boundsMap.profile.sha256).toBe(
          prepared.staged[1]?.artifact.sha256,
        );
      }
      let stages = 0;
      const interrupted = await renderStaged(
        request,
        harness.context("failed-stage"),
        {
          ...options,
          filesystem: {
            stage: async (file, bytes, context) => {
              expect(file.path).toBe(`blobs/${hashBytes(bytes)}`);
              if (++stages === 3)
                return {
                  schemaVersion: "1.0",
                  projectId: context.projectId,
                  requestId: context.requestId,
                  status: "interrupted",
                  error: {
                    code: "OUTPUT_UNCERTAIN",
                    message: "Injected uncertain stage.",
                    retryable: false,
                    diagnosticIds: [],
                  },
                  diagnosticIds: [],
                };
              return filesystem.stage(file, bytes, context);
            },
          },
        },
      );
      expect(stages).toBe(3);
      expect(interrupted.outcome).toMatchObject({
        status: "interrupted",
        error: { code: "OUTPUT_UNCERTAIN" },
      });
      expect(interrupted.staged).toHaveLength(2);
      expect(interrupted.recoveryRequired).toBe(true);
    } finally {
      await filesystem.close();
      await harness.remove();
    }
  },
  40_000,
);
