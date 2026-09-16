import type {
  DesignIR,
  Diagnostic,
  Evidence,
  JsonValue,
  ProvenanceEntry,
  ProvenanceSnapshot,
} from "@design-studio/contracts";
import { canonicalDigest } from "./canonical.js";
import {
  diagnostic,
  fail,
  indexNodes,
  KernelError,
  own,
  shape,
  unique,
} from "./shared.js";

export function pointerValue(value: unknown, pointer: string): unknown {
  shape("JsonPointer", pointer);
  let current = value;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      fail("EVIDENCE_MISSING", `Unresolved JSON pointer: ${pointer}`);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !("value" in descriptor))
      fail("EVIDENCE_MISSING", `Unresolved JSON pointer: ${pointer}`);
    current = descriptor.value;
  }
  return current;
}

export interface EvidenceResolution {
  evidence: Evidence;
  value: JsonValue;
}

export function validateProvenance(
  design: DesignIR,
  snapshot: ProvenanceSnapshot,
  resolveEvidence?: (evidence: Evidence) => JsonValue,
): Diagnostic[] {
  shape("ProvenanceSnapshot", snapshot);
  const diagnostics: Diagnostic[] = [];
  if (
    snapshot.projectId !== design.projectId ||
    snapshot.designId !== design.designId
  )
    fail("EVIDENCE_MISSING", "Provenance scope differs from design");
  const nodes = indexNodes(design.root);
  const evidence = unique(snapshot.evidence, (x) => x.id, "evidence");
  const evidenceValues = new Map<string, unknown>();
  if (resolveEvidence) {
    for (const source of evidence.values()) {
      const document = resolveEvidence(structuredClone(source));
      evidenceValues.set(
        source.id,
        source.pointer === undefined
          ? document
          : pointerValue(document, source.pointer),
      );
    }
  }
  const current = Object.values(snapshot.nodes).flatMap((properties) =>
    Object.values(properties),
  );
  const entries = unique(
    [...snapshot.history, ...current],
    (x) => x.id,
    "provenance entry",
  );
  for (const entry of entries.values()) {
    for (const id of entry.evidenceIds)
      if (!evidence.has(id))
        fail("EVIDENCE_MISSING", `Missing provenance evidence ${id}`);
    for (const id of entry.supersedes) {
      const old = entries.get(id);
      if (!old) fail("EVIDENCE_MISSING", `Missing superseded entry ${id}`);
      assertAuthority(old, entry);
      if (Date.parse(old.acceptedAt) > Date.parse(entry.acceptedAt))
        fail(
          "CONFLICT",
          "Provenance cannot supersede a later accepted timestamp",
        );
      if (
        old.authority === "exact-source" &&
        entry.authority === "exact-source"
      ) {
        const sourceKeys = (value: ProvenanceEntry) =>
          value.evidenceIds
            .map((id) =>
              resolveEvidence
                ? canonicalDigest(evidenceValues.get(id))
                : canonicalDigest(evidence.get(id)),
            )
            .sort();
        if (
          canonicalDigest(sourceKeys(old)) !==
          canonicalDigest(sourceKeys(entry))
        )
          diagnostics.push(
            diagnostic(
              "CONFLICT",
              `Conflicting exact-source supersession: ${old.id} -> ${entry.id}`,
            ),
          );
      }
    }
  }
  const done = new Set<string>();
  function visit(entry: ProvenanceEntry, active: Set<string>) {
    if (active.has(entry.id))
      fail("DEPENDENCY_CYCLE", "Provenance supersession cycle");
    if (done.has(entry.id)) return;
    if (active.size >= 128)
      fail("DEPTH_LIMIT", "Provenance history depth exceeds 128");
    active.add(entry.id);
    for (const id of entry.supersedes) {
      const old = entries.get(id);
      if (old) visit(old, active);
    }
    active.delete(entry.id);
    done.add(entry.id);
  }
  for (const entry of entries.values()) visit(entry, new Set());
  for (const [nodeId, properties] of Object.entries(snapshot.nodes)) {
    const node = nodes.get(nodeId);
    if (!node)
      fail("EVIDENCE_MISSING", `Provenance targets missing node ${nodeId}`);
    for (const [pointer, entry] of Object.entries(properties)) {
      const actual = pointerValue(node, pointer);
      if (resolveEvidence) {
        const exact: string[] = [];
        for (const id of entry.evidenceIds) {
          const source = evidence.get(id);
          if (!source) fail("EVIDENCE_MISSING", `Missing evidence ${id}`);
          const value = evidenceValues.get(source.id);
          if (entry.authority === "exact-source")
            exact.push(canonicalDigest(value));
        }
        if (new Set(exact).size > 1)
          diagnostics.push(
            diagnostic("CONFLICT", "Conflicting exact source values", "error", [
              nodeId,
            ]),
          );
        if (exact.some((hash) => hash !== canonicalDigest(actual)))
          diagnostics.push(
            diagnostic(
              "CONFLICT",
              `Exact source no longer matches ${pointer}`,
              "error",
              [nodeId],
            ),
          );
      }
    }
  }
  if (!resolveEvidence)
    diagnostics.push(
      diagnostic(
        "VALIDATION_INCONCLUSIVE",
        "Provenance node/pointer/evidence references checked; external evidence bytes and source pointers not supplied.",
        "info",
      ),
    );
  return diagnostics;
}

