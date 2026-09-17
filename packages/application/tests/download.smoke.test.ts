import path from "node:path";
import { hashBytes } from "@design-studio/design-ir";
import { SystemClock } from "@design-studio/host";
import { expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { publishDownload } from "../src/download.js";
import { createFixturePolicy } from "../src/policy.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "../src/routes.js";
import { openAtTestRoot, ownedTest } from "./project-root.js";

it.runIf(process.platform === "win32" && process.arch === "x64")(
  "publishes only exact downloaded bytes to registered output roots without replacing files",
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
      const binding = await registry.createFixtureProject(scope);
      const policy = createFixturePolicy({
        clock: new SystemClock(),
        expectedActor: binding.principal.actorId,
        currentActor: async () => {
          await binding.recheck();
          return registry.currentPrincipal().actorId;
        },
        onRevoked: () => {},
      });
      const controller = new AbortController();
      const context = await policy.issue({
        requestId: "download",
        signal: controller.signal,
        grants: [
          {
            resourceKind: "artifact",
            resourceId: "foundation_outputs",
            operations: ["read", "write"],
          },
        ],
      });
      const bytes = Uint8Array.of(1, 2, 3);
      const source = {
        id: `sha256_${hashBytes(bytes)}`,
        sha256: hashBytes(bytes),
        byteLength: bytes.length,
        mediaType: "application/octet-stream",
        path: `blobs/${hashBytes(bytes)}`,
      };
      try {
        expect(
          (
            await publishDownload(
              binding,
              source,
              bytes,
              "chosen.bin",
              context,
              policy.verify,
            )
          ).sha256,
        ).toBe(source.sha256);
        await expect(
          publishDownload(
            binding,
            source,
            bytes,
            "chosen.bin",
            context,
            policy.verify,
          ),
        ).rejects.toThrow();
        await expect(
          publishDownload(
            binding,
            source,
            Uint8Array.of(0),
            "different.bin",
            context,
            policy.verify,
          ),
        ).rejects.toThrow();
        await expect(
          publishDownload(
            binding,
            source,
            bytes,
            "../outside.bin",
            context,
            policy.verify,
          ),
        ).rejects.toThrow();
      } finally {
        controller.abort();
        policy.revoke();
      }
    });
  },
  30000,
);
