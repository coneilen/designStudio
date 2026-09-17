import path from "node:path";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { FIXTURE_IDS, loadCatalog } from "../src/catalog.js";
import { fixtureSemantics } from "../src/fixtures.js";

it("keeps raw logical IDs while producing canonical accepted design bytes and exact allowed reference bindings", async () => {
  const catalog = await loadCatalog(
    path.resolve("tests\\fixtures\\foundation"),
  );
  const semantic = fixtureSemantics(catalog, "settings-screen");
  expect(semantic.design.resources.snapshotId).toBe("resources_synthetic");
  expect(hashBytes(semantic.contentBytes)).toBe(
    canonicalDigest(semantic.design),
  );
  const resources = semantic.references.find(
    (entry) => entry.reference.id === "resources_synthetic",
  );
  expect(resources?.reference.sha256).toBe(hashBytes(semantic.resourceBytes));
  expect(
    semantic.references.some((entry) => entry.reference.id === "asset_stripes"),
  ).toBe(true);
  const asset = semantic.resources.assets[0];
  if (!asset) throw new Error("Pinned asset missing.");
  expect(
    semantic.rightsAuthority(
      {
        ...asset.license,
        id: "untrusted",
        source: "untrusted",
        redistribution: "permitted",
        embedding: "permitted",
      },
      "a".repeat(64),
      "embed",
    ),
  ).toBe(false);
});
it.each(FIXTURE_IDS)(
  "retains accepted identity for %s, including inspection-only content",
  async (id) => {
    const catalog = await loadCatalog(
      path.resolve("tests\\fixtures\\foundation"),
    );
    const semantic = fixtureSemantics(catalog, id);
    expect(semantic.design.designId).toBe(`design_${id}`);
    expect(semantic.assets).toHaveLength(2);
  },
);
it("does not let returned resource metadata rewrite the installed rights policy", async () => {
  const catalog = await loadCatalog(
    path.resolve("tests\\fixtures\\foundation"),
  );
  const semantic = fixtureSemantics(catalog, "settings-screen");
  const image = semantic.resources.assets[0];
  if (!image) throw new Error("Pinned image missing.");
  const digest = image.artifact.sha256;
  expect(semantic.rightsAuthority(image.license, digest, "embed")).toBe(true);
  image.license.source = "untrusted-replacement";
  expect(semantic.rightsAuthority(image.license, digest, "embed")).toBe(false);
});
