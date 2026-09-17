import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommitReceipt, OperationContext } from "@design-studio/contracts";
import {
  fakeComplete,
  fakeFailure,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import type { CleanupReport } from "@design-studio/renderer-host";
import { expect, it, vi } from "vitest";
import { type RendererOptions, StaticRenderer } from "../src/renderer.js";
import { fixtureInputs } from "./support.js";

async function recorded() {
  const { request, accepted } = await fixtureInputs("settings-screen");
  const root = path.resolve(
    "packages/renderer/tests/goldens/windows-x64-shell-r1243",
  );
  const metadata = JSON.parse(
    await readFile(path.join(root, "settings-screen.json"), "utf8"),
  );
  metadata.fonts = metadata.fonts.map((f: Record<string, unknown>) => ({
    ...f,
    fontId: request.resources.fonts[0]?.id,
    fontSha256: request.profile.fontHashes[0]?.sha256,
  }));
  const png = (await readFile(path.join(root, "settings-screen.png"))).toString(
    "base64",
  );
  const controller = new AbortController();
  const context = syntheticContext({
    signal: controller.signal,
    jobId: "test_job",
  });
  context.authorization.grants.push({
    resourceKind: "provider",
    resourceId: "renderer_static",
    operations: ["execute"],
  });
  const cleanup = fakeComplete<CleanupReport>(context, {
    workerExitObserved: true,
    jobEmptyObserved: true,
    mode: "graceful",
    exitCode: 0,
    signal: null,
  });
  const state = { omitFaces: false, malformed: "", cleanupFailure: false };
  const observer = vi.fn(async () => {});
  const options: RendererOptions = {
    projectId: context.projectId,
    providerId: "renderer_static",
    artifactRootId: "render_outputs",
    authority: (auth) => auth === context.authorization,
    rightsAuthority: () => true,
    resolveInputs: async () => accepted,
    worker: {
      open: async (ctx) =>
        fakeComplete(ctx, {
          exchange: async (_bytes: Uint8Array, c: OperationContext) =>
            state.cleanupFailure
              ? fakeFailure(c, "CANCELLED")
              : state.malformed === "json"
                ? fakeComplete(c, Uint8Array.of(0xff))
                : fakeComplete(
                    c,
                    canonicalBytes({
                      ok: true,
                      png: state.malformed === "png" ? "AA==" : png,
                      nodes: metadata.nodes,
                      fonts: state.omitFaces ? [] : metadata.fonts,
                      overflow: [],
                      profile: request.profile,
                    }),
                  ),
          close: async () =>
            state.cleanupFailure
              ? fakeFailure(context, "INTERRUPTED")
              : cleanup,
          closed: Promise.resolve(cleanup),
        }),
    },
    filesystem: {
      stage: async (file, bytes, c) =>
        fakeComplete(c, {
          stagingId: `stage_${hashBytes(bytes)}`,
          artifact: {
            id: `artifact_${hashBytes(bytes)}`,
            path: file.path,
            mediaType: "application/octet-stream",
            byteLength: bytes.byteLength,
            sha256: hashBytes(bytes),
          },
        }),
    },
    observePreparation: observer,
    publish: async (preparation, ctx) => {
      expect(observer).toHaveBeenCalledTimes(1);
      const receipt: CommitReceipt = {
        schemaVersion: "1.0",
        id: "test_receipt",
        projectId: ctx.projectId,
        jobId: "test_job",
        idempotency: {
          key: ctx.requestId,
          projectId: ctx.projectId,
          actorId: ctx.authorization.actorId,
          operation: "write",
          payloadSha256: "a".repeat(64),
        },
        committedAt: new Date(ctx.clock.now()).toISOString(),
        outputs: preparation.staged.map((s) => s.artifact).reverse(),
        integrity: "verified",
        publication: "atomic",
      };
      return fakeComplete(ctx, receipt);
    },
  };
  return { request, context, options, observer, controller, state };
}
it("recorded fake: standard Renderer observes ownership before required publication", async () => {
  const t = await recorded();
  expect(
    await new StaticRenderer(t.options).render(t.request, t.context),
  ).toMatchObject({ status: "complete" });
});
it("recorded fake: verified commit wins cancellation race without second commit", async () => {
  const t = await recorded(),
    publish = t.options.publish;
  t.options.publish = vi.fn(async (preparation, context) => {
    const receipt = await publish(preparation, context);
    t.controller.abort();
    return receipt;
  });
  expect(
    await new StaticRenderer(t.options).render(t.request, t.context),
  ).toMatchObject({ status: "complete" });
  expect(t.options.publish).toHaveBeenCalledTimes(1);
});
it("recorded fake: forged publication metadata cannot yield complete", async () => {
  const t = await recorded(),
    publish = t.options.publish;
  t.options.publish = async (preparation, context) => {
    const receipt = await publish(preparation, context);
    if (receipt.status === "complete") receipt.value.outputs = [];
    return receipt;
  };
  expect(
    await new StaticRenderer(t.options).render(t.request, t.context),
  ).toMatchObject({
    status: "interrupted",
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});
it("recorded fake: missing actual-face proof blocks all stages/publication", async () => {
  const t = await recorded();
  t.state.omitFaces = true;
  const stage = vi.spyOn(t.options.filesystem, "stage"),
    publish = vi.spyOn(t.options, "publish");
  expect(
    await new StaticRenderer(t.options).render(t.request, t.context),
  ).toMatchObject({ status: "failed" });
  expect(stage).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
it.each(["json", "png"])(
  "recorded fake: malformed %s is a typed failure after cleanup",
  async (format) => {
    const t = await recorded();
    t.state.malformed = format;
    expect(
      await new StaticRenderer(t.options).render(t.request, t.context),
    ).toMatchObject({ status: "failed" });
  },
);
it("recorded fake: cleanup uncertainty preserves primary execution failure", async () => {
  const t = await recorded();
  t.state.cleanupFailure = true;
  expect(
    await new StaticRenderer(t.options).render(t.request, t.context),
  ).toMatchObject({ status: "interrupted" });
  expect(t.observer).toHaveBeenCalledWith(
    expect.objectContaining({
      recoveryRequired: true,
      executionFailure: expect.objectContaining({ code: "CANCELLED" }),
      cleanup: expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "INTERRUPTED" }),
      }),
    }),
    expect.anything(),
  );
});
