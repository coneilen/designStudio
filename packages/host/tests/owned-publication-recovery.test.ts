import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthorizationContext, Outcome } from "@design-studio/contracts";
import {
  createFakeClock,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import {
  type OwnedPendingPublication,
  ProjectFileSystem,
} from "../src/filesystem.js";
import { HostBoundaryError } from "../src/guards.js";
import {
  NativePublicationInterrupted,
  WindowsNtfsPublisher,
} from "../src/windows-publication.js";

const pairFault = vi.hoisted(() => ({
  denyUnlink: false,
  afterUnlink: undefined as (() => void) | undefined,
  captureReads: false,
  reads: [] as Uint8Array[],
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read;
      Object.defineProperty(handle, "read", {
        value: async (...input: unknown[]) => {
          const result: unknown = await Reflect.apply(read, handle, input);
          const bytes = input[0];
          if (
            pairFault.captureReads &&
            bytes instanceof Uint8Array &&
            bytes.byteLength > 1
          ) {
            pairFault.reads.push(bytes);
            pairFault.afterRead?.();
          }
          return result;
        },
      });
      return handle;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (pairFault.denyUnlink)
        throw Object.assign(new Error("Synthetic unlink fault"), {
          code: "EACCES",
        });
      await actual.unlink(...args);
      pairFault.afterUnlink?.();
      pairFault.afterUnlink = undefined;
    },
  };
});

