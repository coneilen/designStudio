import { expect, it } from "vitest";
import { usingProject } from "../src/cleanup.js";

it("never emits success when owned project shutdown is incomplete", async () => {
  await expect(
    usingProject({ close: async () => false }, async () => "success"),
  ).rejects.toMatchObject({ code: "INTERRUPTED" });
});
it("retains the primary failure when cleanup also fails", async () => {
  const primary = new Error("Primary owned failure.");
  await expect(
    usingProject(
      {
        close: async () => {
          throw new Error("Cleanup.");
        },
      },
      async () => {
        throw primary;
      },
    ),
  ).rejects.toMatchObject({ code: "INTERRUPTED", cause: primary });
});
it("returns the actual result only after confirmed close", async () => {
  expect(
    await usingProject({ close: async () => true }, async () => "result"),
  ).toBe("result");
});
it("retains a service-command failure when its controller also reports interrupted close", async () => {
  const original = new Error("Owned command failed.");
  await expect(
    usingProject({ close: async () => false }, async () => {
      throw original;
    }),
  ).rejects.toMatchObject({ code: "INTERRUPTED", cause: original });
});
