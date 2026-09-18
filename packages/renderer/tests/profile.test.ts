import { expect, it } from "vitest";
import { installedBuildIdentity } from "../src/profile.js";

it("pins installed renderer and kernel runtime bytes separately from version labels", async () => {
  const first = await installedBuildIdentity();
  expect(first.renderer.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.kernel.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await installedBuildIdentity()).toEqual(first);
});
