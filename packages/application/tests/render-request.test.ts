import path from "node:path";
import { canonicalDigest } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { makeRenderRequest } from "../src/render-request.js";

it("pins canonical accepted content and the installed compiler without launching a browser", async () => {
  const catalog = await loadCatalog(
    path.resolve("tests\\fixtures\\foundation"),
  );
  const fixture = catalog.fixture("settings-screen");
  const revision = {
    id: "revision_1",
    sha256: canonicalDigest(fixture.design),
  };
  const request = await makeRenderRequest(
    catalog,
    "settings-screen",
    revision,
    "strict",
  );
  expect(request.revision).toEqual(revision);
  expect(request.profile.network).toBe("deny");
  expect(request.profile.fontFallback).toBe("forbidden");
  expect(request.resources.id).toBe("resources_synthetic");
  await expect(
    makeRenderRequest(
      catalog,
      "settings-screen",
      { ...revision, sha256: "a".repeat(64) },
      "strict",
    ),
  ).rejects.toThrow();
});
