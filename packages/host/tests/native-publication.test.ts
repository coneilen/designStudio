import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Artifact, Outcome } from "@design-studio/contracts";
import {
  createFakeClock,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { ProjectFileSystem } from "../src/filesystem.js";

const fault = vi.hoisted(() => ({
  unavailable: false,
  failFlush: 0,
  abortBeforeRename: undefined as (() => void) | undefined,
  afterRename: undefined as (() => void) | undefined,
  handles: 0,
}));
vi.mock("../src/windows-native.js", async (original) => {
  const actual = await original<typeof import("../src/windows-native.js")>();
  return {
    ...actual,
    loadWindowsBindings: async () => {
      if (fault.unavailable) {
        const { HostBoundaryError } = await import("../src/guards.js");
        throw new HostBoundaryError(
          "PROVIDER_UNAVAILABLE",
          "Synthetic optional prebuild missing.",
          true,
        );
      }
      const native = await actual.loadWindowsBindings();
      return {
        ...native,
        open: (...args: Parameters<typeof native.open>) => {
          const handle = native.open(...args);
          fault.handles++;
          return handle;
        },
        close: (handle: Parameters<typeof native.close>[0]) => {
          native.close(handle);
          fault.handles--;
        },
        flush: (handle: Parameters<typeof native.flush>[0]) => {
          if (fault.failFlush > 0 && --fault.failFlush === 0)
            throw new Error("Synthetic owned flush failure");
          native.flush(handle);
          fault.abortBeforeRename?.();
          fault.abortBeforeRename = undefined;
        },
        rename: (...args: Parameters<typeof native.rename>) => {
          native.rename(...args);
          fault.afterRename?.();
          fault.afterRename = undefined;
        },
      };
    },
  };
});

const nativeTest = process.platform === "win32" ? it : it.skip;
function value<T>(result: Outcome<T>): T {
  if (result.status !== "complete") throw new Error(JSON.stringify(result));
  return result.value;
}
async function arrange() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "studio-native-profile-owned-\u03bb-"),
  );
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "output",
    operations: ["read", "write"],
  });
  const trustedAuthorization = context.authorization;
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: (authorization) => authorization === trustedAuthorization,
    publicationProfile: "windows-ntfs-write-through-v1",
    roots: [
      {
        id: "output",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
  return { directory, context, files };
}
async function cleanup(files: ProjectFileSystem, directory: string) {
  fault.unavailable = false;
  fault.failFlush = 0;
  fault.abortBeforeRename = undefined;
  fault.afterRename = undefined;
  try {
    await files.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

nativeTest(
  "native profile issues reverified identity/hash/profile evidence, never an unverified boolean",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      const staged = value(
        await files.stage(
          { artifactRootId: "output", path: "result space.bin" },
          Uint8Array.of(0, 255, 10),
          context,
        ),
      );

      const artifact = value(await files.publish(staged, context));
      expect(
        await files.ensurePublicationDurable("output", [artifact], context),
      ).toMatchObject({
        status: "complete",
        value: { durable: true, profile: "windows-ntfs-write-through-v1" },
      });
      expect(
        value(
          await files.read(
            { artifactRootId: "output", path: artifact.path },
            context,
          ),
        ),
      ).toEqual(Uint8Array.of(0, 255, 10));
      expect(
        await files.ensurePublicationDurable(
          "output",
          [{ ...artifact, sha256: "0".repeat(64) }],
          context,
        ),
      ).toMatchObject({ error: { code: "ARTIFACT_INTEGRITY" } });
      await unlink(path.join(directory, artifact.path));
      await writeFile(
        path.join(directory, artifact.path),
        Uint8Array.of(0, 255, 10),
      );
      expect(
        await files.ensurePublicationDurable("output", [artifact], context),
      ).toMatchObject({ status: "failed" });
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, directory);
    }
  },
);

nativeTest(
  "publishes and verifies owned long native paths without relaxing namespace or identity checks",
  async () => {
    const temporary = await mkdtemp(
      path.join(tmpdir(), "studio-long-native-owned-"),
    );
    const root = path.join(
      temporary,
      "catalog-".padEnd(70, "a"),
      "project-".padEnd(70, "b"),
      "binding-".padEnd(70, "c"),
    );
    await mkdir(root, { recursive: true });
    expect(root.length).toBeGreaterThan(260);
    const context = syntheticContext();
    context.authorization.grants.push({
      resourceKind: "artifact",
      resourceId: "long-root",
      operations: ["read", "write"],
    });
    const files = await ProjectFileSystem.create({
      projectId: context.projectId,
      authority: (authorization) => authorization === context.authorization,
      publicationProfile: "windows-ntfs-write-through-v1",
      roots: [
        {
          id: "long-root",
          path: root,
          access: "read-write",
          trustedExclusiveAccess: true,
        },
      ],
    });
    try {
      const request = {
        artifactRootId: "long-root",
        path: `blobs/${"a".repeat(64)}`,
      };
      const bytes = Uint8Array.of(0, 255, 13, 10);
      const staged = value(await files.stage(request, bytes, context));
      const artifact = value(await files.publish(staged, context));
      expect(artifact.path).toBe(request.path);
      expect(value(await files.read(request, context))).toEqual(bytes);
      expect(
        await files.ensurePublicationDurable("long-root", [artifact], context),
      ).toMatchObject({
        status: "complete",
        value: { durable: true, profile: "windows-ntfs-write-through-v1" },
      });
      const duplicate = value(
        await files.stage(request, Uint8Array.of(7), context),
      );
      expect(await files.publish(duplicate, context)).toMatchObject({
        error: { code: "CONFLICT" },
      });
      expect(value(await files.read(request, context))).toEqual(bytes);
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, temporary);
    }
  },
);

