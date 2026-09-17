import {
  DEFAULT_BUDGETS,
  type OperationContext,
} from "@design-studio/contracts";
import {
  createFakeFileSystem,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { renderStaged } from "../src/renderer.js";
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
