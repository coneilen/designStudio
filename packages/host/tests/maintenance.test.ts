import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import { ProjectFileSystem } from "../src/filesystem.js";

it("inventories only explicitly managed hash blobs after restart and requires a reference-safe deletion permit", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "studio-maintenance-owned-"),
  );
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "managed",
    operations: ["read", "write"],
  });
  const bytes = Uint8Array.of(1, 2, 3);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let reserved = false;
  const options = {
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "managed",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ] as const,
    authorizeRemoval: async () => reserved,
  };
  let files = await ProjectFileSystem.create(options);
  try {
    const staged = await files.stage(
      { artifactRootId: "managed", path: `blobs/${sha256}` },
      bytes,
      context,
    );
    if (staged.status !== "complete") throw new Error(JSON.stringify(staged));
    expect(await files.publish(staged.value, context)).toMatchObject({
      status: "complete",
    });
    await files.close();
    files = await ProjectFileSystem.create(options);
    const inventory = await files.inventory("managed", context, 10);
    expect(inventory).toMatchObject({
      status: "complete",
      value: { stagedIds: [], publishedArtifacts: [staged.value.artifact] },
    });
    expect(
      await files.ensurePublicationDurable(
        "managed",
        [staged.value.artifact],
        context,
      ),
    ).toMatchObject({
      status: "unavailable",
      error: { code: "UNSUPPORTED_FEATURE" },
    });
    expect(
      await files.removeUnreferenced("managed", staged.value.artifact, context),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    reserved = true;
    expect(
      await files.removeUnreferenced(
        "managed",
        { ...staged.value.artifact, sha256: "0".repeat(64) },
        context,
      ),
    ).toMatchObject({ error: { code: "ARTIFACT_INTEGRITY" } });
    expect(
      await files.removeUnreferenced("managed", staged.value.artifact, context),
    ).toMatchObject({ status: "complete", value: { removed: true } });
    expect(await files.inventory("managed", context, 10)).toMatchObject({
      status: "complete",
      value: { publishedArtifacts: [] },
    });
  } finally {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds inventory and reports historical stages without authorizing their deletion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-history-owned-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "managed",
    operations: ["read", "write"],
  });
  const stageDirectory = ".host-00000000-0000-4000-8000-000000000000";
  const stageId = "00000000-0000-4000-8000-000000000001";
  await mkdir(path.join(directory, stageDirectory));
  await writeFile(
    path.join(directory, stageDirectory, stageId),
    "synthetic-orphan",
  );
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "managed",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ],
  });
  try {
    expect(await files.inventory("managed", context, 10)).toMatchObject({
      status: "complete",
      value: { stagedIds: [stageId] },
    });
    expect(await files.discard(stageId, context)).toMatchObject({
      error: { code: "RESOURCE_UNRESOLVED" },
    });
    expect(await files.inventory("managed", context, 0)).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(await files.inventory("managed", context, 1)).toMatchObject({
      error: { code: "OUTPUT_LIMIT" },
    });
    expect(
      await files.inventory(
        "managed",
        { ...context, projectId: "foreign" },
        10,
      ),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  } finally {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  }
});
