import { expect, it } from "vitest";
import { matchRoute } from "../src/route-match.js";

it.each([
  "/v1/projects/project_synthetic/ignored/../doctor",
  "/v1/projects/project_synthetic/./doctor",
  "/v1/projects/project_synthetic/doctor?branch=main#fragment",
  "/v1/projects/project_synthetic/%64octor",
])(
  "rejects noncanonical raw targets before URL normalization: %s",
  (target) => {
    expect(() => matchRoute(target, "GET", "project_synthetic")).toThrow();
  },
);
it("does not confuse opaque IDs containing dots with traversal segments", () => {
  expect(
    matchRoute(
      "/v1/projects/project_synthetic/jobs/job.v1",
      "GET",
      "project_synthetic",
    ).id,
  ).toBe("job.v1");
});
