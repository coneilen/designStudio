import { expect, it } from "vitest";
import { validateInvocation } from "../src/requests.js";

it("enforces identical conditional mutation rules for direct and HTTP callers", () => {
  const request = {
    operation: "cancelJob" as const,
    projectId: "project_synthetic",
    id: "job_1",
    requestId: "control_1",
    parameters: {},
    body: {},
  };
  expect(() => validateInvocation(request)).toThrow();
  expect(() =>
    validateInvocation({ ...request, ifMatch: '"job:job_1:9007199254740992"' }),
  ).toThrow();
  expect(() =>
    validateInvocation({ ...request, ifMatch: '"job:other:1"' }),
  ).toThrow();
  expect(() =>
    validateInvocation({ ...request, ifMatch: '"job:job_1:1"' }),
  ).not.toThrow();
});
it("requires explicit new-root or matching update body/header preconditions", () => {
  const request = {
    operation: "acceptFixture" as const,
    projectId: "project_synthetic",
    id: "design_settings-screen",
    requestId: "write_1",
    parameters: {},
    body: { fixtureId: "settings-screen", branch: "main", base: null },
  };
  expect(() => validateInvocation(request)).toThrow();
  expect(() =>
    validateInvocation({ ...request, ifNoneMatch: "*" }),
  ).not.toThrow();
  expect(() =>
    validateInvocation({
      ...request,
      ifNoneMatch: "*",
      ifMatch: `"${"a".repeat(64)}"`,
    }),
  ).toThrow();
});
