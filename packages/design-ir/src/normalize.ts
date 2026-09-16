import type {
  DesignIR,
  DesignNode,
  Diagnostic,
  Insets,
  ResourceSnapshot,
  Typography,
} from "@design-studio/contracts";
import { diagnostic, fail, indexNodes, unique } from "./shared.js";
import type { ValueResolver } from "./tokens.js";

export interface ResourceUsage {
  tokens: Set<string>;
  assets: Set<string>;
  fonts: Set<string>;
}

export function normalizeDesign(
  input: DesignIR,
  resources: ResourceSnapshot,
  resolver: ValueResolver,
  usage: ResourceUsage,
): { design: DesignIR; diagnostics: Diagnostic[] } {
  const design = structuredClone(input);
  const diagnostics: Diagnostic[] = [];
  const fonts = unique(resources.fonts, (x) => x.id, "font");
  const assets = unique(resources.assets, (x) => x.id, "asset");
  const insets = (value?: Insets): Insets => ({
    top: resolver.dimension(value?.top ?? 0),
    right: resolver.dimension(value?.right ?? 0),
    bottom: resolver.dimension(value?.bottom ?? 0),
    left: resolver.dimension(value?.left ?? 0),
  });
  function font(typography: Typography, nodeId: string): Typography {
    const resolved = resolver.typography(typography);
    const resource = fonts.get(resolved.fontId);
    usage.fonts.add(resolved.fontId);
    if (
      !resource ||
      (resource.kind === "bundled"
        ? resource.availability === "missing"
        : resource.verification === "missing" ||
          resource.verification === "mismatch")
    )
      fail("FONT_MISSING", `Missing declared font ${resolved.fontId}`, [
        nodeId,
      ]);
    if (resource.weight !== resolved.fontWeight)
      fail(
        "FONT_FALLBACK",
        `Declared font ${resolved.fontId} does not supply weight ${resolved.fontWeight}`,
        [nodeId],
      );
    if (resource.glyphCoverage === "missing-glyphs")
      fail("FONT_FALLBACK", `Font has missing glyphs: ${resolved.fontId}`, [
        nodeId,
      ]);
    return resolved;
  }
  function normalize(node: DesignNode, parentBounded: [boolean, boolean]) {
    const layout = node.layout;
    layout.padding = insets(layout.padding);
    layout.margin = insets(layout.margin);
    layout.spacing = resolver.dimension(layout.spacing ?? 0);
    layout.alignment ??= "start";
    layout.distribution ??= "start";
    layout.position ??= "flow";
    layout.offset ??= { x: 0, y: 0 };
    const bounded: [boolean, boolean] = [false, false];
    for (const [axis, minimum, maximum, index] of [
      ["width", "minWidth", "maxWidth", 0],
      ["height", "minHeight", "maxHeight", 1],
    ] as const) {
      const size = layout[axis];
      if (typeof size !== "string") layout[axis] = resolver.dimension(size);
      const min = layout[minimum];
      const max = layout[maximum];
      if (min !== undefined) layout[minimum] = resolver.dimension(min);
      if (max !== undefined) layout[maximum] = resolver.dimension(max);
      const lower = layout[minimum];
      const upper = layout[maximum];
      const fixed = layout[axis];
      if (
        (typeof lower === "number" &&
          typeof upper === "number" &&
          lower > upper) ||
        (typeof fixed === "number" &&
          ((typeof lower === "number" && fixed < lower) ||
            (typeof upper === "number" && fixed > upper)))
      )
        fail("INVALID_LAYOUT", `Contradictory ${axis} bounds for ${node.id}`, [
          node.id,
        ]);
      bounded[index] =
        typeof fixed === "number" ||
        typeof upper === "number" ||
        (fixed === "fill" && parentBounded[index]);
      if (fixed === "fill" && !bounded[index])
        fail(
          "INVALID_LAYOUT",
          `Unbounded ${axis} fill dependency at ${node.id}`,
          [node.id],
        );
    }
    if (
      layout.aspectRatio !== undefined &&
      typeof layout.width === "number" &&
      typeof layout.height === "number" &&
      layout.width !== layout.height * layout.aspectRatio
    )
      fail(
        "INVALID_LAYOUT",
        `Fixed dimensions contradict aspect ratio for ${node.id}`,
        [node.id],
      );
    if (node.type === "frame" && node.flow === undefined)
      fail("INVALID_LAYOUT", `Frame must declare flow: ${node.id}`, [node.id]);
    if ("flow" in node && node.type !== "frame" && node.flow !== undefined) {
      const expected =
        node.type === "row"
          ? "horizontal"
          : node.type === "column"
            ? "vertical"
            : node.type === "stack"
              ? "absolute"
              : undefined;
      if (node.flow !== expected)
        fail("INVALID_LAYOUT", `Conflicting intrinsic flow for ${node.type}`, [
          node.id,
        ]);
    }
    node.transform ??= { matrix: [1, 0, 0, 1, 0, 0], origin: { x: 0, y: 0 } };
    if (node.type !== "unsupported") {
      node.appearance ??= {};
      const appearance = node.appearance;
      appearance.radius = resolver.dimension(appearance.radius ?? 0);
      appearance.opacity ??= 1;
      appearance.clip ??= { kind: "none" };
      if (appearance.clip.radius !== undefined)
        appearance.clip.radius = resolver.dimension(appearance.clip.radius);
      if (appearance.fill) appearance.fill = resolver.paint(appearance.fill);
      if (appearance.border)
        appearance.border = {
          width: resolver.dimension(appearance.border.width),
          color: resolver.paint(appearance.border.color),
        };
      if (appearance.shadow) {
        if ("token" in appearance.shadow) {
          const resolved = resolver.value(appearance.shadow.token, "shadow");
          if (resolved.type !== "shadow")
            fail("TOKEN_TYPE_MISMATCH", "Expected shadow token");
          appearance.shadow = resolver.shadow(resolved.value);
        } else appearance.shadow = resolver.shadow(appearance.shadow);
      }
      if (appearance.blur !== undefined) {
        appearance.blur = resolver.dimension(appearance.blur);
        if (appearance.blur !== 0)
          diagnostics.push(
            diagnostic(
              "UNSUPPORTED_FEATURE",
              "Blur has no verified M1 rendering support",
              "error",
              [node.id],
            ),
          );
      }
    }
    if (node.type === "unsupported") {
      diagnostics.push(
        diagnostic(
          "UNSUPPORTED_FEATURE",
          `${node.feature}: ${node.reason}`,
          "error",
          [node.id],
        ),
      );
      if (node.evidenceStatus === "missing" || !node.metadata?.rawSource)
        diagnostics.push(
          diagnostic(
            "EVIDENCE_MISSING",
            "Unsupported node has no preserved raw evidence",
            "error",
            [node.id],
          ),
        );
      if (node.inspectionCrop) {
        usage.assets.add(node.inspectionCrop.assetId);
        if (!assets.has(node.inspectionCrop.assetId))
          fail(
            "RESOURCE_UNRESOLVED",
            `Missing inspection asset ${node.inspectionCrop.assetId}`,
          );
      }
    }
    if (node.type === "text") {
      node.typography = font(node.typography, node.id);
      let end = 0;
      const boundary = (offset: number) => {
        const before = node.content.charCodeAt(offset - 1);
        const after = node.content.charCodeAt(offset);
        return !(
          before >= 0xd800 &&
          before <= 0xdbff &&
          after >= 0xdc00 &&
          after <= 0xdfff
        );
      };
      for (const range of node.styledRanges ?? []) {
        if (
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < end ||
          range.start >= range.end ||
          range.end > node.content.length ||
          !boundary(range.start) ||
          !boundary(range.end)
        )
          fail(
            "INVALID_LAYOUT",
            `Invalid ordered nonoverlapping UTF-16 range for ${node.id}`,
            [node.id],
          );
        range.typography = font(range.typography, node.id);
        end = range.end;
      }
    }
    if (node.type === "image" || node.type === "icon") {
      usage.assets.add(node.assetId);
      const asset = assets.get(node.assetId);
      if (!asset || asset.verification === "rejected")
        fail("RESOURCE_UNRESOLVED", `Missing/rejected asset ${node.assetId}`, [
          node.id,
        ]);
      if (node.fit === "crop" && !node.crop)
        fail("ASSET_INVALID", `Crop fit requires a source-pixel rectangle`, [
          node.id,
        ]);
      if (
        node.crop &&
        (node.crop.unit !== "pixel" ||
          node.crop.x < 0 ||
          node.crop.y < 0 ||
          node.crop.x + node.crop.width > asset.width ||
          node.crop.y + node.crop.height > asset.height)
      )
        fail(
          "ASSET_INVALID",
          `Crop exceeds declared source-pixel bounds: ${node.assetId}`,
          [node.id],
        );
    }
    if (node.type === "scroll") {
      const {
        viewportBounds: viewport,
        contentBounds: content,
        captureOffset: offset,
      } = node.scroll;
      if (
        viewport.unit !== "design-unit" ||
        content.unit !== "design-unit" ||
        content.width < viewport.width ||
        content.height < viewport.height ||
        offset.x < 0 ||
        offset.y < 0 ||
        offset.x > content.width - viewport.width ||
        offset.y > content.height - viewport.height
      )
        fail(
          "INVALID_LAYOUT",
          `Invalid scroll viewport/content/capture offset for ${node.id}`,
          [node.id],
        );
      if (
        (typeof layout.width === "number" && layout.width !== viewport.width) ||
        (typeof layout.height === "number" && layout.height !== viewport.height)
      )
        fail(
          "INVALID_LAYOUT",
          `Scroll layout disagrees with its viewport: ${node.id}`,
          [node.id],
        );
    }
    if (
      "behavior" in node &&
      node.behavior?.critical &&
      node.behavior.status !== "reviewed"
    )
      diagnostics.push(
        diagnostic(
          "BEHAVIOR_UNRESOLVED",
          "Critical behavior needs independent review",
          "warning",
          [node.id],
        ),
      );
    if ("children" in node) {
      for (const child of node.children)
        normalize(child, node.type === "scroll" ? [true, true] : bounded);
    }
  }
  indexNodes(design.root);
  normalize(design.root, [true, true]);
  diagnostics.push(
    diagnostic(
      "VALIDATION_INCONCLUSIVE",
      "Intrinsic text metrics, arranged/transform-aware overflow, asset decoding and actual font use are not measured by the semantic kernel.",
      "info",
    ),
  );
  return { design, diagnostics };
}
