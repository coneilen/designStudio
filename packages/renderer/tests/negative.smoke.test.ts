import { decodeRaster, sanitizeSvg } from "@design-studio/assets";
import { DEFAULT_BUDGETS, type DesignNode } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { prepareInputs } from "../src/resources.js";
import { fixtureInputs, workerHarness } from "./support.js";

it.skipIf(process.env.F06_RENDER_SMOKE !== "1")(
  "real worker diagnoses transformed overflow, captures scroll offsets and treats injection as inert text",
  async () => {
    const harness = await workerHarness();
    const opened = await harness.host.open(harness.context("open"));
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") {
      await harness.remove();
      return;
    }
    const lease = opened.value;
    const fixture = await fixtureInputs();
    const base = prepareInputs(
      fixture.request,
      fixture.accepted,
      () => true,
      DEFAULT_BUDGETS,
    );
    async function run(id: string, root: DesignNode, offset = 0) {
      const profile = structuredClone(fixture.request.profile);
      profile.capture.scrollOffset.y = offset;
      const result = await lease.exchange(
        canonicalBytes({
          version: 1,
          design: { ...base.expanded, root },
          profile,
          fonts: base.fonts,
          images: base.images,
          mode: "strict",
          budget: DEFAULT_BUDGETS,
        }),
        harness.context(id),
      );
      expect(result.status).toBe("complete");
      if (result.status !== "complete") throw new Error("Missing reply");
      return JSON.parse(new TextDecoder().decode(result.value));
    }
    try {
      const shape: DesignNode = {
        id: "shape",
        type: "shape",
        shape: "rectangle",
        layout: { width: 20, height: 20 },
        appearance: { fill: { space: "srgb", r: 1, g: 0, b: 0, a: 1 } },
        transform: { matrix: [1, 0, 0, 1, 110, 0], origin: { x: 0, y: 0 } },
      };
      const root: DesignNode = {
        id: "root",
        type: "stack",
        layout: { width: 100, height: 100 },
        children: [shape],
      };
      expect(await run("overflow", root)).toMatchObject({
        ok: false,
        code: "INVALID_LAYOUT",
      });
      const clipped = structuredClone(root);
      clipped.appearance = { clip: { kind: "rounded-bounds", radius: 8 } };
      const clipResult = await run("clip", clipped);
      expect(clipResult.ok).toBe(true);
      expect(clipResult.nodes.shape.clipChain).toContain("root");
      shape.transform = { matrix: [1, 0, 0, 1, 0, 0], origin: { x: 0, y: 0 } };
      const offsetResult = await run("capture-offset", root, 12);
      expect(offsetResult.nodes.shape.measuredBounds.y).toBe(-12);
      const text = structuredClone(base.expanded.root);
      if (!("children" in text) || text.children[0]?.type !== "text")
        throw new Error("Fixture text missing");
      text.children[0].content = '<img src="https://evil.invalid/x">';
      text.children[0].styledRanges = [];
      const inert = await run("injection", text);
      expect(inert.ok, JSON.stringify(inert)).toBe(true);
      expect(Object.keys(inert.nodes)).toHaveLength(2);
      const scroll: DesignNode = {
        id: "scroll",
        type: "scroll",
        layout: { width: 100, height: 100 },
        scroll: {
          direction: "vertical",
          viewportBounds: {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            unit: "design-unit",
          },
          contentBounds: {
            x: 0,
            y: 0,
            width: 100,
            height: 300,
            unit: "design-unit",
          },
          captureOffset: { x: 0, y: 100 },
        },
        children: [
          {
            ...shape,
            layout: {
              width: 20,
              height: 20,
              position: "absolute",
              offset: { x: 0, y: 150 },
            },
          },
        ],
      };
      const scrolled = await run("scroll", scroll);
      expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
      expect(scrolled.nodes.shape.measuredBounds.y).toBe(50);
      expect(scrolled.nodes.shape.clipChain).toEqual(["scroll"]);
      const svg = sanitizeSvg(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#ff0000"/></svg>',
        ),
        DEFAULT_BUDGETS,
      );
      base.images.push({
        id: "svg_fixture",
        bytes: Buffer.from(svg.bytes).toString("base64"),
        sha256: hashBytes(svg.bytes),
        mediaType: "image/svg+xml",
        width: 20,
        height: 20,
      });
      const painted = await run("paint", {
        id: "paint_root",
        type: "stack",
        layout: { width: 100, height: 100 },
        children: [
          {
            id: "shadow",
            type: "shape",
            shape: "rectangle",
            layout: { width: 20, height: 20 },
            appearance: {
              fill: { space: "srgb", r: 1, g: 0, b: 0, a: 1 },
              shadow: {
                offset: { x: 10, y: 0 },
                blur: 4,
                spread: 0,
                color: { space: "srgb", r: 0, g: 0, b: 0, a: 1 },
              },
            },
          },
          {
            id: "svg",
            type: "image",
            assetId: "svg_fixture",
            fit: "fill",
            layout: {
              width: 20,
              height: 20,
              position: "absolute",
              offset: { x: 40, y: 0 },
            },
          },
        ],
      });
      expect(painted.ok, JSON.stringify(painted)).toBe(true);
      const paintedPixels = decodeRaster(
        Buffer.from(painted.png, "base64"),
        DEFAULT_BUDGETS,
      );
      const pixel = (x: number, y: number) => [
        ...paintedPixels.rgba.slice((y * 393 + x) * 4, (y * 393 + x) * 4 + 3),
      ];
      expect(pixel(50, 10)).toEqual([255, 0, 0]);
      expect(pixel(25, 10).every((channel) => channel < 200)).toBe(true);
      const rounded = await run("rounded-pixels", {
        id: "rounded_root",
        type: "stack",
        layout: { width: 100, height: 100 },
        appearance: { clip: { kind: "rounded-bounds", radius: 16 } },
        children: [
          {
            id: "red",
            type: "shape",
            shape: "rectangle",
            layout: { width: 100, height: 100 },
            appearance: { fill: { space: "srgb", r: 1, g: 0, b: 0, a: 1 } },
          },
        ],
      });
      expect(rounded.ok, JSON.stringify(rounded)).toBe(true);
      const clippedPixels = decodeRaster(
        Buffer.from(rounded.png, "base64"),
        DEFAULT_BUDGETS,
      );
      expect([...clippedPixels.rgba.slice(0, 3)]).toEqual([255, 255, 255]);
      expect(rounded.nodes.red.measuredBounds).toMatchObject({
        width: 100,
        height: 100,
      });
    } finally {
      expect(await opened.value.close()).toMatchObject({ status: "complete" });
      await harness.remove();
    }
  },
  40_000,
);
