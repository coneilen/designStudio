import {
  type ContractCatalog,
  type DesignNode,
  type Diagnostic,
  type ErrorCode,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest } from "./canonical.js";

export class KernelError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(code: ErrorCode, message: string, nodeIds: string[] = []) {
    super(message);
    this.name = "KernelError";
    this.diagnostic = diagnostic(code, message, "error", nodeIds);
  }
}

export function diagnostic(
  code: ErrorCode,
  message: string,
  severity: Diagnostic["severity"] = "error",
  nodeIds: string[] = [],
): Diagnostic {
  return {
    schemaVersion: "1.0",
    id: `diag_${canonicalDigest({ code, message, nodeIds }).slice(0, 24)}`,
    code,
    message,
    severity,
    nodeIds,
    evidenceIds: [],
    operations: ["resolve"],
    recovery:
      "Correct or explicitly review the pinned input; do not substitute a fallback.",
  };
}

export function fail(
  code: ErrorCode,
  message: string,
  nodeIds: string[] = [],
): never {
  throw new KernelError(code, message, nodeIds);
}

export function limitFail(
  code: "NODE_LIMIT" | "DEPTH_LIMIT",
  measured: number,
  allowed: number,
): never {
  const error = new KernelError(
    code,
    `${code === "NODE_LIMIT" ? "Node count" : "Depth"} ${measured} exceeds ${allowed}`,
  );
  error.diagnostic.limit = {
    measured,
    allowed,
    unit: code === "NODE_LIMIT" ? "node" : "depth",
  };
  throw error;
}

export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function shape<K extends keyof ContractCatalog>(
  name: K,
  value: unknown,
): ContractCatalog[K] {
  const result = validateContract(name, value);
  if (!result.success)
    fail("INVALID_SCHEMA", `${name}: ${JSON.stringify(result.issues)}`);
  return result.value;
}

export function unique<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (map.has(id)) fail("RESOURCE_UNRESOLVED", `Duplicate ${label}: ${id}`);
    map.set(id, item);
  }
  return map;
}

export function childNodes(node: DesignNode): DesignNode[] {
  if ("children" in node) return node.children;
  if (node.type === "component")
    return [
      ...Object.values(node.slots).flat(),
      ...(node.snapshotExpansion ? [node.snapshotExpansion.root] : []),
    ];
  return [];
}

export function indexNodes(
  root: DesignNode,
  maxNodes = 20_000,
  maxDepth = 128,
): Map<string, DesignNode> {
  const result = new Map<string, DesignNode>();
  const visit = (node: DesignNode, depth: number) => {
    if (depth > maxDepth) limitFail("DEPTH_LIMIT", depth, maxDepth);
    if (result.has(node.id))
      fail("DUPLICATE_NODE_ID", `Duplicate node identity: ${node.id}`, [
        node.id,
      ]);
    if (result.size >= maxNodes)
      limitFail("NODE_LIMIT", result.size + 1, maxNodes);
    result.set(node.id, node);
    for (const child of childNodes(node)) visit(child, depth + 1);
  };
  visit(root, 1);
  return result;
}
