import type {
  DesignNode,
  Paint,
  TextNode,
  Typography,
} from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import { children, type LayoutResult, scalar } from "./layout.js";
import type { PreparedFont, PreparedImage } from "./resources.js";

export const CSP =
  "default-src 'none'; script-src 'none'; style-src 'nonce-renderer-style'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";
export function escapeText(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}
export function color(value: Paint | undefined): string {
  if (!value) return "transparent";
  if (!("space" in value))
    throw new HostBoundaryError(
      "RESOURCE_UNRESOLVED",
      "Unresolved paint token.",
    );
  return `rgba(${value.r * 255},${value.g * 255},${value.b * 255},${value.a})`;
}
export function typography(style: Typography, fonts: PreparedFont[]): string {
  const font = fonts.find((f) => f.id === style.fontId);
  if (!font || style.fontWeight !== font.face.weight)
    throw new HostBoundaryError(
      "FONT_MISSING",
      "Missing exact requested face.",
    );
  return `font-family:f_${font.face.sha256};font-size:${scalar(style.fontSize)}px;font-weight:${style.fontWeight};font-style:normal;line-height:${scalar(style.lineHeight)}px;letter-spacing:${scalar(style.letterSpacing)}px;color:${color(style.color)};text-align:${style.alignment};white-space:${style.wrap === "wrap" ? "pre-wrap" : "pre"};overflow-wrap:normal;word-break:normal;hyphens:none`;
}
export interface TextRun {
  id: string;
  font: PreparedFont;
  content: string;
  owner: string;
}
export function textMarkup(
  node: TextNode,
  fonts: PreparedFont[],
  css: string[],
  runs: TextRun[],
  prefix: string,
): string {
  const result: string[] = [];
  const emit = (text: string, style: Typography) => {
    if (!text) return;
    const id = `${prefix}t${runs.length}`;
    const font = fonts.find((f) => f.id === style.fontId);
    if (!font) throw new HostBoundaryError("FONT_MISSING", "Missing run face.");
    css.push(`#${id}{${typography(style, fonts)}}`);
    runs.push({ id, font, content: text, owner: node.id });
    result.push(`<span id="${id}">${escapeText(text)}</span>`);
  };
  let cursor = 0;
  for (const range of node.styledRanges ?? []) {
    emit(node.content.slice(cursor, range.start), node.typography);
    emit(node.content.slice(range.start, range.end), range.typography);
    cursor = range.end;
  }
  emit(node.content.slice(cursor), node.typography);
  return result.join("");
}
export function fontStyles(fonts: PreparedFont[]): string {
  return fonts
    .map(
      (f) =>
        `@font-face{font-family:f_${f.face.sha256};src:url(data:font/ttf;base64,${f.bytes});font-weight:400;font-style:normal;font-display:block}`,
    )
    .join("\n");
}
export function shell(body: string, css: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style nonce="renderer-style">*{box-sizing:border-box;animation:none!important;transition:none!important;caret-color:transparent!important;font-synthesis:none!important}html,body{margin:0;padding:0;overflow:hidden;background:white} ${css}</style></head><body>${body}</body></html>`;
}
export function compileDocument(
  root: DesignNode,
  layout: LayoutResult,
  fonts: PreparedFont[],
  images: PreparedImage[],
  captureOffset = { x: 0, y: 0 },
) {
  const css: string[] = [fontStyles(fonts)];
  const runs: TextRun[] = [];
  const elements: { id: string; node: DesignNode }[] = [];
  function emit(node: DesignNode): string {
    const id = `n${elements.length}`;
    elements.push({ id, node });
    const box = layout.boxes[node.id];
    if (!box)
      throw new HostBoundaryError(
        "INVALID_LAYOUT",
        "Missing allocated geometry.",
      );
    const a = "appearance" in node ? node.appearance : undefined;
    if (a?.blur)
      throw new HostBoundaryError(
        "UNSUPPORTED_FEATURE",
        "Blur is outside the static profile.",
      );
    const transform = "transform" in node ? node.transform : undefined;
    const rules = [
      "position:absolute",
      `left:${box.x}px`,
      `top:${box.y}px`,
      `width:${box.width}px`,
      `height:${box.height}px`,
      `background:${color(a?.fill)}`,
      `opacity:${a?.opacity ?? 1}`,
      `border-radius:${scalar(a?.radius)}px`,
      "margin:0;padding:0;border:0",
    ];
    // Paint borders with an inset shadow: IR padding/child coordinates are not CSS border-box offsets.
    const shadows: string[] = [];
    if (a?.border)
      shadows.push(
        `inset 0 0 0 ${scalar(a.border.width)}px ${color(a.border.color)}`,
      );
    if (a?.shadow) {
      if ("token" in a.shadow)
        throw new HostBoundaryError(
          "RESOURCE_UNRESOLVED",
          "Unresolved shadow.",
        );
      shadows.push(
        `${a.shadow.offset.x}px ${a.shadow.offset.y}px ${scalar(a.shadow.blur)}px ${scalar(a.shadow.spread)}px ${color(a.shadow.color)}`,
      );
    }
    if (shadows.length) rules.push(`box-shadow:${shadows.join(",")}`);
    if (transform)
      rules.push(
        `transform:matrix(${transform.matrix.join(",")})`,
        `transform-origin:${transform.origin.x}px ${transform.origin.y}px`,
      );
    if (a?.clip && a.clip.kind !== "none") {
      rules.push("overflow:hidden");
      if (a.clip.kind === "rounded-bounds")
        rules.push(`border-radius:${scalar(a.clip.radius)}px`);
    }
    if (node.type === "shape") {
      if (node.shape === "ellipse") rules.push("border-radius:50%");
      else if (node.shape !== "rectangle")
        throw new HostBoundaryError(
          "UNSUPPORTED_FEATURE",
          "Unsupported shape.",
        );
    }
    let content = "";
    if (node.type === "text") {
      rules.push(typography(node.typography, fonts));
      const p = node.layout.padding;
      rules.push(
        `padding:${scalar(p?.top)}px ${scalar(p?.right)}px ${scalar(p?.bottom)}px ${scalar(p?.left)}px`,
      );
      content = textMarkup(node, fonts, css, runs, "r");
    } else if (node.type === "image" || node.type === "icon") {
      const image = images.find((x) => x.id === node.assetId);
      if (!image)
        throw new HostBoundaryError(
          "ASSET_INVALID",
          "Image bytes are missing.",
        );
      const crop = node.crop ?? {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      };
      const sx = box.width / crop.width,
        sy = box.height / crop.height;
      const scale = node.fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
      const iw =
        image.width * (node.fit === "crop" || node.fit === "fill" ? sx : scale);
      const ih =
        image.height *
        (node.fit === "crop" || node.fit === "fill" ? sy : scale);
      const left = node.fit === "crop" ? -crop.x * sx : (box.width - iw) / 2;
      const top = node.fit === "crop" ? -crop.y * sy : (box.height - ih) / 2;
      if (![iw, ih, left, top].every(Number.isFinite))
        throw new HostBoundaryError(
          "INVALID_LAYOUT",
          "Invalid image fit dimensions.",
        );
      css.push(
        `#${id} img{position:absolute;left:${left}px;top:${top}px;width:${iw}px;height:${ih}px;max-width:none}`,
      );
      if (node.assetTransform)
        css.push(
          `#${id} img{transform:matrix(${node.assetTransform.matrix.join(",")});transform-origin:${node.assetTransform.origin.x}px ${node.assetTransform.origin.y}px}`,
        );
      rules.push("overflow:hidden");
      content = `<img alt="" src="data:${image.mediaType};base64,${image.bytes}">`;
    } else if (node.type === "unsupported") {
      rules.push(
        "background:repeating-linear-gradient(45deg,#ddd 0px,#ddd 4px,#fff 4px,#fff 8px)",
        "outline:2px dashed #a00",
      );
      const font = fonts[0];
      if (!font)
        throw new HostBoundaryError(
          "FONT_MISSING",
          "Inspection marker requires a verified face.",
        );
      const marker: TextNode = {
        id: node.id,
        type: "text",
        indexing: "utf-16",
        content: "Unsupported",
        layout: node.layout,
        typography: {
          fontId: font.id,
          fontWeight: 400,
          fontSize: 12,
          lineHeight: 16,
          letterSpacing: 0,
          alignment: "start",
          wrap: "no-wrap",
          color: { space: "srgb", r: 0.5, g: 0, b: 0, a: 1 },
        },
      };
      content = textMarkup(marker, fonts, css, runs, "r");
      rules.push("overflow:hidden");
    } else if (node.type === "component")
      throw new HostBoundaryError(
        "RESOURCE_UNRESOLVED",
        "Unexpanded component.",
      );
    else {
      content = children(node).map(emit).join("");
      if (node.type === "scroll") {
        rules.push("overflow:hidden");
        css.push(
          `#${id}s{position:absolute;left:${-node.scroll.captureOffset.x}px;top:${-node.scroll.captureOffset.y}px;width:${node.scroll.contentBounds.width}px;height:${node.scroll.contentBounds.height}px}`,
        );
        content = `<div id="${id}s">${content}</div>`;
      }
    }
    css.push(`#${id}{${rules.join(";")}}`);
    return `<div id="${id}" data-node="${escapeText(node.id)}">${content}</div>`;
  }
  const body = `<div id="capture-origin">${emit(root)}</div>`;
  css.push(
    `#capture-origin{position:absolute;left:${-captureOffset.x}px;top:${-captureOffset.y}px}`,
  );
  return { html: shell(body, css.join("\n")), elements, runs };
}
