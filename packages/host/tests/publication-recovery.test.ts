import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { ProjectFileSystem } from "../src/filesystem.js";

const fault = vi.hoisted(() => ({ unlinkPath: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (target: Parameters<typeof actual.unlink>[0]) => {
      if (String(target).endsWith(fault.unlinkPath) && fault.unlinkPath) {
        fault.unlinkPath = "";
        throw Object.assign(new Error("synthetic owned unlink failure"), {
          code: "EACCES",
        });
      }
      return actual.unlink(target);
    },
  };
});

it("reports uncertain publication after a real link succeeds and stage unlink fails; retry reconciles only its owned pair", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-publish-owned-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "output",
    operations: ["read", "write"],
  });
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "output",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
  try {
    const staged = await files.stage(
      { artifactRootId: "output", path: "result.bin" },
      Uint8Array.of(42),
      context,
    );
    if (staged.status !== "complete") throw new Error(JSON.stringify(staged));
    fault.unlinkPath = staged.value.stagingId;
    const result = await files.publish(staged.value, context);
    expect(result).toMatchObject({
      status: "interrupted",
      error: { code: "OUTPUT_UNCERTAIN" },
    });
    expect(await readFile(path.join(directory, "result.bin"))).toEqual(
      Buffer.from([42]),
    );
    expect((await lstat(path.join(directory, "result.bin"))).nlink).toBe(2);
    expect(await files.publish(staged.value, context)).toMatchObject({
      status: "complete",
      value: staged.value.artifact,
    });
    expect((await lstat(path.join(directory, "result.bin"))).nlink).toBe(1);
    expect(
      await files.read(
        { artifactRootId: "output", path: "result.bin" },
        context,
      ),
    ).toMatchObject({ status: "complete" });
  } finally {
    fault.unlinkPath = "";
    try {
      await files.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it("post-crash pair recovery requires a trusted reservation and exact hash/inode pair", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-crash-owned-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "output",
    operations: ["read", "write"],
  });
  const stageId = "00000000-0000-4000-8000-000000000001";
  const stageDirectory = ".host-00000000-0000-4000-8000-000000000000";
  const bytes = Uint8Array.of(42);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = {
    id: `sha256_${hash}`,
    path: `blobs/${hash}`,
    sha256: hash,
    byteLength: 1,
    mediaType: "application/octet-stream",
  };
  await mkdir(path.join(directory, "blobs"));
  await mkdir(path.join(directory, stageDirectory));
  const stagePath = path.join(directory, stageDirectory, stageId);
  await writeFile(stagePath, bytes);
  await link(stagePath, path.join(directory, artifact.path));
  let allowed = false;
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "output",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ],
    authorizePublicationRecovery: async () => allowed,
  });
  try {
    expect(
      await files.reconcilePublication("output", artifact, stageId, context),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    allowed = true;
    expect(
      await files.reconcilePublication(
        "output",
        { ...artifact, byteLength: 2 },
        stageId,
        context,
      ),
    ).toMatchObject({ error: { code: "ARTIFACT_INTEGRITY" } });
    expect(
      await files.reconcilePublication("output", artifact, stageId, context),
    ).toMatchObject({ status: "complete", value: artifact });
    expect(
      await files.read(
        { artifactRootId: "output", path: artifact.path },
        context,
      ),
    ).toMatchObject({ status: "complete" });
  } finally {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  }
});
