import type { DesignNode, TextNode } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import { compose, mapRect } from "../src/geometry.js";
import { layoutDesign } from "../src/layout.js";

const leaf = (id: string, width: number | "fill", height = 10): DesignNode => ({
  id,
  type: "spacer",
  layout: { width, height },
});
const measure = async (node: TextNode, width?: number) => ({
  width: Math.min(node.content.length * 8, width ?? Number.MAX_SAFE_INTEGER),
  height:
    24 *
    Math.ceil((node.content.length * 8) / (width ?? Number.MAX_SAFE_INTEGER)),
});
describe("explicit IR layout, not browser flex defaults", () => {
  it("shares fractional remaining space equally after padding and gaps", async () => {
    const result = await layoutDesign(
      {
        id: "root",
        type: "row",
        layout: {
          width: 101,
          height: 30,
          spacing: 3,
          padding: { top: 2, right: 5, bottom: 2, left: 5 },
        },
        children: [leaf("a", "fill"), leaf("b", "fill")],
      },
      101,
      30,
      measure,
    );
    expect(result.boxes.a).toMatchObject({ x: 5, y: 2, width: 44 });
    expect(result.boxes.b).toMatchObject({ x: 52, y: 2, width: 44 });
  });
  it("absolute offsets are parent-content coordinates, not flow", async () => {
    const a = leaf("a", 10);
    a.layout.position = "absolute";
    a.layout.offset = { x: 7, y: 9 };
    const result = await layoutDesign(
      {
        id: "root",
        type: "column",
        layout: {
          width: 100,
          height: 100,
          padding: { top: 4, right: 4, bottom: 4, left: 4 },
        },
        children: [a, leaf("b", 20)],
      },
      100,
      100,
      measure,
    );
    expect(result.boxes.a).toMatchObject({ x: 11, y: 13 });
    expect(result.boxes.b).toMatchObject({ x: 4, y: 4 });
  });
  it("rejects equal shares violating min/max rather than unequal clamping", async () => {
    const a = leaf("a", "fill");
    a.layout.minWidth = 60;
    await expect(
      layoutDesign(
        {
          id: "root",
          type: "row",
          layout: { width: 100, height: 30 },
          children: [a, leaf("b", "fill")],
        },
        100,
        30,
        measure,
      ),
    ).rejects.toThrow("constraint");
  });
  it("does not hide negative remaining space", async () => {
    await expect(
      layoutDesign(
        {
          id: "root",
          type: "row",
          layout: { width: 20, height: 30 },
          children: [leaf("a", 30), leaf("b", "fill")],
        },
        20,
        30,
        measure,
      ),
    ).rejects.toThrow("remaining");
  });
  it("rejects hug around unresolved fill", async () => {
    await expect(
      layoutDesign(
        {
          id: "root",
          type: "row",
          layout: { width: "hug", height: 30 },
          children: [leaf("a", "fill")],
        },
        100,
        30,
        measure,
      ),
    ).rejects.toThrow("dependency");
  });
  it("empty group is zero but a badge contributes its real union", async () => {
    const result = await layoutDesign(
      {
        id: "root",
        type: "row",
        layout: { width: 100, height: 30 },
        children: [
          {
            id: "empty",
            type: "group",
            layout: { width: "hug", height: "hug" },
            children: [],
          },
          {
            id: "badge",
            type: "group",
            layout: { width: "hug", height: "hug" },
            children: [leaf("dot", 8, 8)],
          },
        ],
      },
      100,
      30,
      measure,
    );
    expect(result.boxes.empty).toMatchObject({ width: 0, height: 0 });
    expect(result.boxes.badge).toMatchObject({ width: 8, height: 8 });
  });
  it("reports overflow without stretching viewport", async () => {
    const result = await layoutDesign(
      {
        id: "root",
        type: "column",
        layout: { width: 20, height: 10 },
        children: [leaf("wide", 30, 20)],
      },
      20,
      10,
      measure,
    );
    expect(result.boxes.root).toMatchObject({ width: 20, height: 10 });
    expect(result.overflow).toContain("wide");
  });
  it("stretches a hug cross-axis child but preserves a fixed child", async () => {
    const result = await layoutDesign(
      {
        id: "root",
        type: "column",
        layout: { width: 100, height: 30, alignment: "stretch" },
        children: [
          {
            id: "hug",
            type: "group",
            layout: { width: "hug", height: 10 },
            children: [leaf("dot", 8, 8)],
          },
          leaf("fixed", 20),
        ],
      },
      100,
      30,
      measure,
    );
    expect(result.boxes.hug?.width).toBe(100);
    expect(result.boxes.fixed?.width).toBe(20);
  });
  it("honors bounded intrinsic hug constraints without truncating content", async () => {
    const result = await layoutDesign(
      {
        id: "root",
        type: "column",
        layout: { width: 100, height: 100 },
        children: [
          {
            id: "hug",
            type: "group",
            layout: {
              width: "hug",
              minWidth: 30,
              height: "hug",
              minHeight: 20,
            },
            children: [leaf("small", 8, 8)],
          },
        ],
      },
      100,
      100,
      measure,
    );
    expect(result.boxes.hug).toMatchObject({ width: 30, height: 20 });
    expect(result.boxes.small).toMatchObject({ width: 8, height: 8 });
  });
});
it("composes origin rotation and ancestor placement without changing source rectangles", () => {
  const local = [0, 1, -1, 0, 0, 0] as const;
  const matrix = compose([1, 0, 0, 1, 10, 20], local, { x: 50, y: 50 });
  expect(mapRect({ x: 0, y: 0, width: 100, height: 100 }, matrix)).toEqual({
    x: 10,
    y: 20,
    width: 100,
    height: 100,
  });
});
it("does not invent zero intrinsic height for an unmeasured shape", async () => {
  await expect(
    layoutDesign(
      {
        id: "shape",
        type: "shape",
        shape: "rectangle",
        layout: { width: 20, height: "hug" },
      },
      100,
      100,
      measure,
    ),
  ).rejects.toThrow("intrinsic");
});
it("valid stable IDs do not inherit phantom object-prototype parents", async () => {
  const result = await layoutDesign(leaf("toString", 20), 100, 100, measure);
  expect(result.parents.toString).toBeUndefined();
});
