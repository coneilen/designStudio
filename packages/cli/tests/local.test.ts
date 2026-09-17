import { success } from "@design-studio/application";
import { expect, it } from "vitest";
import { parseArguments } from "../src/arguments.js";
import { callLocal } from "../src/local.js";

it("maps local commands through the same authoritative route and application request", async () => {
  const result = await callLocal(
    parseArguments([
      "fixtures",
      "accept",
      "settings-screen",
      "--new",
      "--request-id",
      "logical",
      "--json",
    ]),
    {
      async call(invocation) {
        expect(invocation).toMatchObject({
          operation: "acceptFixture",
          projectId: "project_synthetic",
          requestId: "logical",
          id: "design_settings-screen",
          ifNoneMatch: "*",
          body: { fixtureId: "settings-screen", base: null, branch: "main" },
        });
        return {
          kind: "json",
          envelope: success("logical", {
            kind: "service",
            state: "stopped",
            projectId: "project_synthetic",
            warnings: [],
          }),
        };
      },
    },
  );
  expect(result.success).toBe(true);
});
it("refuses cold async before any application work", async () => {
  let called = false;
  await expect(
    callLocal(
      parseArguments([
        "render",
        "design_settings-screen",
        "--async",
        "--request-id",
        "r",
      ]),
      {
        async call() {
          called = true;
          throw new Error("Must not run.");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  expect(called).toBe(false);
});
