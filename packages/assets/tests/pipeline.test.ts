import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileSystemBoundary,
  OperationContext,
  ResourceSnapshot,
} from "@design-studio/contracts";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AssetPipeline,
  cacheIdentity,
  type ImageInput,
  sha256,
} from "../src/index.js";

const root = new URL("../../../tests/fixtures/foundation/", import.meta.url);
const resources: ResourceSnapshot = JSON.parse(
  readFileSync(new URL("resources.json", root), "utf8"),
);
const fixtureAsset = resources.assets[0];
if (!fixtureAsset) throw new Error("Pinned fixture asset is required");
const asset = fixtureAsset;
const bytes = readFileSync(new URL("assets/stripes.png", root));
const notice = readFileSync(new URL("LICENSE.txt", root));
function context(projectId = "p"): OperationContext {
  return {
    schemaVersion: "1.0",
    projectId,
    requestId: "r",
    deadline: "2030-01-01T00:00:00Z",
    budget: { ...DEFAULT_BUDGETS },
    authorization: {
      schemaVersion: "1.0",
      projectId,
      actorId: "a",
      sessionId: "s",
      expiresAt: "2030-01-01T00:00:00Z",
      grants: [],
      egress: "deny",
    },
    clock: {
      now: () => Date.parse("2026-09-16T00:00:00Z"),
      sleep: async () => {},
    },
    signal: new AbortController().signal,
  };
}
function image(): ImageInput {
  return {
    kind: "image",
    id: "stripes",
    bytes,
    license: asset.license,
    notice,
    source: asset.source,
    usageNodeIds: ["image"],
  };
}
function arrange() {
  const staged = new Map<string, Buffer>();
  const fs: FileSystemBoundary = {
    stage: vi.fn<FileSystemBoundary["stage"]>(async (request, content, ctx) => {
      staged.set(request.path, Buffer.from(content));
      return {
        schemaVersion: "1.0",
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        status: "complete",
        value: {
          stagingId: `stage${staged.size}`,
          artifact: {
            id: `artifact${staged.size}`,
            path: request.path,
            mediaType: "application/octet-stream",
            sha256: sha256(content),
            byteLength: content.length,
          },
        },
        diagnosticIds: [],
      };
    }),
    read: vi.fn<FileSystemBoundary["read"]>(async (request, ctx) => {
      const content = staged.get(request.path);
      if (!content) throw new Error("missing fixture");
      return {
        schemaVersion: "1.0",
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        status: "complete",
        value: Buffer.from(content),
        diagnosticIds: [],
      };
    }),
    publish: vi.fn(async () => {
      throw new Error("not F05");
    }),
    discard: vi.fn(async () => {
      throw new Error("not F05");
    }),
  };
  const authorize = vi.fn(async () => ({
    permissionScope: "permitted-v1",
    offlineAllowed: true,
  }));
  return {
    fs,
    staged,
    authorize,
    pipeline: new AssetPipeline({
      filesystem: fs,
      authorize,
      rightsAuthority: () => true,
    }),
  };
}
describe("scoped immutable staging without publication or DB ownership", () => {
  it("checks cache lookup elapsed time before opening a file", async () => {
    const { pipeline, fs } = arrange();
    const ctx = context();
    let now = ctx.clock.now();
    ctx.clock.now = () => now;
    ctx.budget.maxDurationMs = 1;
    await expect(
      pipeline.readCached(
        {
          artifactRootId: "root",
          sourceSha256: sha256(bytes),
          dependencyHashes: [],
          derivativeVersion: "1",
        },
        "offline",
        ctx,
        async (key) => {
          now += 2;
          return {
            key,
            projectId: "p",
            permissionScope: "permitted-v1",
            artifact: asset.artifact,
          };
        },
      ),
    ).rejects.toThrow(/DURATION/);
    expect(fs.read).not.toHaveBeenCalled();
  });
  it("retains a partial boundary receipt without claiming snapshot completion", async () => {
    const { pipeline, fs } = arrange();
    const original = fs.stage;
    fs.stage = async (...args) => {
      const complete = await original(...args);
      if (complete.status !== "complete")
        throw new Error("Expected test stage");
      return {
        ...complete,
        status: "partial",
        missing: ["durability"],
        error: {
          code: "INVALID_INPUT",
          message: "Incomplete test stage",
          retryable: false,
          diagnosticIds: [],
        },
      };
    };
    await expect(
      pipeline.stageSnapshot("root", [image()], context()),
    ).rejects.toMatchObject({
      boundaryStatus: "partial",
      staged: [expect.objectContaining({ stagingId: "stage1" })],
    });
  });
  it("rejects cache output over caller budget before reading bytes", async () => {
    const { pipeline, fs } = arrange();
    const ctx = context();
    ctx.budget.maxOutputBytes = bytes.length - 1;
    await expect(
      pipeline.readCached(
        {
          artifactRootId: "root",
          sourceSha256: sha256(bytes),
          dependencyHashes: [],
          derivativeVersion: "1",
        },
        "offline",
        ctx,
        async (key) => ({
          key,
          projectId: "p",
          permissionScope: "permitted-v1",
          artifact: asset.artifact,
        }),
      ),
    ).rejects.toThrow(/OUTPUT_BYTES/);
    expect(fs.read).not.toHaveBeenCalled();
  });
  it("bounds aggregate operation output independently of per-file and snapshot limits", async () => {
    const { pipeline, fs } = arrange();
    const ctx = context();
    ctx.budget.maxOutputBytes = 80_000;
    const largeNotice = Buffer.alloc(79_600, "a");
    const request = image();
    request.notice = largeNotice;
    request.license = {
      ...request.license,
      notice: {
        ...request.license.notice,
        byteLength: largeNotice.length,
        sha256: sha256(largeNotice),
      },
    };
    await expect(
      pipeline.stageSnapshot("root", [request], ctx),
    ).rejects.toThrow(/OPERATION_OUTPUT_BYTES/);
    expect(fs.stage).not.toHaveBeenCalled();
  });
  it("enforces elapsed caller duration before any write", async () => {
    const { fs, authorize } = arrange();
    const ctx = context();
    let elapsed = 0;
    const initial = ctx.clock.now();
    ctx.clock.now = () => initial + elapsed;
    ctx.budget.maxDurationMs = 5;
    const pipeline = new AssetPipeline({
      filesystem: fs,
      authorize,
      rightsAuthority: () => {
        elapsed += 10;
        return true;
      },
    });
    await expect(
      pipeline.stageSnapshot("root", [image()], ctx),
    ).rejects.toThrow(/DURATION/);
    expect(fs.stage).not.toHaveBeenCalled();
  });
  it("retains completed receipts on cancellation between stages", async () => {
    const { pipeline, fs } = arrange();
    const original = fs.stage;
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    fs.stage = async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    };
    await expect(
      pipeline.stageSnapshot("root", [image()], ctx),
    ).rejects.toMatchObject({
      diagnostic: { code: "STAGING_FAILED" },
      boundaryStatus: "CANCELLED",
      staged: [expect.objectContaining({ stagingId: "stage1" })],
    });
    expect(fs.discard).not.toHaveBeenCalled();
  });
  it("deduplicates same bytes in one permitted snapshot, retains metadata and never publishes", async () => {
    const { pipeline, fs } = arrange();
    const result = await pipeline.stageSnapshot(
      "root",
      [image(), { ...image(), id: "second", usageNodeIds: ["second"] }],
      context(),
    );
    expect(result.staged).toHaveLength(2);
    expect(result.images).toHaveLength(2);
    expect(result.images[0]?.resource.artifact.sha256).toBe(sha256(bytes));
    expect(result.images[0]?.mediaType).toBe("image/png");
    expect(result.images[0]?.resource.artifact.mediaType).toBe(
      "application/octet-stream",
    );
    expect(fs.publish).not.toHaveBeenCalled();
    expect(fs.discard).not.toHaveBeenCalled();
  });
  it("stages original SVG and separately hashed safe derivative", async () => {
    const { pipeline } = arrange();
    const vector = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#123456"/></svg>',
    );
    const result = await pipeline.stageSnapshot(
      "root",
      [{ ...image(), bytes: vector }],
      context(),
    );
    expect(result.staged).toHaveLength(3);
    expect(result.images[0]?.resource.derivativeOf?.sha256).toBe(
      sha256(vector),
    );
    expect(result.images[0]?.resource.artifact.sha256).not.toBe(sha256(vector));
  });
  it.each([-1, 0, 1])(
    "checks unique total snapshot byte boundary %i before writing",
    async (offset) => {
      const { pipeline, fs } = arrange();
      const ctx = context();
      ctx.budget.maxSnapshotAssetBytes = bytes.length + notice.length + offset;
      const run = pipeline.stageSnapshot("root", [image()], ctx);
      if (offset < 0) {
        await expect(run).rejects.toThrow(/SNAPSHOT_BYTES/);
        expect(fs.stage).not.toHaveBeenCalled();
      } else expect((await run).totalBytes).toBe(bytes.length + notice.length);
    },
  );
  it("separates project and permission identities and denies before any lookup/write", async () => {
    const { pipeline, authorize, fs } = arrange();
    const a = await pipeline.stageSnapshot("rootA", [image()], context("a"));
    const b = await pipeline.stageSnapshot("rootB", [image()], context("b"));
    expect(a.staged[0]?.artifact.path).toBe(`blobs/${sha256(bytes)}`);
    expect(b.staged[0]?.artifact.path).toBe(a.staged[0]?.artifact.path);
    expect(fs.stage).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(fs.stage).mock.calls.map(([request]) => request.artifactRootId),
    ).toEqual(["rootA", "rootA", "rootB", "rootB"]);
    authorize.mockResolvedValue({
      permissionScope: "permitted-v2",
      offlineAllowed: true,
    });
    const c = await pipeline.stageSnapshot("rootA", [image()], context("a"));
    expect(c.permissionScope).not.toBe(a.permissionScope);
    expect(fs.stage).toHaveBeenCalledTimes(6);
    authorize.mockRejectedValue(new Error("denied by trusted host"));
    const count = vi.mocked(fs.stage).mock.calls.length;
    await expect(
      pipeline.stageSnapshot("root", [image()], context()),
    ).rejects.toThrow("denied by trusted host");
    expect(vi.mocked(fs.stage).mock.calls.length).toBe(count);
  });
  it("cache identity includes dependencies/version/project/permission, never delivery URL", () => {
    const identity = {
      projectId: "p",
      artifactRootId: "root",
      permissionScope: "s",
      sourceSha256: sha256(bytes),
      dependencyHashes: [sha256(notice)],
      adapterVersion: "1",
      schemaVersion: "1.0",
      derivativeVersion: "1",
    };
    expect(cacheIdentity(identity)).toBe(
      cacheIdentity({
        ...identity,
        dependencyHashes: [...identity.dependencyHashes],
      }),
    );
    for (const key of [
      "projectId",
      "artifactRootId",
      "permissionScope",
      "sourceSha256",
      "adapterVersion",
      "schemaVersion",
      "derivativeVersion",
    ] as const) {
      expect(
        cacheIdentity({
          ...identity,
          [key]: key === "sourceSha256" ? sha256("other") : "changed",
        }),
      ).not.toBe(cacheIdentity(identity));
    }
    expect(cacheIdentity({ ...identity, dependencyHashes: [] })).not.toBe(
      cacheIdentity(identity),
    );
  });
  it("distinguishes missing cache, offline permission and expired current auth", async () => {
    const { pipeline, authorize } = arrange();
    const lookup = vi.fn(async () => undefined);
    const request = {
      artifactRootId: "root",
      sourceSha256: sha256(bytes),
      dependencyHashes: [sha256(notice)],
      derivativeVersion: "1",
    };
    await expect(
      pipeline.readCached(request, "offline", context(), lookup),
    ).rejects.toThrow(/CACHE_MISSING/);
    authorize.mockResolvedValue({
      permissionScope: "scope",
      offlineAllowed: false,
    });
    await expect(
      pipeline.readCached(request, "offline", context(), lookup),
    ).rejects.toThrow(/OFFLINE_DENIED/);
    const ctx = context();
    ctx.authorization.expiresAt = "2020-01-01T00:00:00Z";
    await expect(
      pipeline.readCached(request, "offline", ctx, lookup),
    ).rejects.toThrow(/AUTH_EXPIRED/);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("uses real temporary file bytes through the injected boundary without altering receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-assets space-"));
    try {
      const { fs, authorize } = arrange();
      fs.stage = async (_request, content, ctx) => {
        const hash = sha256(content);
        await writeFile(join(dir, hash), content, { flag: "wx" });
        return {
          schemaVersion: "1.0",
          projectId: ctx.projectId,
          requestId: ctx.requestId,
          status: "complete",
          value: {
            stagingId: hash,
            artifact: {
              id: hash,
              path: hash,
              mediaType: "application/octet-stream",
              byteLength: content.length,
              sha256: hash,
            },
          },
          diagnosticIds: [],
        };
      };
      const pipeline = new AssetPipeline({
        filesystem: fs,
        authorize,
        rightsAuthority: () => true,
      });
      const result = await pipeline.stageSnapshot("root", [image()], context());
      for (const entry of result.staged)
        expect(sha256(await readFile(join(dir, entry.artifact.path)))).toBe(
          entry.artifact.sha256,
        );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("stages verified bundled face and unmodified notice as separate byte identities", async () => {
    const { pipeline } = arrange();
    const font = resources.fonts[0];
    if (!font) throw new Error("fixture font required");
    const result = await pipeline.stageSnapshot(
      "root",
      [
        {
          kind: "font",
          face: font,
          bytes: readFileSync(new URL("assets/ABeeZee-Regular.ttf", root)),
          notice: readFileSync(new URL("assets/OFL.txt", root)),
          text: "Hello",
        },
      ],
      context(),
    );
    expect(result.fonts[0]?.resource).toMatchObject({
      kind: "bundled",
      availability: "verified",
      glyphCoverage: "fixture-verified",
    });
    expect(result.staged.map((entry) => entry.artifact.sha256)).toContain(
      font.license.notice.sha256,
    );
  });
  it.each([
    "../escape",
    "..\\escape",
    "C:\\outside",
    "/absolute",
    "https://assets.example",
  ])("rejects path-like root IDs %s before writing", async (artifactRootId) => {
    const { pipeline, fs } = arrange();
    await expect(
      pipeline.stageSnapshot(artifactRootId, [image()], context()),
    ).rejects.toThrow(/ROOT_ID/);
    expect(fs.stage).not.toHaveBeenCalled();
  });
  it("preserves earlier receipts when a later boundary call throws", async () => {
    const { pipeline, fs } = arrange();
    vi.mocked(fs.stage)
      .mockImplementationOnce(async (request, content, ctx) => ({
        schemaVersion: "1.0",
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        status: "complete",
        value: {
          stagingId: "first",
          artifact: {
            id: "first",
            path: request.path,
            mediaType: "application/octet-stream",
            byteLength: content.length,
            sha256: sha256(content),
          },
        },
        diagnosticIds: [],
      }))
      .mockRejectedValueOnce(new Error("boundary failed"));
    await expect(
      pipeline.stageSnapshot("root", [image()], context()),
    ).rejects.toMatchObject({
      diagnostic: { code: "STAGING_FAILED" },
      staged: [expect.objectContaining({ stagingId: "first" })],
    });
  });
  it("round-trips scoped offline cached bytes, rejects mutation, and retains source freshness uncertainty", async () => {
    const { pipeline, staged } = arrange();
    const result = await pipeline.stageSnapshot("root", [image()], context());
    const artifact = result.images[0]?.resource.artifact;
    if (!artifact) throw new Error("fixture image required");
    const request = {
      artifactRootId: "root",
      sourceSha256: sha256(bytes),
      dependencyHashes: [sha256(notice)],
      derivativeVersion: "1",
    };
    const lookup = async (key: string) => ({
      key,
      projectId: "p",
      permissionScope: "permitted-v1",
      artifact,
    });
    const cached = await pipeline.readCached(
      request,
      "offline",
      context(),
      lookup,
    );
    expect(cached.freshness).toBe("unknown/offline");
    expect(sha256(cached.bytes)).toBe(artifact.sha256);
    cached.bytes.fill(0);
    expect(
      sha256(
        (await pipeline.readCached(request, "offline", context(), lookup))
          .bytes,
      ),
    ).toBe(artifact.sha256);
    staged.set(artifact.path, Buffer.from("corrupt"));
    await expect(
      pipeline.readCached(request, "offline", context(), lookup),
    ).rejects.toThrow(/BYTE_IDENTITY/);
  });
  it("rejects cross-project cache records without reading their bytes", async () => {
    const { pipeline, fs } = arrange();
    const request = {
      artifactRootId: "root",
      sourceSha256: sha256(bytes),
      dependencyHashes: [],
      derivativeVersion: "1",
    };
    await expect(
      pipeline.readCached(request, "offline", context(), async (key) => ({
        key,
        projectId: "unauthorized",
        permissionScope: "permitted-v1",
        artifact: asset.artifact,
      })),
    ).rejects.toThrow(/CACHE_SCOPE/);
    expect(fs.read).not.toHaveBeenCalled();
  });
});
