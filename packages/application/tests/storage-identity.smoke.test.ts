import path from "node:path";
import { AssetPipeline } from "@design-studio/assets";
import type { Revision } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import {
  authorizeOperation,
  ProjectFileSystem,
  SystemClock,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { LocalStore } from "@design-studio/storage";
import { expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { fixtureSemantics } from "../src/fixtures.js";
import { createFixturePolicy } from "../src/policy.js";
import { unwrap } from "../src/response.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "../src/routes.js";
import { openAtTestRoot, ownedTest } from "./project-root.js";

it.runIf(process.platform === "win32" && process.arch === "x64")(
  "records the integrated logical-resource/physical-blob identity gap without relabeling fixtures",
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
            catalogBytes: catalog.manifestBytes,
            catalogIdentity: catalog.identity,
            trustedImmutableInstallation: true,
            fixtures: [scope],
          },
          root,
        ),
      );
      const binding = await registry.createFixtureProject(scope);
      const lifetime = new AbortController();
      const policy = createFixturePolicy({
        clock: new SystemClock(),
        expectedActor: binding.principal.actorId,
        onRevoked: () => lifetime.abort(),
        currentActor: async () => {
          await binding.recheck();
          return registry.currentPrincipal().actorId;
        },
      });
      const context = await policy.issue({
        requestId: "fixture_identity",
        jobId: "fixture_identity_job",
        signal: lifetime.signal,
        grants: [
          policy.rootGrant,
          {
            resourceKind: "artifact",
            resourceId: "resources_synthetic",
            operations: ["read", "write"],
          },
          {
            resourceKind: "job",
            resourceId: "fixture_identity_job",
            operations: ["read", "write"],
          },
          {
            resourceKind: "design",
            resourceId: "design_settings-screen",
            operations: ["read", "write"],
          },
          {
            resourceKind: "revision",
            resourceId: "fixture_revision",
            operations: ["read", "write"],
          },
        ],
      });
      const files = await ProjectFileSystem.create({
        projectId: PROJECT_ID,
        authority: policy.verify,
        publicationProfile: WINDOWS_PUBLICATION_PROFILE,
        roots: [
          {
            id: ARTIFACT_ROOT,
            path: binding.paths.artifacts,
            access: "read-write",
            managedBlobs: true,
            trustedExclusiveAccess: true,
          },
        ],
      });
      const denied = async (): Promise<never> => {
        throw new Error("Operation outside this owned identity fixture.");
      };
      let store: LocalStore | undefined;
      try {
        store = await LocalStore.open({
          ...scope,
          databasePath: binding.paths.database,
          nativeBinding: path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
          fileSystem: files,
          snapshotOperationContext,
          canonicalBytes,
          attestLocalDatabase: binding.attestLocalDatabase.bind(binding),
          authorize: async (ctx, resource) =>
            authorizeOperation(ctx, resource, policy.verify),
          ensurePublicationDurable: async (artifacts, ctx) => {
            unwrap(
              await files.ensurePublicationDurable(
                ARTIFACT_ROOT,
                artifacts,
                ctx,
              ),
            );
          },
          ensureDatabaseBackupDurable: denied,
          verifyRevision: denied,
          assessApproval: denied,
          authorizeRestore: denied,
          authorizeRetention: denied,
          canDiscardStage: async () => false,
          maintenance: {
            inventory: async (ctx, limit) =>
              unwrap(await files.inventory(ARTIFACT_ROOT, ctx, limit)),
            removeBlob: denied,
          },
        });
        const fixture = catalog.fixture("settings-screen");
        const semantics = fixtureSemantics(catalog, "settings-screen");
        const assetPipeline = new AssetPipeline({
          filesystem: files,
          rightsAuthority: semantics.rightsAuthority,
          authorize: async (ctx, root, operation) => {
            authorizeOperation(
              ctx,
              {
                projectId: PROJECT_ID,
                resourceKind: "artifact",
                resourceId: root,
                operation,
              },
              policy.verify,
            );
            return { permissionScope: PERMISSION_SCOPE, offlineAllowed: true };
          },
        });
        const assetSnapshot = await assetPipeline.stageSnapshot(
          ARTIFACT_ROOT,
          semantics.assets,
          context,
        );
        expect(assetSnapshot.fonts).toHaveLength(1);
        expect(assetSnapshot.images).toHaveLength(1);
        expect(
          assetSnapshot.staged.every(
            (staged) =>
              staged.artifact.mediaType === "application/octet-stream",
          ),
        ).toBe(true);
        const content = unwrap(
          await store.stage(canonicalBytes(fixture.design), context),
        );
        const resources = unwrap(
          await store.stage(fixture.resourceBytes, context),
        );
        const provenance = unwrap(
          await store.stage(fixture.provenanceBytes, context),
        );
        const probe = unwrap(
          await store.stage(Uint8Array.of(7, 8, 9), context),
        );
        const published = await files.publish(probe, context);
        expect(
          published,
          published.status === "complete" ? "" : published.error.message,
        ).toMatchObject({ status: "complete" });
        expect(resources.artifact.id).toBe(
          `sha256_${hashBytes(fixture.resourceBytes)}`,
        );
        expect(fixture.design.resources.snapshotId).toBe("resources_synthetic");
        const revision: Revision = {
          schemaVersion: "1.0",
          id: "fixture_revision",
          projectId: PROJECT_ID,
          designId: fixture.design.designId,
          parents: [],
          resources: fixture.design.resources,
          content: { id: content.artifact.id, sha256: content.artifact.sha256 },
          provenance: {
            id: provenance.artifact.id,
            sha256: provenance.artifact.sha256,
          },
          actorId: context.authorization.actorId,
          createdAt: "2026-09-16T00:00:00Z",
          changeSource: "import",
        };
        const result = await store.commitRevision(
          {
            branch: "main",
            base: null,
            revision,
            outputs: [content, resources, provenance],
          },
          context,
        );
        expect(result).toMatchObject({
          status: "failed",
          error: {
            code: "NOT_FOUND",
            message:
              "NOT_FOUND: Pinned artifact is unavailable in this project.",
          },
        });
        expect(
          unwrap(await store.getHead(fixture.design.designId, "main", context)),
        ).toBeNull();
      } finally {
        store?.close();
        await files.close();
        policy.revoke();
      }
    });
  },
  30000,
);
