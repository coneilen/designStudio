import {
  type CommitReceipt,
  DEFAULT_BUDGETS,
  type OperationContext,
} from "@design-studio/contracts";
import {
  createFakeFileSystem,
  fakeFailure,
  syntheticContext,
} from "@design-studio/contracts/testing";
import type { RendererWorkerLease } from "@design-studio/renderer-host";
import { expect, it, vi } from "vitest";
import { renderStaged, StaticRenderer } from "../src/renderer.js";
import { fixtureInputs } from "./support.js";

it("rejects unauthenticated data before accepted-byte resolver or worker launch", async () => {
  const { request, accepted } = await fixtureInputs();
  const context: OperationContext = syntheticContext();
  const resolveInputs = vi.fn(async () => accepted),
    open = vi.fn();
  const result = await renderStaged(request, context, {
    projectId: "project_synthetic",
    providerId: "renderer_static",
    artifactRootId: "render_outputs",
    authority: () => false,
    rightsAuthority: () => false,
    resolveInputs,
    filesystem: createFakeFileSystem(),
    worker: { open },
  });
  expect(result.outcome.status).toBe("failed");
  expect(result.staged).toEqual([]);
  expect(resolveInputs).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
it("rejects trusted limit escalation from request before work", async () => {
  const { request, accepted } = await fixtureInputs();
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "provider",
    resourceId: "renderer_static",
    operations: ["execute"],
  });
  context.budget = {
    ...DEFAULT_BUDGETS,
    maxOutputBytes: DEFAULT_BUDGETS.maxOutputBytes + 1,
  };
  const open = vi.fn();
  const result = await renderStaged(request, context, {
    projectId: "project_synthetic",
    providerId: "renderer_static",
    artifactRootId: "render_outputs",
    authority: (auth) => auth === context.authorization,
    rightsAuthority: () => true,
    resolveInputs: async () => accepted,
    filesystem: createFakeFileSystem(),
    worker: { open },
  });
  expect(result.outcome.status).toBe("failed");
  expect(open).not.toHaveBeenCalled();
});
it.each(["staged", "standard"])(
  "%s snapshots mode, revision and profile before the first await",
  async (entry) => {
    const { request, accepted } = await fixtureInputs();
    const original = structuredClone(request);
    const originalAccepted = structuredClone(accepted);
    const context = syntheticContext();
    context.authorization.grants.push({
      resourceKind: "provider",
      resourceId: "renderer_static",
      operations: ["execute"],
    });
    const resolveInputs = vi.fn(async (owned: typeof request) => {
      expect(owned).toEqual(original);
      expect(Object.isFrozen(owned.profile)).toBe(true);
      return originalAccepted;
    });
    const options = {
      projectId: context.projectId,
      providerId: "renderer_static",
      artifactRootId: "render_outputs",
      authority: (auth: typeof context.authorization) =>
        auth === context.authorization,
      rightsAuthority: () => true,
      resolveInputs,
      filesystem: createFakeFileSystem(),
      worker: {
        open: vi.fn(async () =>
          fakeFailure<RendererWorkerLease>(context, "TOOL_MISSING"),
        ),
      },
      observePreparation: vi.fn(async () => {}),
      publish: vi.fn(async () =>
        fakeFailure<CommitReceipt>(context, "TOOL_MISSING"),
      ),
    };
    const pending =
      entry === "staged"
        ? renderStaged(request, context, options)
        : new StaticRenderer(options).render(request, context);
    request.mode = "inspection";
    request.revision.id = "mutated_revision";
    request.profile.capture.scrollOffset.y = 17;
    const result = await pending;
    expect(resolveInputs).toHaveBeenCalledTimes(1);
    expect(options.worker.open).toHaveBeenCalledTimes(1);
    expect("outcome" in result ? result.outcome : result).toMatchObject({
      status: "failed",
      error: { code: "TOOL_MISSING" },
    });
  },
);
