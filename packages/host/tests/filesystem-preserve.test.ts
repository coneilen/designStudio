import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Outcome } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { ProjectFileSystem } from "../src/filesystem.js";

const seam = vi.hoisted(() => ({
  writeGate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
  failUnlink: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...input: Parameters<typeof write>) => {
        seam.entered?.();
        if (seam.writeGate) await seam.writeGate;
        return write(...input);
      };
      return handle;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (seam.failUnlink)
        throw Object.assign(new Error("Synthetic unlink interruption"), {
          code: "EACCES",
        });
      return actual.unlink(...args);
    },
  };
});
const value = <T>(outcome: Outcome<T>): T => {
  if (outcome.status !== "complete")
    throw new Error("Synthetic filesystem operation failed");
  return outcome.value;
};
async function fixture(
  run: (
    files: ProjectFileSystem,
    root: string,
    context: ReturnType<typeof syntheticContext>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "ds-preserved-stage-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "owned",
    operations: ["read", "write"],
  });
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "owned",
        path: root,
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
  try {
    await run(files, root, context);
  } finally {
    seam.writeGate = undefined;
    seam.entered = undefined;
    seam.failUnlink = false;
    await files.close();
    await rm(root, { recursive: true });
  }
}
it("preserve-close drains original queued writes, refuses late admission, and mixed closes never delete retained bytes", async () => {
  await fixture(async (files, root, context) => {
    let release = () => {};
    let entered = () => {};
    seam.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    seam.entered = entered;
    const staging = files.stage(
      { artifactRootId: "owned", path: "unpublished.bin" },
      Buffer.from("synthetic-retained-bytes"),
      context,
    );
    await writing;
    let closed = false;
    const closing = files.closePreservingStages().then(() => {
      closed = true;
    });
    const late = files.stage(
      { artifactRootId: "owned", path: "late.bin" },
      Buffer.from("must-not-create"),
      context,
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    const staged = value(await staging);
    await closing;
    expect(await late).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN" },
    });
    const directory = (await readdir(root)).find((name) =>
      name.startsWith(".host-"),
    );
    expect(directory).toBeDefined();
    if (!directory) throw new Error("Retained stage directory missing");
    const filename = path.join(root, directory, staged.stagingId);
    const before = await stat(filename);
    await files.closePreservingStages();
    await files.close();
    await files.closePreservingStages();
    expect(await readFile(filename, "utf8")).toBe("synthetic-retained-bytes");
    expect((await stat(filename)).ino).toBe(before.ino);
    expect(await files.publish(staged, context)).toMatchObject({
      status: "failed",
    });
    expect(await files.discard(staged.stagingId, context)).toMatchObject({
      status: "failed",
    });
    expect(
      await files.read(
        { artifactRootId: "owned", path: "unpublished.bin" },
        context,
      ),
    ).toMatchObject({ status: "failed" });
    expect(await readdir(root)).toEqual([directory]);
  });
});
it("failed preserve-close does not erase visible-publication ownership or prohibit exact reconciliation", async () => {
  await fixture(async (files, root, context) => {
    const staged = value(
      await files.stage(
        { artifactRootId: "owned", path: "published.bin" },
        Buffer.from("synthetic-visible"),
        context,
      ),
    );
    seam.failUnlink = true;
    expect(await files.publish(staged, context)).toMatchObject({
      error: { code: "OUTPUT_UNCERTAIN" },
    });
    await expect(files.closePreservingStages()).rejects.toMatchObject({
      code: "OUTPUT_UNCERTAIN",
    });
    seam.failUnlink = false;
    expect(await files.publish(staged, context)).toMatchObject({
      status: "complete",
    });
    await files.closePreservingStages();
    await files.close();
    expect(await readFile(path.join(root, "published.bin"), "utf8")).toBe(
      "synthetic-visible",
    );
  });
});