const rank: Record<ProvenanceEntry["authority"], number> = {
  inferred: 0,
  "exact-source": 1,
  manual: 2,
  "approved-manual": 3,
};

function assertAuthority(
  current: ProvenanceEntry,
  incoming: ProvenanceEntry,
): void {
  if (
    rank[incoming.authority] < rank[current.authority] &&
    !(
      current.authority === "approved-manual" && incoming.authority === "manual"
    )
  )
    fail("CONFLICT", "Lower authority cannot supersede accepted provenance");
}

export function updateProvenance(
  snapshot: ProvenanceSnapshot,
  nodeId: string,
  pointer: string,
  incoming: ProvenanceEntry,
): ProvenanceSnapshot {
  shape("ProvenanceSnapshot", snapshot);
  shape("ProvenanceEntry", incoming);
  shape("JsonPointer", pointer);
  shape("StableId", nodeId);
  const current = own(snapshot.nodes, nodeId)?.[pointer];
  if (
    snapshot.history.some((x) => x.id === incoming.id) ||
    Object.values(snapshot.nodes).some((properties) =>
      Object.values(properties).some((x) => x.id === incoming.id),
    )
  )
    fail(
      "CONFLICT",
      "Accepted provenance IDs/timestamps are immutable; use a fresh entry",
    );
  if (current) assertAuthority(current, incoming);
  if (
    current?.authority === "exact-source" &&
    incoming.authority === "exact-source" &&
    canonicalDigest(current.evidenceIds) !==
      canonicalDigest(incoming.evidenceIds)
  )
    fail(
      "CONFLICT",
      "Conflicting exact sources require explicit manual resolution",
    );
  if (
    current &&
    Date.parse(incoming.acceptedAt) < Date.parse(current.acceptedAt)
  )
    fail("CONFLICT", "Cannot rewrite accepted timestamps");
  for (const id of incoming.evidenceIds)
    if (!snapshot.evidence.some((x) => x.id === id))
      fail("EVIDENCE_MISSING", `Missing new evidence ${id}`);
  const entries = [
    ...snapshot.history,
    ...Object.values(snapshot.nodes).flatMap((properties) =>
      Object.values(properties),
    ),
  ];
  for (const id of incoming.supersedes) {
    const old = entries.find((x) => x.id === id);
    if (!old || Date.parse(old.acceptedAt) > Date.parse(incoming.acceptedAt))
      fail("EVIDENCE_MISSING", `Invalid superseded evidence entry ${id}`);
  }
  const result = structuredClone(snapshot);
  if (current) result.history.push(structuredClone(current));
  const properties = own(result.nodes, nodeId) ?? {};
  Object.defineProperty(result.nodes, nodeId, {
    value: properties,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  properties[pointer] = {
    ...structuredClone(incoming),
    supersedes: [
      ...new Set([...incoming.supersedes, ...(current ? [current.id] : [])]),
    ],
  };
  return result;
}

/** Reconcile accepted edits by property value, not by names, positions or revision hashes. */
export function reconcileProvenance(
  before: DesignIR,
  after: DesignIR,
  snapshot: ProvenanceSnapshot,
  replacement: (
    nodeId: string,
    pointer: string,
    previous: ProvenanceEntry,
  ) => ProvenanceEntry,
): ProvenanceSnapshot {
  const oldNodes = indexNodes(before.root);
  const newNodes = indexNodes(after.root);
  let result = structuredClone(snapshot);
  for (const [nodeId, properties] of Object.entries(snapshot.nodes)) {
    const oldNode = oldNodes.get(nodeId);
    const newNode = newNodes.get(nodeId);
    if (!oldNode) fail("EVIDENCE_MISSING", `Unknown provenance node ${nodeId}`);
    if (!newNode) {
      result.history.push(...structuredClone(Object.values(properties)));
      delete result.nodes[nodeId];
      continue;
    }
    for (const [pointer, previous] of Object.entries(properties)) {
      const old = pointerValue(oldNode, pointer);
      let changed = true;
      try {
        changed =
          canonicalDigest(old) !==
          canonicalDigest(pointerValue(newNode, pointer));
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          error.diagnostic.code !== "EVIDENCE_MISSING"
        )
          throw error;
        result.history.push(structuredClone(previous));
        delete result.nodes[nodeId]?.[pointer];
        continue;
      }
      if (changed) {
        const entry = replacement(nodeId, pointer, structuredClone(previous));
        if (entry.authority === "exact-source")
          fail(
            "CONFLICT",
            "Changed properties cannot retain stale exact-source authority",
          );
        result = updateProvenance(result, nodeId, pointer, entry);
      }
    }
  }
  return result;
}
