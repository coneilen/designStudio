import {
  type Artifact,
  type ArtifactReference,
  DEFAULT_BUDGETS,
  type DesignIR,
  type Diagnostic,
  type DiagnosticReport,
  parseContract,
  type ResourceSnapshot,
} from "@design-studio/contracts";
import { type ContentBytes, canonicalDigest, hashBytes } from "./canonical.js";
import { expandComponents, type InstanceExpansion } from "./components.js";
import { normalizeDesign, type ResourceUsage } from "./normalize.js";
import {
  childNodes,
  diagnostic,
  fail,
  KernelError,
  shape,
  unique,
} from "./shared.js";
import { resolveTokens, valueResolver } from "./tokens.js";

export interface ResolveOptions {
  resourceBytes?: Uint8Array;
  maxExpandedNodes?: number;
  maxDepth?: number;
}

export interface DependencyClosure {
  scope: "complete-pinned-snapshot";
  snapshot: ArtifactReference;
  integrity: "verified-bytes" | "not-verified";
  artifacts: Artifact[];
  references: ArtifactReference[];
}

export interface DesignResolution {
  design?: DesignIR;
  tokens?: ResourceSnapshot["tokens"];
  instances: InstanceExpansion[];
  closure?: DependencyClosure;
  report: DiagnosticReport;
}

function report(
  design: DesignIR,
  diagnostics: Diagnostic[],
  schema: boolean,
  dependencies: boolean,
  integrity: boolean,
): DiagnosticReport {
  const errors = diagnostics
    .filter((x) => x.severity === "error")
    .map((x) => x.id);
  return {
    schemaVersion: "1.0",
    projectId: design.projectId,
    designId: design.designId,
    readiness: errors.length ? "blocked" : "needs-review",
    assessments: [
      {
        stage: "schema-valid",
        status: schema ? "pass" : "fail",
        diagnosticIds: schema ? [] : errors,
      },
      {
        stage: "dependency-resolved",
        status: dependencies ? (integrity ? "pass" : "inconclusive") : "fail",
        diagnosticIds:
          dependencies && integrity ? [] : diagnostics.map((x) => x.id),
      },
      {
        stage: "renderable",
        status: errors.length ? "fail" : "not-evaluated",
        diagnosticIds: errors,
      },
      { stage: "exportable", status: "not-evaluated", diagnosticIds: [] },
      {
        stage: "implementation-ready",
        status: "not-evaluated",
        diagnosticIds: [],
      },
    ],
    diagnostics,
    losses: diagnostics
      .filter((x) => x.code === "UNSUPPORTED_FEATURE")
      .flatMap((item) =>
        item.nodeIds.map((nodeId) => ({
          id: `loss_${canonicalDigest([item.id, nodeId]).slice(0, 24)}`,
          nodeId,
          pointer: "",
          support: "unsupported" as const,
          reason: item.message,
          operations: ["render", "editable-export"] as [
            "render",
            "editable-export",
          ],
          recovery: item.recovery,
          evidenceIds: item.evidenceIds,
        })),
      ),
    waiverEventIds: [],
  };
}

