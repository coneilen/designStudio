import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "@design-studio/design-ir";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { RendererWorkerHost } from "@design-studio/renderer-host";
import { expect, it } from "vitest";
import { parseArguments } from "../../cli/src/arguments.js";
import { callApi } from "../../cli/src/client.js";
import { FIXTURE_IDS, loadCatalog } from "../src/catalog.js";
import { openFixtureApplication } from "../src/fixture-application.js";
import { listenHttp } from "../src/http.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "../src/routes.js";
import { openAtTestRoot, ownedTest } from "./project-root.js";

it
  .runIf(
    process.platform === "win32" &&
      process.arch === "x64" &&
      process.env.F06_RENDER_SMOKE === "1",
  )
  .each(FIXTURE_IDS)(
  "accepts unchanged %s, atomically renders its tracked job and serves only verified PNG on native owned roots",
  async (fixtureId) => {
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
            catalogBytes: catalog.manifestBytes,
            catalogIdentity: catalog.identity,
            trustedImmutableInstallation: true,
            fixtures: [scope],
          },
          root,
        ),
      );
      const binding = await registry.createFixtureProject(scope);
      const implementation = path.resolve(
        "packages\\renderer\\tests\\fixtures\\render-worker.mjs",
      );
      const implementationHash = hashBytes(await readFile(implementation));
      const nodeHash = hashBytes(await readFile(process.execPath));
      let preparation = "";
      let preparations = 0;
      const setup: Parameters<typeof openFixtureApplication>[0] = {
        registry,
        binding,
        catalog,
        nativeBinding: path.resolve(
          ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
        ),
        observePreparation: (result) => {
          preparations++;
          preparation = JSON.stringify({
            status: result.outcome.status,
            error:
              result.outcome.status === "complete"
                ? undefined
                : result.outcome.error,
            stagedCount: result.staged.length,
            cleanup: result.cleanup,
            recoveryRequired: result.recoveryRequired,
          });
        },
        recheckInstallation: async () => {
          if (
            hashBytes(await readFile(implementation)) !== implementationHash ||
            hashBytes(await readFile(process.execPath)) !== nodeHash
          )
            throw new Error("Owned test implementation changed.");
        },
        worker: (authority) =>
          new RendererWorkerHost({
            projectId: PROJECT_ID,
            providerId: "renderer_static",
            authority,
            node: {
              path: process.execPath,
              sha256: nodeHash,
              maxBytes: 200000000,
            },
            implementation: {
              path: implementation,
              sha256: implementationHash,
              maxBytes: 1000000,
            },
            tempRoot: binding.paths.temp,
            trustedExclusiveAccess: true,
            environment: {
              SystemRoot: process.env.SystemRoot ?? "",
              TZ: "UTC",
            },
            limits: {
              startMs: 15000,
              idleMs: 10000,
              lifetimeMs: 30000,
              closeMs: 5000,
              maxFrameBytes: 20000000,
              maxInputBytes: 26214400,
              maxOutputBytes: 26214400,
              maxStdoutBytes: 16384,
              maxStderrBytes: 16384,
              maxRequests: 1,
            },
          }),
      };
      let application = await openFixtureApplication(setup);
      try {
        const accepted = await application.call({
          operation: "acceptFixture",
          projectId: PROJECT_ID,
          id: `design_${fixtureId}`,
          requestId: `accept_${fixtureId}`,
          parameters: {},
          body: { fixtureId, branch: "main", base: null },
          ifNoneMatch: "*",
        });
        if (
          accepted.kind !== "json" ||
          !accepted.envelope.success ||
          accepted.envelope.data.kind !== "revision"
        )
          throw new Error(JSON.stringify(accepted));
        const revision = accepted.envelope.data.revision;
        const acceptedIdentity = structuredClone(revision);
        const replay = await application.call({
          operation: "acceptFixture",
          projectId: PROJECT_ID,
          id: revision.designId,
          requestId: `accept_${fixtureId}`,
          parameters: {},
          body: { fixtureId, branch: "main", base: null },
          ifNoneMatch: "*",
        });
        if (
          replay.kind !== "json" ||
          !replay.envelope.success ||
          replay.envelope.data.kind !== "revision"
        )
          throw new Error("Expected independently owned acceptance replay.");
        replay.envelope.data.design.resources.sha256 = "f".repeat(64);
        replay.envelope.data.design.root.id = "caller_replaced";
        replay.envelope.data.revision.resources.selectedModes.core =
          "caller_mode";
        replay.envelope.data.warnings.length = 0;
        expect(revision).toEqual(acceptedIdentity);
        expect(revision.resources.snapshotId).toBe("resources_synthetic");
        const submitted = await application.call({
          operation: "submitRender",
          projectId: PROJECT_ID,
          id: revision.designId,
          requestId: `render_${fixtureId}`,
          parameters: {},
          body: {
            revision: { id: revision.id, sha256: revision.content.sha256 },
            base: {
              expectedBaseRevision: revision.id,
              ifMatch: `"${revision.content.sha256}"`,
            },
            mode: fixtureId === "unsupported-feature" ? "inspection" : "strict",
          },
          ifMatch: `"${revision.content.sha256}"`,
        });
        if (
          submitted.kind !== "json" ||
          !submitted.envelope.success ||
          submitted.envelope.data.kind !== "accepted-job" ||
          !submitted.envelope.data.jobId
        )
          throw new Error(JSON.stringify(submitted));
        const jobId = submitted.envelope.data.jobId;
        const completed = await application
          .call({
            operation: "waitJob",
            projectId: PROJECT_ID,
            id: jobId,
            requestId: "observe",
            parameters: { timeoutMs: "30000" },
          })
          .catch((error) => {
            throw new Error(`Owned render observation failed: ${preparation}`, {
              cause: error,
            });
          });
        if (
          completed.kind !== "json" ||
          !completed.envelope.success ||
          completed.envelope.data.kind !== "job"
        )
          throw new Error(JSON.stringify(completed));
        expect(completed.envelope.data.job?.status, preparation).toBe(
          "completed",
        );
        expect(completed.envelope.data.job?.receipt?.outputs).toHaveLength(6);
        expect(completed.envelope.data.job?.outputState).toBe(
          fixtureId === "unsupported-feature"
            ? "partial-inspection"
            : "complete",
        );
        expect(completed.envelope.data.job?.comparisonVerdict).toBeUndefined();
        const png = await application.call({
          operation: "getPreview",
          projectId: PROJECT_ID,
          id: jobId,
          requestId: "preview",
          parameters: {},
        });
        expect(png.kind).toBe("binary");
        if (png.kind === "binary") expect(png.mediaType).toBe("image/png");
        if (fixtureId === "settings-screen") {
          expect(await application.close()).toBe(true);
          const reopenedBinding = await registry.openFixtureProject(PROJECT_ID);
          application = await openFixtureApplication({
            ...setup,
            binding: reopenedBinding,
          });
          const read = await application.call({
            operation: "getJob",
            projectId: PROJECT_ID,
            id: jobId,
            requestId: "restart_read",
            parameters: {},
          });
          if (
            read.kind !== "json" ||
            !read.envelope.success ||
            read.envelope.data.kind !== "job"
          )
            throw new Error("Expected durable job.");
          expect(read.envelope.data.job?.receipt).toEqual(
            completed.envelope.data.job?.receipt,
          );
          expect(preparations).toBe(1);
          const api = await listenHttp(
            application.facade,
            (host) =>
              new LocalSessionAuthenticator({
                clock: new SystemClock(),
                hosts: [host],
                origins: [`http://${host}`],
              }),
          );
          try {
            const credentials = application.newClient(
              api.authenticator,
              `127.0.0.1:${api.port}`,
            );
            const preview = await callApi(
              parseArguments(["preview", jobId, "--json"]),
              { port: api.port, credential: credentials.credential },
            );
            if (!preview.success || preview.data.kind !== "artifact")
              throw new Error("Expected verified PNG metadata.");
            expect(preview.data.artifact?.mediaType).toBe(
              "application/octet-stream",
            );
            expect(
              preview.data.warnings.some(
                (warning) => warning.code === "APPROVAL_REQUIRED",
              ),
            ).toBe(true);
          } finally {
            await api.close();
          }
        }
      } finally {
        expect(await application.close()).toBe(true);
      }
    });
  },
  60000,
);
