import {
  type Bounds,
  type JsonObject,
  type JsonValue,
  parseContract,
} from "@design-studio/contracts";
import {
  escapePointer,
  FigmaImportError,
  fail,
  type limits,
  numeric,
  object,
  string,
} from "./boundary.js";

export interface SourceNode {
  id: string;
  type: string;
  pointer: string;
  raw: JsonObject;
  bounds?: Bounds;
  children: SourceNode[];
}
export function sourceBounds(value: JsonValue | undefined): Bounds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { x, y, width, height } = value;
  if (
    !numeric(x) ||
    !numeric(y) ||
    !numeric(width) ||
    !numeric(height) ||
    width < 0 ||
    height < 0
  )
    return undefined;
  return { x, y, width, height, unit: "design-unit" };
}
export function parseSource(
  bytes: Uint8Array,
  nodeId: string,
  budget: ReturnType<typeof limits>,
) {
  budget.checkpoint();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_INPUT", "Source must be UTF-8.");
  }
  const envelope = object(
    parseContract("JsonObject", text, "json", {
      maxInputBytes: budget.maxInputBytes,
    }),
    "",
  );
  budget.checkpoint();
  const nodes = object(envelope.nodes, "/nodes");
  if (Object.keys(nodes).length !== 1 || !Object.hasOwn(nodes, nodeId))
    fail(
      "INVALID_INPUT",
      "The package must contain exactly the explicitly selected subtree.",
      "/nodes",
    );
  const selectedPointer = `/nodes/${escapePointer(nodeId)}`;
  const selected = nodes[nodeId];
  if (selected === null) return { envelope, root: undefined, selectedPointer };
  const entry = object(selected, selectedPointer);
  const all: SourceNode[] = [];
  const ids = new Set<string>();
  function visit(
    value: JsonValue | undefined,
    pointer: string,
    depth: number,
  ): SourceNode {
    budget.checkpoint();
    if (depth > budget.maxDepth)
      throw new FigmaImportError(
        "DEPTH_LIMIT",
        "Source tree exceeds depth budget.",
        pointer,
        { measured: depth, allowed: budget.maxDepth, unit: "depth" },
      );
    if (all.length >= budget.maxNodes)
      throw new FigmaImportError(
        "NODE_LIMIT",
        "Source tree exceeds node budget.",
        pointer,
        { measured: all.length + 1, allowed: budget.maxNodes, unit: "node" },
      );
    const raw = object(value, pointer);
    const id = string(raw.id, `${pointer}/id`);
    const type = string(raw.type, `${pointer}/type`);
    if (ids.has(id))
      fail(
        "DUPLICATE_NODE_ID",
        "Duplicate source node identity.",
        `${pointer}/id`,
      );
    ids.add(id);
    if (raw.name !== undefined && typeof raw.name !== "string")
      fail("INVALID_INPUT", "Invalid source name.", `${pointer}/name`);
    const bounds = sourceBounds(raw.absoluteBoundingBox);
    const node: SourceNode = {
      id,
      type,
      pointer,
      raw,
      children: [],
      ...(bounds ? { bounds } : {}),
    };
    all.push(node);
    if (raw.children !== undefined) {
      if (!Array.isArray(raw.children))
        fail(
          "INVALID_INPUT",
          "Invalid source children.",
          `${pointer}/children`,
        );
      if (
        raw.children.length &&
        ["TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "LINE"].includes(type)
      )
        fail(
          "INVALID_INPUT",
          "A source leaf cannot contain child nodes.",
          `${pointer}/children`,
        );
      node.children = raw.children.map((child, index) =>
        visit(child, `${pointer}/children/${index}`, depth + 1),
      );
    } else if (
      ["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(
        type,
      )
    ) {
      fail(
        "EVIDENCE_MISSING",
        "Container children are absent; source may be truncated.",
        `${pointer}/children`,
      );
    }
    return node;
  }
  const root = visit(entry.document, `${selectedPointer}/document`, 1);
  if (root.id !== nodeId)
    fail(
      "INVALID_INPUT",
      "Selected document ID does not match the requested node.",
      `${root.pointer}/id`,
    );
  return { envelope, root, selectedPointer };
}
