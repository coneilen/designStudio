import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";

const root = path.resolve("tests\\fixtures\\foundation");
it("loads only the exact installed synthetic catalog without relabeling", async () => {
  const catalog = await loadCatalog(root);
  const fixture = catalog.fixture("settings-screen");
  expect(fixture.design.projectId).toBe("project_synthetic");
  expect(fixture.design.designId).toBe("design_settings-screen");
  expect(fixture.design.resources.snapshotId).toBe("resources_synthetic");
  expect(() => catalog.fixture("foreign")).toThrow();
});
it("owns validated bytes instead of allowing a caller to mutate pinned resources", async () => {
  const catalog = await loadCatalog(root);
  const fixture = catalog.fixture("settings-screen");
  fixture.resourceBytes.fill(0);
  expect(catalog.fixture("settings-screen").resourceBytes).toEqual(
    new Uint8Array(await readFile(path.join(root, "resources.json"))),
  );
});
