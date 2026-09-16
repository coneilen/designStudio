import type { DesignNode } from "@design-studio/contracts";
import { canonicalDigest } from "./canonical.js";
import { childNodes, fail, indexNodes, shape } from "./shared.js";

/** Hashes identity coordinates, never labels, array indices, revisions or visual content. */
export function namespaceId(
  instanceId: string,
  path: readonly string[],
): string {
  shape("StableId", instanceId);
  for (const segment of path) shape("StableId", segment);
  return `instance_${canonicalDigest(["design-ir-instance-v1", instanceId, ...path])}`;
}

export function copyNode(
  root: DesignNode,
  allocateId: (oldId: string) => string,
): {
  node: DesignNode;
  identities: ReadonlyMap<string, string>;
} {
  const existing = indexNodes(root);
  const allocated = new Set<string>();
  const identities = new Map<string, string>();
  const node = structuredClone(root);
  function visit(current: DesignNode) {
    const next = shape("StableId", allocateId(current.id));
    if (existing.has(next) || allocated.has(next))
      fail("DUPLICATE_NODE_ID", `Copy must allocate fresh identity: ${next}`);
    allocated.add(next);
    identities.set(current.id, next);
    current.id = next;
    for (const child of childNodes(current)) visit(child);
  }
  visit(node);
  return { node, identities };
}

export interface SourceIdentityKey {
  adapter: string;
  document: string;
  branch?: string;
  sourceNodeId: string;
}

export interface SourceIdentityMapping extends SourceIdentityKey {
  nodeId: string;
  acceptedSnapshotId?: string;
}

export function reconcileIdentity(
  persisted: readonly SourceIdentityMapping[],
  source: SourceIdentityKey,
  candidates: readonly string[],
):
  | { status: "retained"; nodeId: string }
  | { status: "proposal"; candidates: string[] } {
  const key = (item: SourceIdentityKey) =>
    canonicalDigest([
      item.adapter,
      item.document,
      item.branch ?? null,
      item.sourceNodeId,
    ]);
  const mappings = new Map<string, string>();
  for (const item of persisted) {
    const id = key(item);
    if (mappings.has(id) && mappings.get(id) !== item.nodeId)
      fail("CONFLICT", "Conflicting persisted source identities");
    mappings.set(id, item.nodeId);
  }
  const retained = mappings.get(key(source));
  return retained
    ? { status: "retained", nodeId: retained }
    : { status: "proposal", candidates: [...new Set(candidates)].sort() };
}
