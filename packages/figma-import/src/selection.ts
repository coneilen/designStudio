import { fail } from "./boundary.js";

export interface FigmaSelection {
  fileKey: string;
  nodeId: string;
}
export function parseFigmaSelection(value: string): FigmaSelection {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    !/^https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[A-Za-z0-9]+\/[^/?#]+(?:\?|$)/.test(
      value,
    )
  )
    fail("INVALID_INPUT", "Invalid Figma selection URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_INPUT", "Invalid Figma selection URL.");
  }
  const route = /^\/(?:design|file)\/([A-Za-z0-9]+)\/[^/]+$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !route?.[1]
  )
    fail(
      "INVALID_INPUT",
      "Expected an explicit supported Figma file/node URL; branch routes are not supported.",
    );
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key) || !["node-id", "t", "p", "m"].includes(key))
      fail("INVALID_INPUT", "Ambiguous or unsupported selection parameter.");
    seen.add(key);
  }
  const node = url.searchParams.get("node-id");
  if (!node)
    fail("NODE_SELECTION_REQUIRED", "An explicit Figma node is required.");
  if (!/^[0-9]+[-:][0-9]+$/.test(node) || node.length > 160)
    fail("INVALID_INPUT", "Invalid Figma node ID.");
  return { fileKey: route[1], nodeId: node.replace("-", ":") };
}
