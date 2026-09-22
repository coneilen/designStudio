import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type Artifact,
  DEFAULT_BUDGETS,
  type FileSystemBoundary,
  type OperationContext,
  type Outcome,
  type Revision,
} from "@design-studio/contracts";
import { storageTestSignal } from "./lifetime.js";

export const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const bytes = (text: string) => new TextEncoder().encode(text);
export function context(id = "request1"): OperationContext {
  return {
    schemaVersion: "1.0",
    projectId: "project1",
    requestId: id,
    jobId: `job-${id}`,
    deadline: "2026-09-17T00:00:30.000Z",
    budget: { ...DEFAULT_BUDGETS },
    authorization: {
      schemaVersion: "1.0",
      projectId: "project1",
      actorId: "actor1",
      sessionId: "session1",
      expiresAt: "2026-09-17T01:00:00.000Z",
      egress: "deny",
      grants: [],
    },
    clock: {
      now: () => Date.parse("2026-09-17T00:00:00.000Z"),
      sleep: async () => {},
    },
    signal: storageTestSignal(),
  };
}
export function complete<T>(value: T, ctx: OperationContext): Outcome<T> {
  return {
    schemaVersion: "1.0",
    projectId: ctx.projectId,
    requestId: ctx.requestId,
    status: "complete",
    diagnosticIds: [],
    value,
  };
}

// Test-only real-disk adapter. Not a production containment/authorization boundary.
export async function diskFixture(root: string) {
  await mkdir(join(root, "blobs"), { recursive: true });
  await mkdir(join(root, "staged"), { recursive: true });
  let sequence = 0;
  const instance = randomUUID();
  let fault: "stage" | "publish" | undefined;
  const fs: FileSystemBoundary = {
    async read(request, ctx) {
      return complete(
        new Uint8Array(await readFile(join(root, ...request.path.split("/")))),
        ctx,
      );
    },
    async stage(request, value, ctx) {
      const stagingId = `staged-${instance}-${++sequence}`;
      const artifact: Artifact = {
        id: `blob-${hash(value)}`,
        path: request.path,
        byteLength: value.length,
        sha256: hash(value),
        mediaType: "application/octet-stream",
      };
      await writeFile(join(root, "staged", stagingId), value);
      if (fault === "stage") throw new Error("fault-stage");
      return complete({ stagingId, artifact }, ctx);
    },
    async publish(staged, ctx) {
      const target = join(root, ...staged.artifact.path.split("/"));
      try {
        const present = await readFile(target);
        if (hash(present) !== staged.artifact.sha256)
          throw new Error("immutable-target-corrupt");
        await rm(join(root, "staged", staged.stagingId), { force: true });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        await rename(join(root, "staged", staged.stagingId), target);
      }
      if (fault === "publish") throw new Error("fault-publish");
      return complete(staged.artifact, ctx);
    },
    async discard(id, ctx) {
      await rm(join(root, "staged", id), { force: true });
      return complete({ discarded: true }, ctx);
    },
  };
  return {
    fs,
    root,
    setFault(value: typeof fault) {
      fault = value;
    },
    maintenance: {
      async inventory() {
        const publishedArtifacts: Artifact[] = [];
        for (const name of await readdir(join(root, "blobs"))) {
          const content = await readFile(join(root, "blobs", name));
          publishedArtifacts.push({
            id: `blob-${name}`,
            sha256: name,
            path: `blobs/${name}`,
            byteLength: content.length,
            mediaType: "application/octet-stream",
          });
        }
        return {
          stagedIds: await readdir(join(root, "staged")),
          publishedArtifacts,
        };
      },
      async removeBlob(artifact: Artifact, _context: OperationContext) {
        const path = join(root, ...artifact.path.split("/"));
        const content = await readFile(path);
        if (
          content.length !== artifact.byteLength ||
          hash(content) !== artifact.sha256
        )
          throw new Error("removal-integrity");
        await rm(path);
      },
    },
  };
}
export function revision(
  id: string,
  artifacts: Artifact[],
  parents: Revision["parents"] = [],
): Revision {
  const content = artifacts[0];
  const provenance = artifacts[1];
  const resources = artifacts[2];
  if (!content || !provenance || !resources)
    throw new Error("fixture requires three artifacts");
  return {
    schemaVersion: "1.0",
    id,
    projectId: "project1",
    designId: "design1",
    parents,
    content: { id: content.id, sha256: content.sha256 },
    provenance: { id: provenance.id, sha256: provenance.sha256 },
    resources: {
      snapshotId: resources.id,
      sha256: resources.sha256,
      componentRegistryRevision: "v1",
      tokenRegistryRevision: "v1",
      selectedModes: {},
    },
    createdAt: "2026-09-17T00:00:00.000Z",
    actorId: "actor1",
    changeSource: "manual",
  };
}