export function resolveDesign(
  design: DesignIR,
  resources: ResourceSnapshot,
  options: ResolveOptions = {},
): DesignResolution {
  const diagnostics: Diagnostic[] = [];
  let schemaValid = false;
  try {
    shape("DesignIR", design);
    shape("ResourceSnapshot", resources);
    schemaValid = true;
    const maxExpandedNodes =
      options.maxExpandedNodes ?? DEFAULT_BUDGETS.maxExpandedNodes;
    const maxDepth = options.maxDepth ?? DEFAULT_BUDGETS.maxDepth;
    for (const value of [maxExpandedNodes, maxDepth])
      if (!Number.isSafeInteger(value) || value <= 0)
        fail(
          "INVALID_INPUT",
          "Kernel budgets must be positive finite integers",
        );
    // Schema authoring is bounded to 128; higher expansion limits need an explicit new profile.
    if (maxDepth > 128) fail("INVALID_INPUT", "Maximum supported depth is 128");
    const lock = design.resources;
    if (
      resources.projectId !== design.projectId ||
      resources.tokens.projectId !== design.projectId ||
      resources.components.projectId !== design.projectId ||
      lock.snapshotId !== resources.id ||
      lock.componentRegistryRevision !== resources.components.revision ||
      lock.tokenRegistryRevision !== resources.tokens.revision ||
      canonicalDigest(lock.selectedModes) !==
        canonicalDigest(resources.tokens.selectedModes)
    )
      fail(
        "RESOURCE_UNRESOLVED",
        "Resource lock project, snapshot, registry revision or selected mode mismatch",
      );
    let integrity: DependencyClosure["integrity"] = "not-verified";
    if (options.resourceBytes) {
      if (options.resourceBytes.byteLength > DEFAULT_BUDGETS.maxInputBytes)
        fail("INPUT_LIMIT", "Resource input bytes exceed budget");
      if (hashBytes(options.resourceBytes) !== lock.sha256)
        fail(
          "ARTIFACT_INTEGRITY",
          "Resource bytes do not match the pinned lock",
        );
      const parsed = parseContract(
        "ResourceSnapshot",
        new TextDecoder("utf-8", { fatal: true }).decode(options.resourceBytes),
        "json",
      );
      if (canonicalDigest(parsed) !== canonicalDigest(resources))
        fail(
          "ARTIFACT_INTEGRITY",
          "Supplied resource object differs from the pinned resource bytes",
        );
      integrity = "verified-bytes";
    } else
      diagnostics.push(
        diagnostic(
          "VALIDATION_INCONCLUSIVE",
          "Resource lock bytes not supplied; IDs/revisions are not integrity proof.",
          "warning",
        ),
      );
    const tokens = resolveTokens(resources.tokens);
    const usage: ResourceUsage = {
      tokens: new Set(),
      assets: new Set(),
      fonts: new Set(),
    };
    const resolver = valueResolver((id) => {
      usage.tokens.add(id);
      const value = tokens.values.get(id);
      if (!value) fail("RESOURCE_UNRESOLVED", `Missing token ${id}`);
      return value;
    });
    const assets = unique(resources.assets, (x) => x.id, "asset");
    const fonts = unique(resources.fonts, (x) => x.id, "font");
    function inspect(value: unknown) {
      if (Array.isArray(value)) {
        for (const child of value) inspect(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      if ("token" in value && typeof value.token === "string") {
        if (!tokens.values.has(value.token))
          fail("RESOURCE_UNRESOLVED", `Missing token ${value.token}`);
      }
      if (
        "fontId" in value &&
        typeof value.fontId === "string" &&
        !fonts.has(value.fontId)
      )
        fail("FONT_MISSING", `Missing font declaration ${value.fontId}`);
      if (
        "assetId" in value &&
        typeof value.assetId === "string" &&
        !assets.has(value.assetId)
      )
        fail(
          "RESOURCE_UNRESOLVED",
          `Missing asset declaration ${value.assetId}`,
        );
      if (
        "type" in value &&
        value.type === "asset" &&
        "value" in value &&
        typeof value.value === "string" &&
        !assets.has(value.value)
      )
        fail(
          "RESOURCE_UNRESOLVED",
          `Missing typed asset property ${value.value}`,
        );
      if ("type" in value && value.type === "component" && "value" in value) {
        const reference = shape("ComponentReference", value.value);
        if (
          !resources.components.definitions.some(
            (x) => x.id === reference.id && x.version === reference.version,
          )
        )
          fail(
            "RESOURCE_UNRESOLVED",
            `Missing typed component property ${reference.id}`,
          );
      }
      for (const [key, child] of Object.entries(value))
        if (key !== "extensions" && key !== "metadata") inspect(child);
    }
    inspect(design.root);
    inspect(resources.components.definitions);
    inspect(resources.tokens.definitions);
    for (const definition of resources.components.definitions) {
      for (const id of definition.dependencies.tokens)
        if (!tokens.values.has(id))
          fail(
            "RESOURCE_UNRESOLVED",
            `Missing declared dependency token ${id}`,
          );
      for (const id of definition.dependencies.assets)
        if (!assets.has(id))
          fail(
            "RESOURCE_UNRESOLVED",
            `Missing declared dependency asset ${id}`,
          );
      for (const id of definition.dependencies.fonts)
        if (!fonts.has(id))
          fail("FONT_MISSING", `Missing declared dependency font ${id}`);
      for (const root of [
        definition.expansion,
        ...definition.variants.map((x) => x.expansion),
      ])
        normalizeDesign({ ...design, root }, resources, resolver, usage);
    }
    const expanded = expandComponents(design.root, resources.components, {
      maxExpandedNodes,
      maxDepth,
    });
    const normalized = normalizeDesign(
      { ...design, root: expanded.root },
      resources,
      resolver,
      usage,
    );
    diagnostics.push(...expanded.mappingDiagnostics);
    shape("DesignIR", normalized.design);
    diagnostics.push(...normalized.diagnostics);
    if (resources.components.mappings.some((x) => x.state !== "approved"))
      diagnostics.push(
        diagnostic(
          "MAPPING_STALE",
          "Code reuse is unresolved/proposed/stale; visual expansion does not supply approved implementation mappings.",
          "warning",
        ),
      );
    const artifacts = new Map<string, Artifact>();
    function add(artifact: Artifact) {
      const existing = artifacts.get(artifact.id);
      if (existing && canonicalDigest(existing) !== canonicalDigest(artifact))
        fail(
          "ARTIFACT_INTEGRITY",
          `Conflicting artifact descriptors for ${artifact.id}`,
        );
      artifacts.set(artifact.id, structuredClone(artifact));
    }
    const references = new Map<string, ArtifactReference>();
    const addReference = (reference: ArtifactReference) => {
      const existing = references.get(reference.id);
      if (existing && existing.sha256 !== reference.sha256)
        fail(
          "ARTIFACT_INTEGRITY",
          `Conflicting dependency reference ${reference.id}`,
        );
      references.set(reference.id, structuredClone(reference));
    };
    function evidenceReferences(node: DesignIR["root"]) {
      if (node.metadata?.rawSource) addReference(node.metadata.rawSource);
      if (node.type === "component" && node.snapshotExpansion)
        addReference(node.snapshotExpansion.source);
      for (const child of childNodes(node)) evidenceReferences(child);
    }
    evidenceReferences(design.root);
    for (const definition of resources.components.definitions)
      for (const root of [
        definition.expansion,
        ...definition.variants.map((x) => x.expansion),
      ])
        evidenceReferences(root);
    for (const asset of resources.assets) {
      add(asset.artifact);
      add(asset.license.notice);
      addReference(asset.source);
      if (asset.derivativeOf) addReference(asset.derivativeOf);
    }
    for (const font of resources.fonts) {
      if (font.kind === "bundled") add(font.artifact);
      else
        addReference({
          id: font.id,
          sha256: font.expectedSha256,
        });
      add(font.license.notice);
    }
    return {
      design: normalized.design,
      tokens: tokens.snapshot,
      instances: expanded.instances,
      closure: {
        scope: "complete-pinned-snapshot",
        snapshot: { id: lock.snapshotId, sha256: lock.sha256 },
        integrity,
        artifacts: [...artifacts.values()].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
        references: [...references.values()].sort((a, b) =>
          a.sha256 < b.sha256 ? -1 : 1,
        ),
      },
      report: report(
        design,
        diagnostics,
        true,
        true,
        integrity === "verified-bytes",
      ),
    };
  } catch (error) {
    if (!(error instanceof KernelError)) throw error;
    diagnostics.push(error.diagnostic);
    return {
      instances: [],
      report: report(design, diagnostics, schemaValid, false, false),
    };
  }
}

/** Integrity only; host authorization, signatures, decode and rights remain separate. */
export function dependencyBytes(
  artifact: Artifact,
  supplied: Uint8Array,
): ContentBytes {
  shape("Artifact", artifact);
  const bytes = Uint8Array.from(supplied);
  const sha256 = hashBytes(bytes);
  if (bytes.byteLength !== artifact.byteLength || sha256 !== artifact.sha256)
    fail("ARTIFACT_INTEGRITY", `Dependency bytes disagree with ${artifact.id}`);
  return { bytes, byteLength: bytes.byteLength, sha256 };
}