const value = <T>(outcome: Outcome<T>): T => {
  if (outcome.status !== "complete")
    throw new Error("Synthetic owned publication failed");
  return outcome.value;
};
it.each(["match", "integrity", "revoked-read"] as const)(
  "retains observed unlink progress and zeros owned recovery bytes: %s",
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "ds-owned-pair-"));
    const trusted = new Set<AuthorizationContext>();
    const grants = new WeakMap<AuthorizationContext, OwnedPendingPublication>();
    const context = () => {
      const ctx = syntheticContext({
        jobId: "pair_job",
        requestId: "pair_request",
      });
      ctx.authorization.sessionId = `pair_${trusted.size}`;
      ctx.authorization.grants.push({
        resourceKind: "artifact",
        resourceId: "owned",
        operations: ["read", "write"],
      });
      trusted.add(ctx.authorization);
      return ctx;
    };
    const files = await ProjectFileSystem.create({
      projectId: "project_synthetic",
      authority: (authorization) => trusted.has(authorization),
      roots: [
        {
          id: "owned",
          path: root,
          access: "read-write",
          trustedExclusiveAccess: true,
        },
      ],
      authorizeOwnedPublicationRecovery: async (pending, ctx) => {
        if (grants.get(ctx.authorization) !== pending)
          throw new HostBoundaryError(
            "FORBIDDEN",
            "Missing pair cleanup admission",
          );
      },
    });
    let pending: OwnedPendingPublication | undefined;
    try {
      const original = context();
      const staged = value(
        await files.stage(
          { artifactRootId: "owned", path: "pair.bin" },
          Uint8Array.of(1, 2, 3),
          original,
        ),
      );
      pairFault.denyUnlink = true;
      expect(await files.publish(staged, original)).toMatchObject({
        error: { code: "OUTPUT_UNCERTAIN" },
      });
      pending = files.retainPendingPublication(staged, original);
      pairFault.denyUnlink = false;
      const revoked = context();
      grants.set(revoked.authorization, pending);
      pairFault.afterUnlink = () => trusted.delete(revoked.authorization);
      expect(
        await files.reconcileOwnedPublication(pending, revoked),
      ).toMatchObject({ error: { code: "OUTPUT_UNCERTAIN" } });
      await expect(files.closePreservingStages()).rejects.toMatchObject({
        code: "OUTPUT_UNCERTAIN",
      });
      const fresh = context();
      grants.set(fresh.authorization, pending);
      pairFault.denyUnlink = true;
      if (mode === "integrity")
        await writeFile(path.join(root, "pair.bin"), Buffer.from([4, 5, 6]));
      pairFault.reads = [];
      pairFault.captureReads = true;
      if (mode === "revoked-read")
        pairFault.afterRead = () => trusted.delete(fresh.authorization);
      const result = await files.reconcileOwnedPublication(pending, fresh);
      expect(result).toMatchObject(
        mode === "match"
          ? { status: "complete" }
          : { error: { code: "OUTPUT_UNCERTAIN" } },
      );
      expect(pairFault.reads.length).toBeGreaterThan(0);
      expect(
        pairFault.reads.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
      expect(await readFile(path.join(root, "pair.bin"))).toEqual(
        Buffer.from(mode === "integrity" ? [4, 5, 6] : [1, 2, 3]),
      );
    } finally {
      pairFault.captureReads = false;
      pairFault.afterRead = undefined;
      for (const bytes of pairFault.reads) bytes.fill(0);
      pairFault.reads = [];
      pairFault.denyUnlink = false;
      pairFault.afterUnlink = undefined;
      await writeFile(path.join(root, "pair.bin"), Buffer.from([1, 2, 3]));
      if (pending) {
        const last = context();
        grants.set(last.authorization, pending);
        await files.reconcileOwnedPublication(pending, last);
      }
      await files.closePreservingStages();
      await rm(root, { recursive: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "requires exact retained identity and fresh narrow authority, without reviving expired work",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ds-owned-publication-"));
    const clock = createFakeClock(Date.now());
    const trusted = new Set<AuthorizationContext>();
    const proof = new WeakMap<AuthorizationContext, OwnedPendingPublication>();
    const context = () => {
      const ctx = syntheticContext({
        clock,
        jobId: "publication_job",
        requestId: "publication_request",
      });

      ctx.deadline = new Date(clock.now() + 30000).toISOString();
      ctx.authorization.expiresAt = ctx.deadline;
      ctx.authorization.sessionId = `session_${trusted.size}`;
      ctx.authorization.grants.push({
        resourceKind: "artifact",
        resourceId: "owned",
        operations: ["read", "write"],
      });
      trusted.add(ctx.authorization);
      return ctx;
    };
    let authorizationGate: Promise<void> | undefined;
    let enteredAuthorization: (() => void) | undefined;
    const files = await ProjectFileSystem.create({
      projectId: "project_synthetic",
      authority: (authorization) => trusted.has(authorization),
      publicationProfile: "windows-ntfs-write-through-v1",
      roots: [
        {
          id: "owned",
          path: root,
          access: "read-write",
          trustedExclusiveAccess: true,
        },
      ],
      authorizeOwnedPublicationRecovery: async (pending, ctx) => {
        if (proof.get(ctx.authorization) !== pending)
          throw new HostBoundaryError(
            "FORBIDDEN",
            "No exact test recovery authority",
          );
        enteredAuthorization?.();
        if (authorizationGate) await authorizationGate;
      },
    });
    const publish = WindowsNtfsPublisher.prototype.publish;
    const publishing = vi
      .spyOn(WindowsNtfsPublisher.prototype, "publish")
      .mockImplementation(async function (this: WindowsNtfsPublisher, ...args) {
        const observed = await publish.apply(this, args);
        throw new NativePublicationInterrupted(observed.identity, {
          cause: new Error("Synthetic post-rename failure"),
        });
      });
    let pending: OwnedPendingPublication | undefined;
    try {
      const original = context();
      const staged = value(
        await files.stage(
          { artifactRootId: "owned", path: "visible.bin" },
          Buffer.from("synthetic-owned"),
          original,
        ),
      );
      expect(() => files.retainPendingPublication(staged, original)).toThrow();
      expect(await files.publish(staged, original)).toMatchObject({
        error: { code: "OUTPUT_UNCERTAIN" },
      });
      pending = files.retainPendingPublication(staged, original);
      for (const changed of [
        { ...staged, stagingId: "foreign" },
        { ...staged, artifact: { ...staged.artifact, path: "other.bin" } },
        { ...staged, artifact: { ...staged.artifact, sha256: "0".repeat(64) } },
      ])
        expect(() =>
          files.retainPendingPublication(changed, original),
        ).toThrow();
      expect(() =>
        files.retainPendingPublication(staged, {
          ...original,
          authorization: { ...original.authorization },
        }),
      ).toThrow();
      clock.advance(60001);
      expect(await files.publish(staged, original)).not.toMatchObject({
        status: "complete",
      });
      const fresh = context();
      expect(
        await files.reconcileOwnedPublication(pending, fresh),
      ).toMatchObject({ error: { code: "FORBIDDEN" } });
      proof.set(fresh.authorization, pending);
      const foreignRoot = await mkdtemp(
        path.join(tmpdir(), "ds-foreign-publication-"),
      );
      const foreign = await ProjectFileSystem.create({
        projectId: "project_synthetic",
        authority: () => true,
        roots: [
          {
            id: "owned",
            path: foreignRoot,
            access: "read-write",
            trustedExclusiveAccess: true,
          },
        ],
        authorizeOwnedPublicationRecovery: async () => {},
      });
      try {
        expect(
          await foreign.reconcileOwnedPublication(pending, fresh),
        ).toMatchObject({ error: { code: "FORBIDDEN" } });
      } finally {
        await foreign.close();
        await rm(foreignRoot, { recursive: true });
      }
      for (const forged of [
        { ...pending },
        { ...pending, stagingId: "foreign" },
        { ...pending, artifactRootId: "foreign" },
        { ...pending, artifact: { ...pending.artifact, path: "other.bin" } },
        {
          ...pending,
          artifact: { ...pending.artifact, sha256: "0".repeat(64) },
        },
      ])
        expect(
          await files.reconcileOwnedPublication(forged, fresh),
        ).toMatchObject({ error: { code: "FORBIDDEN" } });
      for (const changed of [
        { ...fresh, projectId: "foreign" },
        { ...fresh, requestId: "foreign" },
        { ...fresh, jobId: "foreign" },
        {
          ...fresh,
          authorization: { ...fresh.authorization, actorId: "foreign" },
        },
        { ...fresh, authorization: { ...fresh.authorization } },
      ])
        expect(
          await files.reconcileOwnedPublication(pending, changed),
        ).not.toMatchObject({ status: "complete" });
      const filename = path.join(root, "visible.bin");
      pairFault.captureReads = true;
      pairFault.reads = [];
      await writeFile(filename, Buffer.from("synthetic-owneX"));
      expect(
        await files.reconcileOwnedPublication(pending, fresh),
      ).toMatchObject({ error: { code: "OUTPUT_UNCERTAIN" } });
      expect(pairFault.reads.length).toBeGreaterThan(0);
      expect(
        pairFault.reads.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
      await writeFile(filename, Buffer.from("synthetic-owned"));
      let release = () => {};
      let entered = () => {};
      authorizationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorizing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      enteredAuthorization = entered;
      const denied = files.reconcileOwnedPublication(pending, fresh);
      await authorizing;
      trusted.delete(fresh.authorization);
      release();
      expect(await denied).not.toMatchObject({ status: "complete" });
      authorizationGate = undefined;
      enteredAuthorization = undefined;
      const retry = context();
      proof.set(retry.authorization, pending);
      const resume = WindowsNtfsPublisher.prototype.resume;
      const fault = vi
        .spyOn(WindowsNtfsPublisher.prototype, "resume")
        .mockImplementationOnce(async function (
          this: WindowsNtfsPublisher,
          ...args
        ) {
          await resume.apply(this, args);
          throw new Error("Synthetic barrier acknowledgement fault");
        });
      try {
        expect(
          await files.reconcileOwnedPublication(pending, retry),
        ).toMatchObject({ error: { code: "OUTPUT_UNCERTAIN" } });
        await expect(files.closePreservingStages()).rejects.toMatchObject({
          code: "OUTPUT_UNCERTAIN",
        });
      } finally {
        fault.mockRestore();
      }
      let releaseBarrier = () => {};
      let reached = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const atBarrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const delayed = vi
        .spyOn(WindowsNtfsPublisher.prototype, "resume")
        .mockImplementationOnce(async function (
          this: WindowsNtfsPublisher,
          ...args
        ) {
          const observed = await resume.apply(this, args);
          reached();
          await barrier;
          return observed;
        });
      try {
        const cleaning = files.reconcileOwnedPublication(pending, retry);
        await atBarrier;
        expect(() =>
          files.retainPendingPublication(staged, original),
        ).toThrow();
        expect(
          await files.reconcileOwnedPublication(pending, retry),
        ).toMatchObject({ error: { code: "CONFLICT" } });
        trusted.delete(retry.authorization);
        releaseBarrier();
        expect(await cleaning).toMatchObject({
          error: { code: "OUTPUT_UNCERTAIN" },
        });
      } finally {
        releaseBarrier();
        delayed.mockRestore();
      }
      const last = context();
      proof.set(last.authorization, pending);
      expect(
        await files.reconcileOwnedPublication(pending, last),
      ).toMatchObject({ status: "complete" });
      expect(
        pairFault.reads.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
      await files.closePreservingStages();
      await files.close();
      expect(await readFile(filename, "utf8")).toBe("synthetic-owned");
    } finally {
      pairFault.captureReads = false;
      for (const bytes of pairFault.reads) bytes.fill(0);
      pairFault.reads = [];
      publishing.mockRestore();
      authorizationGate = undefined;
      enteredAuthorization = undefined;
      if (pending) {
        const cleanup = context();
        proof.set(cleanup.authorization, pending);
        await files.reconcileOwnedPublication(pending, cleanup);
      }
      await files.closePreservingStages();
      await rm(root, { recursive: true });
    }
  },
);