nativeTest(
  "post-rename flush failure is interrupted and own retry verifies and flushes the committed identity",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      const staged = value(
        await files.stage(
          { artifactRootId: "output", path: "recovery.bin" },
          Uint8Array.of(42),
          context,
        ),
      );
      fault.failFlush = 2;
      expect(await files.publish(staged, context)).toMatchObject({
        status: "interrupted",
        error: { code: "OUTPUT_UNCERTAIN" },
      });
      expect(await readFile(path.join(directory, "recovery.bin"))).toEqual(
        Buffer.from([42]),
      );
      expect(
        await files.ensurePublicationDurable(
          "output",
          [staged.artifact],
          context,
        ),
      ).toMatchObject({ status: "unavailable" });
      await expect(files.close()).rejects.toMatchObject({
        code: "OUTPUT_UNCERTAIN",
      });
      const artifact = value(await files.publish(staged, context));
      expect(
        await files.ensurePublicationDurable("output", [artifact], context),
      ).toMatchObject({ status: "complete" });
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, directory);
    }
  },
);

nativeTest(
  "cancellation before rename preserves staging; a completed native mutation wins a later deadline",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      const controller = new AbortController();
      const cancelledContext = { ...context, signal: controller.signal };
      const stage = value(
        await files.stage(
          { artifactRootId: "output", path: "cancel.bin" },
          Uint8Array.of(1),
          context,
        ),
      );
      fault.abortBeforeRename = () => controller.abort();
      expect(await files.publish(stage, cancelledContext)).toMatchObject({
        status: "cancelled",
      });
      expect(await files.discard(stage.stagingId, context)).toMatchObject({
        status: "complete",
      });
      const clock = createFakeClock(Date.now());
      const timedContext = {
        ...context,
        clock,
        budget: { ...context.budget, maxDurationMs: 5 },
      };
      const committed = value(
        await files.stage(
          { artifactRootId: "output", path: "commit.bin" },
          Uint8Array.of(2),
          timedContext,
        ),
      );
      fault.afterRename = () => clock.advance(5);
      expect(await files.publish(committed, timedContext)).toMatchObject({
        status: "complete",
      });
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, directory);
    }
  },
);

nativeTest(
  "generic or reconstructed publication metadata never obtains native evidence",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      const bytes = Uint8Array.of(9);
      await writeFile(path.join(directory, "unverified.bin"), bytes);
      const artifact: Artifact = {
        id: "unverified",
        path: "unverified.bin",
        mediaType: "application/octet-stream",
        byteLength: 1,
        sha256: "0".repeat(64),
      };
      expect(
        await files.ensurePublicationDurable("output", [artifact], context),
      ).toMatchObject({ status: "unavailable" });
      const staged = value(
        await files.stage(
          { artifactRootId: "output", path: "verified.bin" },
          bytes,
          context,
        ),
      );
      const verified = value(await files.publish(staged, context));
      const requested = [verified, artifact];
      const checking = files.ensurePublicationDurable(
        "output",
        requested,
        context,
      );
      requested.pop();
      expect(await checking).toMatchObject({ status: "unavailable" });
    } finally {
      await cleanup(files, directory);
    }
  },
);

nativeTest(
  "production native conflicts preserve the existing destination and its original evidence",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      const first = value(
        await files.stage(
          { artifactRootId: "output", path: "existing.bin" },
          Uint8Array.of(1),
          context,
        ),
      );
      const second = value(
        await files.stage(
          { artifactRootId: "output", path: "existing.bin" },
          Uint8Array.of(2),
          context,
        ),
      );
      const artifact = value(await files.publish(first, context));
      expect(await files.publish(second, context)).toMatchObject({
        error: { code: "CONFLICT" },
      });
      expect(await readFile(path.join(directory, "existing.bin"))).toEqual(
        Buffer.from([1]),
      );
      expect(
        await files.ensurePublicationDurable("output", [artifact], context),
      ).toMatchObject({ status: "complete" });
      expect(await files.discard(second.stagingId, context)).toMatchObject({
        status: "complete",
      });
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, directory);
    }
  },
);

nativeTest(
  "missing optional native binding does not disable unrelated reads or silently fall back",
  async () => {
    const { files, context, directory } = await arrange();
    try {
      await writeFile(path.join(directory, "input.bin"), Uint8Array.of(7));
      const staged = value(
        await files.stage(
          { artifactRootId: "output", path: "unavailable.bin" },
          Uint8Array.of(7),
          context,
        ),
      );
      fault.unavailable = true;
      expect(await files.publish(staged, context)).toMatchObject({
        status: "unavailable",
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(
        value(
          await files.read(
            { artifactRootId: "output", path: "input.bin" },
            context,
          ),
        ),
      ).toEqual(Uint8Array.of(7));
      expect(fault.handles).toBe(0);
    } finally {
      await cleanup(files, directory);
    }
  },
);
