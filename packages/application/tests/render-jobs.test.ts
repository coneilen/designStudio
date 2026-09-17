import { expect, it } from "vitest";
import { createRenderJobs } from "../src/render-jobs.js";

it("does not accept completion without observed preparation, cleanup and byte-bound evidence", async () => {
  const jobs = createRenderJobs({
    async loadRequest() {
      throw new Error("not called");
    },
    options: {
      projectId: "project_synthetic",
      providerId: "renderer_static",
      artifactRootId: "foundation_artifacts",
      authority: () => false,
      rightsAuthority: () => false,
      async resolveInputs() {
        throw new Error("not called");
      },
      worker: {
        async open() {
          throw new Error("not called");
        },
      },
    },
  });
  await expect(
    jobs.verifyCompletion(
      // @ts-expect-error Deliberately malformed untrusted completion has no preparation authority.
      { job: { id: "forged" }, generation: 1 },
      { outputs: [], outputState: "complete", diagnosticIds: [] },
      [],
      undefined,
    ),
  ).rejects.toThrow();
});
