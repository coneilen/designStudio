import type { DesignNode, Dimension, TextNode } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import type { Rect } from "./geometry.js";

export interface Size {
  width: number;
  height: number;
}
export interface TextMeasurement extends Size {
  left?: number;
  right?: number;
}
export interface TextExcess {
  width: number;
  height: number;
  left: number;
  right: number;
  allocatedWidth: number;
  allocatedHeight: number;
  clipped: boolean;
}
export interface LayoutResult {
  boxes: Record<string, Rect>;
  parents: Record<string, string>;
  overflow: string[];
  textExcess: Record<string, TextExcess>;
}
export type TextMeasure = (
  node: TextNode,
  width?: number,
) => Promise<TextMeasurement>;
export function children(node: DesignNode): DesignNode[] {
  return "children" in node ? node.children : [];
}
export function scalar(value: Dimension | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new HostBoundaryError(
      "INVALID_LAYOUT",
      "Unresolved numeric layout value.",
    );
  return value;
}
function error(message: string): never {
  throw new HostBoundaryError("INVALID_LAYOUT", message);
}
const horizontal = (n: DesignNode) =>
  n.type === "row" || (n.type === "frame" && n.flow === "horizontal");
const vertical = (n: DesignNode) =>
  n.type === "column" || (n.type === "frame" && n.flow === "vertical");
function insets(node: DesignNode, kind: "padding" | "margin") {
  const v = node.layout[kind];
  return {
    left: scalar(v?.left),
    right: scalar(v?.right),
    top: scalar(v?.top),
    bottom: scalar(v?.bottom),
  };
}
function checked(
  node: DesignNode,
  axis: "width" | "height",
  value: number,
): number {
  const min = scalar(
    axis === "width" ? node.layout.minWidth : node.layout.minHeight,
  );
  const max = scalar(
    axis === "width" ? node.layout.maxWidth : node.layout.maxHeight,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value < min ||
    value > max ||
    value > 1_000_000
  )
    error(`${node.id}: ${axis} constraint is unsatisfiable.`);
  return value;
}
function hug(
  node: DesignNode,
  axis: "width" | "height",
  natural: number,
): number {
  const min = scalar(
    axis === "width" ? node.layout.minWidth : node.layout.minHeight,
  );
  const max = scalar(
    axis === "width" ? node.layout.maxWidth : node.layout.maxHeight,
    Number.MAX_SAFE_INTEGER,
  );
  if (min > max || !Number.isFinite(natural) || natural < 0)
    error(`${node.id}: intrinsic constraint is unsatisfiable.`);
  return checked(node, axis, Math.min(max, Math.max(min, natural)));
}

