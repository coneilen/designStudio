import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import { HostBoundaryError, SystemClock } from "@design-studio/host";
import { afterEach, expect, it, vi } from "vitest";
import type { RendererWorkerOptions } from "../src/index.js";
import { loadJobs, type OwnedJob } from "../src/windows-job.js";

afterEach(() => {
  vi.doUnmock("../src/windows-job.js");
  vi.resetModules();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "renderer failure owned "));
  const filename = path.join(root, "worker.mjs");
  const code = "export async function render() { return Buffer.of(1); }";
  await writeFile(filename, code);
  const clock = new SystemClock();
  const synthetic = syntheticContext();
  const context = {
    ...synthetic,
    clock,
    deadline: new Date(clock.now() + 10000).toISOString(),
    authorization: {
      ...synthetic.authorization,
      expiresAt: new Date(clock.now() + 20000).toISOString(),
    },
  };
  const options: RendererWorkerOptions = {
    projectId: "project_synthetic",
    providerId: "fake-process",
    authority: () => true,
    node: {
      path: process.execPath,
      sha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      maxBytes: 200000000,
    },
    implementation: {
      path: filename,
      sha256: createHash("sha256").update(code).digest("hex"),
      maxBytes: 10000,
    },
    tempRoot: root,
    trustedExclusiveAccess: true,
    environment: {},
    limits: {
      startMs: 2000,
      idleMs: 2000,
      lifetimeMs: 5000,
      closeMs: 300,
      maxFrameBytes: 1000,
      maxInputBytes: 10000,
      maxOutputBytes: 10000,
      maxStdoutBytes: 1000,
      maxStderrBytes: 1000,
      maxRequests: 2,
    },
  };
  return { root, options, context };
}
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "missing optional native capability is explicit, never a successful fallback",
  async () => {
    const data = await fixture();
    vi.doMock("../src/windows-job.js", () => ({
      loadJobs: async () => {
        throw new HostBoundaryError(
          "PROVIDER_UNAVAILABLE",
          "Injected missing native prebuild.",
          true,
        );
      },
    }));
    try {
      const { RendererWorkerHost } = await import("../src/index.js");
      expect(
        await new RendererWorkerHost(data.options).open(data.context),
      ).toMatchObject({
        status: "unavailable",
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "denied parent membership verification prevents the implementation start",
  async () => {
    const native = await loadJobs();
    const data = await fixture();
    const marker = path.join(data.root, "unexpected-import");
    const code = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); export async function render(bytes) {return bytes;}`;
    await writeFile(data.options.implementation.path, code);
    data.options.implementation.sha256 = createHash("sha256")
      .update(code)
      .digest("hex");
    let owned: OwnedJob | undefined;
    vi.doMock("../src/windows-job.js", () => ({
      loadJobs: async () => ({
        create(name: string) {
          owned = native.create(name);
          return { ...owned, members: () => [] };
        },
      }),
    }));
    try {
      const { RendererWorkerHost } = await import("../src/index.js");
      expect(
        await new RendererWorkerHost(data.options).open(data.context),
      ).toMatchObject({ status: "failed", error: { code: "POLICY_FAILED" } });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      owned?.close();
      await rm(data.root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "cleanup native-close error stays interrupted, never invented reaping success",
  async () => {
    const native = await loadJobs();
    const data = await fixture();
    let owned: OwnedJob | undefined;
    vi.doMock("../src/windows-job.js", () => ({
      loadJobs: async () => ({
        create(name: string) {
          owned = native.create(name);
          return {
            ...owned,
            close: () => {
              throw new HostBoundaryError(
                "PROVIDER_UNAVAILABLE",
                "Injected CloseHandle failure.",
              );
            },
          };
        },
      }),
    }));
    try {
      const { RendererWorkerHost } = await import("../src/index.js");
      const result = await new RendererWorkerHost(data.options).open(
        data.context,
      );
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      const controller = new AbortController();
      const request = result.value.exchange(Uint8Array.of(1), {
        ...data.context,
        signal: controller.signal,
      });
      controller.abort();
      expect(await request).toMatchObject({
        status: "interrupted",
        error: { code: "INTERRUPTED" },
      });
      const closed = await result.value.closed;
      expect(closed).toMatchObject({
        status: "interrupted",
        error: {
          code: "INTERRUPTED",
          message: expect.stringContaining("CANCELLED"),
        },
      });
      expect(await result.value.close()).toEqual(closed);
    } finally {
      owned?.close();
      await rm(data.root, { recursive: true, force: true });
    }
  },
);
