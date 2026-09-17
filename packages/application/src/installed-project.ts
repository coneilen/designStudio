import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Artifact } from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import { SystemClock } from "@design-studio/host";
import {
  type FixtureInstallationLease,
  type FixtureProjectBinding,
  WindowsFixtureProjects,
} from "@design-studio/project-host";
import { RendererWorkerHost } from "@design-studio/renderer-host";
import { loadCatalog } from "./catalog.js";
import { publishDownload } from "./download.js";
import {
  openFixtureApplication,
  StartupCleanupRequired,
} from "./fixture-application.js";
import { INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS } from "./installed-profile.js";
import { createFixturePolicy } from "./policy.js";
import { ApplicationError } from "./response.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "./routes.js";
import { diagnosticLine } from "./telemetry.js";

export async function openProject(
  installation: FixtureInstallationLease,
  guard: { close(): void },
  create: boolean,
) {
  const catalog = await loadCatalog(installation.paths.fixtureCatalogRoot);
  const scope = {
    projectId: PROJECT_ID,
    artifactRootId: ARTIFACT_ROOT,
    permissionScope: PERMISSION_SCOPE,
  };
  const registry = await WindowsFixtureProjects.open({
    applicationId: "design-studio",
    catalogIdentity: catalog.identity,
    catalogBytes: catalog.manifestBytes,
    trustedImmutableInstallation: true,
    fixtures: [scope],
  });
  let binding: FixtureProjectBinding;
  try {
    binding = create
      ? await registry.createFixtureProject(scope)
      : await registry.openFixtureProject(PROJECT_ID);
  } catch (error) {
    await registry.close();
    throw error;
  }
  const project = binding;
  let application:
    | Awaited<ReturnType<typeof openFixtureApplication>>
    | undefined;
  let pendingStartup: (() => Promise<boolean>) | undefined;
  let closed = false;
  let diagnosticCount = 0;
  const report = (line: string) => {
    if (diagnosticCount < 256) process.stderr.write(line);
    else if (diagnosticCount === 256)
      process.stderr.write(diagnosticLine("job-fault", 0, "OUTPUT_LIMIT"));
    diagnosticCount++;
  };
  return {
    installation,
    registry,
    binding: project,
    catalog,
    async application() {
      if (closed || pendingStartup)
        throw new ApplicationError("ACTION_REQUIRED", 409);
      if (application) return application;
      const nodeHash = hashBytes(await readFile(installation.paths.node));
      const implementationHash = hashBytes(
        await readFile(installation.paths.rendererEntry),
      );
      try {
        application = await openFixtureApplication({
          authorityTimeoutMs: INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS,
          registry,
          binding: project,
          catalog,
          nativeBinding: installation.paths.sqliteBinding,
          recheckInstallation: async () => {
            const started = performance.now();
            try {
              await installation.checkCurrent();
            } finally {
              report(
                diagnosticLine(
                  "installation-current",
                  performance.now() - started,
                ),
              );
            }
          },
          onJobEvent: (event) => {
            if (event.kind === "fault" && event.code)
              report(
                diagnosticLine("job-fault", event.elapsedMs ?? 0, event.code),
              );
          },
          worker: (authority) =>
            new RendererWorkerHost({
              projectId: PROJECT_ID,
              providerId: "renderer_static",
              authority,
              node: {
                path: installation.paths.node,
                sha256: nodeHash,
                maxBytes: 200000000,
              },
              implementation: {
                path: installation.paths.rendererEntry,
                sha256: implementationHash,
                maxBytes: 1000000,
              },
              tempRoot: project.paths.temp,
              trustedExclusiveAccess: true,
              environment: {
                SystemRoot: process.env.SystemRoot ?? "",
                TZ: "UTC",
              },
              limits: {
                startMs: 30000,
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
        });
        return application;
      } catch (error) {
        if (error instanceof StartupCleanupRequired)
          pendingStartup = error.close;
        throw error;
      }
    },
    async publish(artifact: Artifact, bytes: Uint8Array, relative: string) {
      if (closed) throw new ApplicationError("ACTION_REQUIRED");
      await installation.recheck();
      const policy = createFixturePolicy({
        clock: new SystemClock(),
        expectedActor: project.principal.actorId,
        currentActor: async () => {
          await project.recheck();
          return registry.currentPrincipal().actorId;
        },
        onRevoked: () => {},
      });
      const controller = new AbortController();
      try {
        const context = await policy.issue({
          requestId: randomUUID(),
          signal: controller.signal,
          grants: [
            {
              resourceKind: "artifact",
              resourceId: "foundation_outputs",
              operations: ["read", "write"],
            },
          ],
        });
        return await publishDownload(
          project,
          artifact,
          bytes,
          relative,
          context,
          policy.verify,
        );
      } finally {
        controller.abort();
        policy.revoke();
      }
    },
    async close(): Promise<boolean> {
      if (closed) return true;
      if (pendingStartup && !(await pendingStartup())) return false;
      if (application && !(await application.close())) return false;
      await registry.close();
      guard.close();
      await installation.close();
      closed = true;
      return true;
    },
  };
}
