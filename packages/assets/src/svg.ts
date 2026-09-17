import type { Budget } from "@design-studio/contracts";
import sax from "sax";
import { bound, fail, inputLimit, sha256 } from "./core.js";

const elements = new Set([
  "svg",
  "g",
  "title",
  "rect",
  "circle",
  "ellipse",
  "line",
]);
const numbers = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "stroke-width",
]);
const nonnegative = new Set([
  "width",
  "height",
  "rx",
  "ry",
  "r",
  "stroke-width",
]);
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function sanitizeSvg(bytes: Uint8Array, limits: Budget) {
  inputLimit(bytes, limits);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("SVG_MALFORMED", "SVG must be UTF-8");
  }
  if (/<!|&|<\?/u.test(text))
    fail(
      "SVG_UNSUPPORTED",
      "Declarations, entities, comments, CDATA and processing instructions are outside the safe profile",
    );
  let depth = 0;
  let nodes = 0;
  let roots = 0;
  let width = 0;
  let height = 0;
  const output: string[] = [];
  let outputBytes = 0;
  const append = (value: string) => {
    const length = Buffer.byteLength(value);
    bound("OUTPUT_BYTES", outputBytes + length, limits.maxOutputBytes);
    outputBytes += length;
    output.push(value);
  };
  const ancestry: string[] = [];
  const parser = sax.parser(true, { xmlns: true });
  parser.onerror = () => fail("SVG_MALFORMED", "Malformed XML");
  parser.ontext = (value) => {
    if (ancestry.at(-1) === "title") {
      let length = Buffer.byteLength(value);
      for (const character of value) {
        if (character === "&") length += 4;
        else if (character === '"') length += 5;
        else if (character === "<" || character === ">") length += 3;
      }
      bound("OUTPUT_BYTES", outputBytes + length, limits.maxOutputBytes);
      append(escapeXml(value));
    } else if (value.trim())
      fail("SVG_UNSUPPORTED", "Text nodes require the font-aware renderer");
  };
  parser.onopentag = (node) => {
    const parent = ancestry.at(-1);
    if (parent !== undefined && parent !== "svg" && parent !== "g")
      fail("SVG_UNSUPPORTED", "Only svg and g may contain child elements");
    if (depth === 0 && ++roots > 1)
      fail("SVG_MALFORMED", "Exactly one root element is required");
    bound("SVG_DEPTH", ++depth, limits.maxDepth);
    bound("SVG_NODES", ++nodes, limits.maxExpandedNodes);
    if (
      !("uri" in node) ||
      !elements.has(node.name) ||
      node.prefix ||
      node.uri !== "http://www.w3.org/2000/svg" ||
      (depth === 1 ? node.name !== "svg" : node.name === "svg")
    )
      fail("SVG_UNSUPPORTED", "Unsupported element or namespace");
    ancestry.push(node.name);
    const attrs: string[] = [];
    for (const [name, attribute] of Object.entries(node.attributes).sort(
      ([a], [b]) => a.localeCompare(b, "en"),
    )) {
      if (typeof attribute === "string")
        fail("SVG_MALFORMED", "Namespace parser required");
      const value = attribute.value;
      if (value.length > 256)
        fail(
          "SVG_UNSUPPORTED",
          "Attribute values exceed the bounded geometry profile",
        );
      if (
        name === "xmlns" &&
        depth === 1 &&
        value === "http://www.w3.org/2000/svg"
      ) {
        attrs.push(`xmlns="${value}"`);
        continue;
      }
      let valid = false;
      if (numbers.has(name))
        valid =
          numeric.test(value) &&
          Number.isFinite(Number(value)) &&
          Math.abs(Number(value)) <= 1_000_000 &&
          (!nonnegative.has(name) || Number(value) >= 0);
      else if (name === "fill" || name === "stroke")
        valid = /^(?:none|#[\da-fA-F]{6}|#[\da-fA-F]{3})$/u.test(value);
      else if (
        name === "opacity" ||
        name === "fill-opacity" ||
        name === "stroke-opacity"
      )
        valid = numeric.test(value) && Number(value) >= 0 && Number(value) <= 1;
      else if (name === "viewBox")
        valid =
          value.trim().split(/[\s,]+/u).length === 4 &&
          value
            .trim()
            .split(/[\s,]+/u)
            .every(
              (v) => numeric.test(v) && Math.abs(Number(v)) <= 1_000_000,
            ) &&
          value
            .trim()
            .split(/[\s,]+/u)
            .slice(2)
            .every((v) => Number(v) > 0);
      else if (name === "fill-rule")
        valid = value === "nonzero" || value === "evenodd";
      if (!valid)
        fail(
          "SVG_UNSUPPORTED",
          "Unsupported attribute or value; no active or external references are permitted",
        );
      if (depth === 1 && name === "width") width = Number(value);
      if (depth === 1 && name === "height") height = Number(value);
      attrs.push(`${name}="${escapeXml(value)}"`);
    }
    append(`<${node.name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
  };
  parser.onclosetag = (name) => {
    append(`</${name}>`);
    depth--;
    ancestry.pop();
  };
  parser.write(text).close();
  if (
    roots !== 1 ||
    depth !== 0 ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  )
    fail(
      "SVG_UNSUPPORTED",
      "One complete root with positive explicit integer width and height is required",
    );
  bound(
    "RASTER_PIXELS",
    Math.ceil(width) * Math.ceil(height),
    limits.maxRasterPixels,
  );
  const derivative = Buffer.from(output.join(""));
  bound("OUTPUT_BYTES", derivative.byteLength, limits.maxOutputBytes);
  return {
    bytes: derivative,
    sha256: sha256(derivative),
    derivativeOf: sha256(bytes),
    width,
    height,
    profile: "static-svg-v1" as const,
  };
}
