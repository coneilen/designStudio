import path from "node:path";
import { createFakeClock } from "@design-studio/contracts/testing";
import {
  HostBoundaryError,
  LocalSessionAuthenticator,
  SystemClock,
} from "@design-studio/host";
import { expect, it } from "vitest";
import { parseArguments } from "../../cli/src/arguments.js";
import { callApi } from "../../cli/src/client.js";
import { loadCatalog } from "../src/catalog.js";
import { openFixtureApplication } from "../src/fixture-application.js";
import { listenHttp } from "../src/http.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "../src/routes.js";
import type { Invocation } from "../src/types.js";
import { openAtTestRoot, ownedTest } from "./project-root.js";

it.runIf(process.platform === "win32" && process.arch === "x64")(
  "accepts exact idempotent fixture revisions and reopens native registered roots without a browser",
  async () => {
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
      let binding = await registry.createFixtureProject(scope);
      let duringRecheck: () => void = () => {};
      const open = () =>
        openFixtureApplication({
          registry,
          binding,
          catalog,
          nativeBinding: path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
          // Explicit test-owned composition, not an attestation of a shipped installation.
          recheckInstallation: async () => {
            const checked = await loadCatalog(
              path.resolve("tests\\fixtures\\foundation"),
            );
            expect(checked.identity).toBe(catalog.identity);
            duringRecheck();
          },
          worker: () => ({
            async open() {
              throw new HostBoundaryError(
                "TOOL_MISSING",
                "No browser requested by this owned fixture.",
              );
            },
          }),
        });
      let application = await open();
      const accept: Invocation = {
        operation: "acceptFixture",
        projectId: PROJECT_ID,
        id: "design_settings-screen",
        requestId: "stable_accept",
        parameters: {},
        ifNoneMatch: "*",
        body: { fixtureId: "settings-screen", branch: "main", base: null },
      };
      try {
        await expect(open()).rejects.toMatchObject({ code: "WRITER_BUSY" });
        const clock = createFakeClock(Date.now());
        const external = new LocalSessionAuthenticator({
          clock,
          hosts: ["127.0.0.1:47119"],
          origins: [],
        });
        const session = application.newClient(external, "127.0.0.1:47119");
        const authorization = external.authenticate({
          remoteAddress: "127.0.0.1",
          host: session.host,
          method: "GET",
          bearer: session.credential,
        });
        duringRecheck = () => {
          external.revoke(authorization);
        };
        await expect(
          application.facade.invoke(
            {
              operation: "doctor",
              projectId: PROJECT_ID,
              requestId: "revoked_in_recheck",
              parameters: {},
            },
            authorization,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
        duringRecheck = () => {};
        const result = await application.call(accept);
        expect(await application.call(accept)).toEqual(result);
        await expect(
          application.call({
            ...accept,
            id: "design_mixed-styled-text",
            body: {
              fixtureId: "mixed-styled-text",
              branch: "main",
              base: null,
            },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await application.close()).toBe(true);
        binding = await registry.openFixtureProject(PROJECT_ID);
        application = await open();
        expect(await application.call(accept)).toEqual(result);
        const head = await application.call({
          operation: "getDesign",
          projectId: PROJECT_ID,
          id: "design_settings-screen",
          requestId: "read_reopened",
          parameters: { branch: "main" },
        });
        expect(head.kind).toBe("json");
        if (
          head.kind === "json" &&
          head.envelope.success &&
          head.envelope.data.kind === "revision"
        ) {
          expect(head.envelope.data.design.resources.snapshotId).toBe(
            "resources_synthetic",
          );
          const revision = head.envelope.data.revision;
          const submit: Invocation = {
            operation: "submitRender",
            projectId: PROJECT_ID,
            id: revision.designId,
            requestId: "durable_render",
            parameters: {},
            ifMatch: `"${revision.content.sha256}"`,
            body: {
              revision: { id: revision.id, sha256: revision.content.sha256 },
              base: {
                expectedBaseRevision: revision.id,
                ifMatch: `"${revision.content.sha256}"`,
              },
              mode: "strict",
            },
          };
          const accepted = await application.call(submit);
          if (
            accepted.kind !== "json" ||
            !accepted.envelope.success ||
            accepted.envelope.data.kind !== "accepted-job" ||
            !accepted.envelope.data.jobId
          )
            throw new Error("Expected accepted render job.");
          const jobId = accepted.envelope.data.jobId;
          const observed = await application.call({
            operation: "waitJob",
            projectId: PROJECT_ID,
            id: jobId,
            requestId: "observe_failure",
            parameters: {},
          });
          if (
            observed.kind !== "json" ||
            !observed.envelope.success ||
            observed.envelope.data.kind !== "job"
          )
            throw new Error("Expected job snapshot.");
          expect(observed.envelope.data.job?.status).not.toBe("completed");
          expect(await application.close()).toBe(true);
          binding = await registry.openFixtureProject(PROJECT_ID);
          application = await open();
          const current = await application.call({
            operation: "getJob",
            projectId: PROJECT_ID,
            id: jobId,
            requestId: "fresh_discovery",
            parameters: {},
          });
          if (
            current.kind !== "json" ||
            !current.envelope.success ||
            current.envelope.data.kind !== "job" ||
            !current.etag
          )
            throw new Error("Expected versioned discovered job.");
          const cancel: Invocation = {
            operation: "cancelJob",
            projectId: PROJECT_ID,
            id: jobId,
            requestId: "durable_cancel",
            parameters: {},
            body: {},
            ifMatch: current.etag,
          };
          const controlled = await application.call(cancel);
          expect(await application.call(cancel)).toEqual(controlled);
          await expect(
            application.call({ ...cancel, ifMatch: `"job:${jobId}:1"` }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          const replay = await application.call(submit);
          expect(replay.kind).toBe("json");
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
            const remotelyRead = await callApi(
              parseArguments([
                "designs",
                "get",
                "design_settings-screen",
                "--json",
              ]),
              { port: api.port, credential: credentials.credential },
            );
            expect(remotelyRead.success).toBe(true);
            if (remotelyRead.success && remotelyRead.data.kind === "revision")
              expect(remotelyRead.data.revision.id).toBe(revision.id);
            else throw new Error("Expected native API revision.");
            const changed = await callApi(
              parseArguments([
                "fixtures",
                "accept",
                "settings-screen",
                "--new",
                "--branch",
                "main",
                "--request-id",
                "different_new_root",
                "--json",
              ]),
              { port: api.port, credential: credentials.credential },
            );
            expect(changed.success).toBe(false);
            if (!changed.success) expect(changed.error.code).toBe("CONFLICT");
            const remoteJob = await callApi(
              parseArguments(["jobs", "get", jobId, "--json"]),
              { port: api.port, credential: credentials.credential },
            );
            expect(remoteJob.success).toBe(true);
          } finally {
            await api.close();
          }
        } else throw new Error("Expected accepted design.");
      } finally {
        expect(await application.close()).toBe(true);
      }
    });
  },
  60000,
);
