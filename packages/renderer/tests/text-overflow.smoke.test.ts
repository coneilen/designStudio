import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BUDGETS, type TextNode } from "@design-studio/contracts";
import { canonicalBytes } from "@design-studio/design-ir";
import { ProjectFileSystem } from "@design-studio/host";
import { expect, it } from "vitest";
import { layoutDesign } from "../src/layout.js";
import { renderStaged } from "../src/renderer.js";
import { prepareInputs } from "../src/resources.js";
import { fixtureInputs, workerHarness } from "./support.js";

async function textFixture() {
  const fixture = await fixtureInputs();
  const base = prepareInputs(
    fixture.request,
    fixture.accepted,
    () => true,
    DEFAULT_BUDGETS,
  );
  const node =
    "children" in base.expanded.root
      ? base.expanded.root.children[0]
      : undefined;
  if (node?.type !== "text") throw new Error("Missing text fixture");
  const text: TextNode = {
    ...node,
    id: "overflow_text",
    layout: { width: 50, height: 20 },
    content: "This text is wider than fifty units",
    styledRanges: [],
    typography: {
      ...node.typography,
      wrap: "no-wrap",
      lineHeight: 16,
      fontSize: 12,
    },
  };
  return { fixture, base, text };
}
it.each([
  ["none", 16],
  ["bounds", 16],
  ["rounded-bounds", 16],
  ["none", 32],
  ["bounds", 32],
  ["rounded-bounds", 32],
] as const)(
  "pure text excess distinguishes %s clip intent at measured height %s",
  async (kind, height) => {
    const { text } = await textFixture();
    text.appearance = {
      clip: { kind, ...(kind === "rounded-bounds" ? { radius: 4 } : {}) },
    };
    const result = await layoutDesign(text, 393, 852, async () => ({
      width: 100,
      height,
    }));
    expect(result.overflow).toEqual(kind === "none" ? [text.id] : []);
    expect(result.textExcess[text.id]).toMatchObject({
      width: 100,
      height,
      allocatedWidth: 50,
      allocatedHeight: 20,
      clipped: kind !== "none",
    });
  },
);
it("synthetic left-only excess remains unexpected even when a supplied width reports only allocation", async () => {
  const { text } = await textFixture();
  const layout = await layoutDesign(text, 393, 852, async () => ({
    width: 50,
    height: 16,
    left: -70,
    right: 50,
  }));
  expect(layout.overflow).toEqual([text.id]);
  expect(layout.textExcess[text.id]).toMatchObject({
    left: -70,
    right: 50,
    clipped: false,
  });
});
it
  .skipIf(process.env.F06_RENDER_SMOKE !== "1")
  .each(["start", "center", "end"] as const)(
  "contained Chromium measures both edges of %s-aligned text and honors explicit clipping",
  async (alignment) => {
    const { fixture, base, text } = await textFixture();
    text.layout.height = 50;
    text.typography.alignment = alignment;
    const harness = await workerHarness();
    const opened = await harness.host.open(harness.context("open"));
    expect(opened.status, JSON.stringify(opened)).toBe("complete");
    if (opened.status !== "complete") {
      await harness.remove();
      return;
    }
    const lease = opened.value;
    try {
      async function run(id: string, mode: "strict" | "inspection") {
        const response = await lease.exchange(
          canonicalBytes({
            version: 1,
            design: { ...base.expanded, root: text },
            fonts: base.fonts,
            images: base.images,
            profile: fixture.request.profile,
            mode,
            budget: DEFAULT_BUDGETS,
          }),
          harness.context(id),
        );
        expect(response.status, JSON.stringify(response.status)).toBe(
          "complete",
        );
        if (response.status !== "complete") throw new Error("No capture");
        return JSON.parse(new TextDecoder().decode(response.value));
      }
      expect(await run("strict-unclipped", "strict")).toMatchObject({
        ok: false,
        code: "INVALID_LAYOUT",
        message: "Unexpected measured text/layout overflow.",
      });
      const inspection = await run("inspection-unclipped", "inspection");
      expect(inspection).toMatchObject({ ok: true, overflow: [text.id] });
      expect(inspection.nodes[text.id]).toMatchObject({
        overflow: true,
        measuredBounds: { width: 50, height: 50 },
      });
      expect(inspection.textExcess[text.id].width).toBeGreaterThan(50);
      const extent = inspection.textExcess[text.id];
      expect(extent.width).toBeCloseTo(extent.right - extent.left, 8);
      expect(extent.left < 0 || extent.right > 50).toBe(true);
      for (const kind of ["bounds", "rounded-bounds"] as const) {
        text.appearance = {
          clip: { kind, ...(kind === "rounded-bounds" ? { radius: 4 } : {}) },
        };
        const clipped = await run(`strict-${kind}`, "strict");
        expect(clipped, JSON.stringify(clipped)).toMatchObject({
          ok: true,
          overflow: [],
        });
        expect(clipped.nodes[text.id]).toMatchObject({
          clipChain: [text.id],
          measuredBounds: { width: 50, height: 50 },
        });
        expect(clipped.nodes[text.id].overflow).toBe(true);
        expect(clipped.textExcess[text.id]).toMatchObject({
          ...inspection.textExcess[text.id],
          clipped: true,
        });
      }
    } finally {
      expect(await opened.value.close()).toMatchObject({
        status: "complete",
        value: { workerExitObserved: true, jobEmptyObserved: true },
      });
      await harness.remove();
    }
  },
  40_000,
);
it.skipIf(process.env.F06_RENDER_SMOKE !== "1")(
  "staged strict clipping and unclipped inspection retain truthful text-excess diagnostics",
  async () => {
    const { fixture, text } = await textFixture();
    const harness = await workerHarness();
    const artifactRoot = path.join(harness.root, "artifacts");
    await mkdir(artifactRoot);
    const filesystem = await ProjectFileSystem.create({
      projectId: fixture.request.design.projectId,
      authority: harness.authority,
      roots: [
        {
          id: "render_outputs",
          path: artifactRoot,
          access: "read-write",
          trustedExclusiveAccess: true,
          managedBlobs: true,
        },
      ],
    });
    try {
      fixture.request.design.root = text;
      text.appearance = { clip: { kind: "bounds" } };
      fixture.accepted.designBytes = canonicalBytes(fixture.request.design);
      const options = {
        projectId: fixture.request.design.projectId,
        providerId: "renderer_static",
        artifactRootId: "render_outputs",
        authority: harness.authority,
        rightsAuthority: (_license: unknown, hash: string) =>
          fixture.request.profile.fontHashes
            .concat(fixture.request.profile.assetHashes)
            .some((ref) => ref.sha256 === hash),
        resolveInputs: async () => fixture.accepted,
        filesystem,
        worker: harness.host,
      };
      const strict = await renderStaged(
        fixture.request,
        harness.context("strict-clipped"),
        options,
      );
      expect(strict.outcome.status, JSON.stringify(strict.outcome)).toBe(
        "complete",
      );
      if (strict.outcome.status === "complete") {
        expect(strict.outcome.value.boundsMap.nodes[text.id]).toMatchObject({
          overflow: true,
          clipChain: [text.id],
        });
        expect(strict.outcome.value.diagnostics.diagnostics).toContainEqual(
          expect.objectContaining({
            severity: "info",
            message:
              "Measured text extends beyond its allocation and is intentionally clipped.",
          }),
        );
        expect(strict.outcome.value.diagnostics.assessments).toContainEqual(
          expect.objectContaining({ stage: "renderable", status: "pass" }),
        );
      }
      text.appearance = { clip: { kind: "none" } };
      fixture.request.mode = "inspection";
      fixture.accepted.designBytes = canonicalBytes(fixture.request.design);
      const inspection = await renderStaged(
        fixture.request,
        harness.context("inspection-unclipped"),
        options,
      );
      expect(
        inspection.outcome.status,
        JSON.stringify(inspection.outcome),
      ).toBe("partial");
      if (inspection.outcome.status === "partial") {
        expect(inspection.outcome.value.diagnostics.diagnostics).toContainEqual(
          expect.objectContaining({
            severity: "error",
            nodeIds: [text.id],
            message: "Measured content exceeds its allocation.",
          }),
        );
        expect(inspection.outcome.value.diagnostics.assessments).toContainEqual(
          expect.objectContaining({ stage: "renderable", status: "fail" }),
        );
      }
    } finally {
      await filesystem.close();
      await harness.remove();
    }
  },
  40_000,
);
