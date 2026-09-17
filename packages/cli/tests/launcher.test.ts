import { expect, it } from "vitest";
import { launchLocalSession } from "../src/launcher.js";

it("does not treat a repository import as an approved installation or start a service", async () => {
  await expect(launchLocalSession()).rejects.toMatchObject({
    code: "ACTION_REQUIRED",
  });
});
it("refuses foreign projects and invalid ports before acquiring an installation", async () => {
  await expect(
    launchLocalSession({ projectId: "foreign" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(launchLocalSession({ port: -1 })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});