export async function layoutDesign(
  root: DesignNode,
  viewportWidth: number,
  viewportHeight: number,
  measure: TextMeasure,
): Promise<LayoutResult> {
  const boxes: LayoutResult["boxes"] = Object.create(null);
  const parents: LayoutResult["parents"] = Object.create(null);
  const overflow = new Set<string>();
  const textExcess: LayoutResult["textExcess"] = Object.create(null);
  let visits = 0;
  const checkpoint = () => {
    if (++visits > 160_000) error("Layout dependency work limit exceeded.");
  };
  async function intrinsicWidth(n: DesignNode): Promise<number> {
    checkpoint();
    if (typeof n.layout.width === "number")
      return checked(n, "width", n.layout.width);
    if (n.layout.width === "fill")
      error(`${n.id}: unresolved hug/fill dependency.`);
    const p = insets(n, "padding");
    if (n.type === "text")
      return hug(n, "width", (await measure(n)).width + p.left + p.right);
    const nodes = children(n).filter(
      (c) => c.layout.position !== "absolute" || n.type === "group",
    );
    const widths = await Promise.all(
      nodes.map(async (c) => {
        const m = insets(c, "margin");
        return (
          (await intrinsicWidth(c)) +
          m.left +
          m.right +
          (n.type === "group" ? (c.layout.offset?.x ?? 0) : 0)
        );
      }),
    );
    if (!nodes.length && !("children" in n) && n.type !== "spacer")
      error(
        `${n.id}: intrinsic asset/shape dimensions must be supplied before layout.`,
      );
    return hug(
      n,
      "width",
      p.left +
        p.right +
        (horizontal(n)
          ? widths.reduce((a, b) => a + b, 0) +
            scalar(n.layout.spacing) * Math.max(0, nodes.length - 1)
          : Math.max(0, ...widths)),
    );
  }
  async function arrange(
    n: DesignNode,
    offeredWidth?: number,
    offeredHeight?: number,
    stretch?: "width" | "height",
  ): Promise<Size> {
    checkpoint();
    const p = insets(n, "padding");
    const width = checked(
      n,
      "width",
      typeof n.layout.width === "number"
        ? n.layout.width
        : n.layout.width === "fill" || stretch === "width"
          ? (offeredWidth ?? error(`${n.id}: unbounded width dependency.`))
          : await intrinsicWidth(n),
    );
    const knownHeight =
      typeof n.layout.height === "number"
        ? checked(n, "height", n.layout.height)
        : n.layout.height === "fill" ||
            (stretch === "height" && offeredHeight !== undefined)
          ? checked(
              n,
              "height",
              offeredHeight ?? error(`${n.id}: unbounded height dependency.`),
            )
          : undefined;
    if (
      knownHeight === undefined &&
      !("children" in n) &&
      n.type !== "text" &&
      n.type !== "spacer"
    )
      error(`${n.id}: intrinsic leaf height must be measured before layout.`);
    const cw = width - p.left - p.right;
    const ch =
      knownHeight === undefined ? undefined : knownHeight - p.top - p.bottom;
    if (cw < 0 || (ch !== undefined && ch < 0))
      error(`${n.id}: padding exceeds allocated size.`);
    const nodes = children(n);
    const flow = nodes.filter(
      (c) => c.layout.position !== "absolute" || n.type === "group",
    );
    const main = horizontal(n) ? "width" : "height";
    const linear = horizontal(n) || vertical(n);
    const childStretch =
      n.layout.alignment === "stretch" && linear
        ? horizontal(n)
          ? "height"
          : "width"
        : undefined;
    const gap = scalar(n.layout.spacing);
    const sizes = new Map<string, Size>();
    const available = horizontal(n) ? cw : ch;
    const fills = linear ? flow.filter((c) => c.layout[main] === "fill") : [];
    let used = linear ? gap * Math.max(0, flow.length - 1) : 0;
    for (const c of flow) {
      const m = insets(c, "margin");
      if (linear) used += horizontal(n) ? m.left + m.right : m.top + m.bottom;
      if (fills.includes(c)) continue;
      const size = await arrange(
        c,
        Math.max(0, cw - m.left - m.right),
        ch === undefined ? undefined : Math.max(0, ch - m.top - m.bottom),
        childStretch,
      );
      sizes.set(c.id, size);
      if (linear) used += size[main];
    }
    if (fills.length) {
      if (available === undefined)
        error(`${n.id}: unresolved fill dependency.`);
      const remaining = available - used;
      if (remaining < 0) error(`${n.id}: negative remaining fill space.`);
      const share = remaining / fills.length;
      for (const c of fills) {
        const m = insets(c, "margin");
        sizes.set(
          c.id,
          await arrange(
            c,
            horizontal(n) ? share : Math.max(0, cw - m.left - m.right),
            vertical(n)
              ? share
              : ch === undefined
                ? undefined
                : Math.max(0, ch - m.top - m.bottom),
            childStretch,
          ),
        );
      }
      used = available;
    }
    let contentHeight = 0;
    let measuredText: TextMeasurement | undefined;
    if (n.type === "text") {
      const measured = await measure(n, cw);
      measuredText = measured;
      contentHeight = measured.height;
    } else if (vertical(n)) contentHeight = used;
    else {
      for (const c of flow) {
        const size = sizes.get(c.id);
        if (!size) error("Missing measured child.");
        const m = insets(c, "margin");
        contentHeight = Math.max(
          contentHeight,
          size.height +
            m.top +
            m.bottom +
            (!linear ? (c.layout.offset?.y ?? 0) : 0),
        );
      }
    }
    const height =
      knownHeight ?? hug(n, "height", contentHeight + p.top + p.bottom);
    if (
      n.layout.aspectRatio !== undefined &&
      Math.abs(width - height * n.layout.aspectRatio) > 1 / 64
    )
      error(`${n.id}: aspect ratio constraint is unsatisfiable.`);
    const contentH = height - p.top - p.bottom;
    if (contentH < 0) error(`${n.id}: padding exceeds allocated height.`);
    if (n.type === "text" && measuredText) {
      const left = measuredText.left ?? 0;
      const right = measuredText.right ?? measuredText.width;
      const excess =
        measuredText.width > cw + 1 / 64 ||
        left < -1 / 64 ||
        right > cw + 1 / 64 ||
        contentHeight > contentH + 1 / 64;
      if (excess) {
        const clipped =
          n.appearance?.clip !== undefined && n.appearance.clip.kind !== "none";
        textExcess[n.id] = {
          width: measuredText.width,
          height: measuredText.height,
          left,
          right,
          allocatedWidth: cw,
          allocatedHeight: contentH,
          clipped,
        };
        if (!clipped) overflow.add(n.id);
      }
    }
    const free = (horizontal(n) ? cw : contentH) - used;
    const distribution = n.layout.distribution ?? "start";
    let cursor =
      distribution === "center"
        ? Math.max(0, free) / 2
        : distribution === "end"
          ? Math.max(0, free)
          : 0;
    const actualGap =
      gap +
      (distribution === "space-between" && flow.length > 1
        ? Math.max(0, free) / (flow.length - 1)
        : 0);
    for (const c of nodes) {
      const m = insets(c, "margin");
      let size = sizes.get(c.id);
      if (
        size &&
        childStretch === "height" &&
        typeof c.layout.height !== "number" &&
        knownHeight === undefined
      )
        size = await arrange(
          c,
          size.width,
          Math.max(0, contentH - m.top - m.bottom),
          childStretch,
        );
      if (!size)
        size = await arrange(
          c,
          Math.max(0, cw - m.left - m.right),
          Math.max(0, contentH - m.top - m.bottom),
        );
      const absolute = c.layout.position === "absolute" || !linear;
      let x = p.left + m.left + (c.layout.offset?.x ?? 0);
      let y = p.top + m.top + (c.layout.offset?.y ?? 0);
      if (!absolute) {
        const crossFree = horizontal(n)
          ? contentH - size.height - m.top - m.bottom
          : cw - size.width - m.left - m.right;
        const align = n.layout.alignment ?? "start";
        const shift =
          align === "center" ? crossFree / 2 : align === "end" ? crossFree : 0;
        if (horizontal(n)) {
          x += cursor;
          y += shift;
        } else {
          y += cursor;
          x += shift;
        }
        cursor +=
          size[main] +
          (horizontal(n) ? m.left + m.right : m.top + m.bottom) +
          actualGap;
      }
      boxes[c.id] = { x, y, ...size };
      parents[c.id] = n.id;
      const intentional =
        n.type === "scroll" ||
        ("appearance" in n &&
          n.appearance?.clip &&
          n.appearance.clip.kind !== "none");
      if (
        !intentional &&
        (x < p.left - 1 / 64 ||
          y < p.top - 1 / 64 ||
          x + size.width > width - p.right + 1 / 64 ||
          y + size.height > height - p.bottom + 1 / 64)
      )
        overflow.add(c.id);
    }
    boxes[n.id] = { x: 0, y: 0, width, height };
    return { width, height };
  }
  await arrange(root, viewportWidth, viewportHeight);
  return { boxes, parents, overflow: [...overflow].sort(), textExcess };
}
