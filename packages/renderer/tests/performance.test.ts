import { decodeRaster } from "@design-studio/assets";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { children } from "../src/layout.js";
import { prepareInputs } from "../src/resources.js";
import { performanceFixture } from "./fixtures/performance.js";

it("audits exactly 500 expanded nodes and 10MiB of exercised image/font bytes without padding", async () => {
  const { request, accepted, resourceBytes } = await performanceFixture();
  expect(resourceBytes).toBe(10_485_760);
  const prepared = prepareInputs(
    request,
    accepted,
    () => true,
    DEFAULT_BUDGETS,
  );
  const nodes = [prepared.expanded.root];
  for (let i = 0; i < nodes.length; i++)
    nodes.push(...children(nodes[i] ?? prepared.expanded.root));
  expect(nodes).toHaveLength(500);
  for (const asset of request.resources.assets) {
    expect(
      nodes.some(
        (n) =>
          (n.type === "image" || n.type === "icon") && n.assetId === asset.id,
      ),
    ).toBe(true);
    const entry = accepted.artifacts.find(
      (a) => a.artifact.sha256 === asset.artifact.sha256,
    );
    expect(entry).toBeDefined();
    const decoded = decodeRaster(
      entry?.bytes ?? new Uint8Array(),
      DEFAULT_BUDGETS,
    );
    expect([decoded.width, decoded.height]).toEqual([
      asset.width,
      asset.height,
    ]);
  }
});
