import type {
  ArtifactReference,
  Bounds,
  DesignIR,
  DesignNode,
  Diagnostic,
  DiagnosticReport,
  FigmaConversionEvidence,
  FigmaSourceMap,
  JsonValue,
  ProvenanceSnapshot,
  ResourceSnapshot,
  SourceSnapshot,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
  KernelError,
  pointerValue,
  resolveDesign,
  validateProvenance,
} from "@design-studio/design-ir";
import { appearance } from "./appearance.js";
import {
  type ConversionLimits,
  escapePointer,
  FigmaImportError,
  fail,
  limits,
  shape,
} from "./boundary.js";
import { parseFigmaSelection } from "./selection.js";
import { parseSource, type SourceNode } from "./source.js";
import { textStyle } from "./text.js";

export interface FigmaConversionInput {
  manifest: unknown;
  structureBytes: Uint8Array;
  projectId: string;
  designId: string;
  intakeId: string;
  actorId: string;
  /** Caller-declared local byte observation, not a verified Figma capture timestamp. */
  observedAt: string;
  /** Byte-pinned declarations only; this pure converter cannot authenticate rights or decode fonts. */
  resources?: { snapshot: ResourceSnapshot; bytes: Uint8Array };
}
export interface FigmaConversion {
  originalBytes: Uint8Array;
  source: SourceSnapshot;
  design?: DesignIR;
  resources: ResourceSnapshot;
  sourceMap: FigmaSourceMap;
  conversionEvidence: FigmaConversionEvidence;
  provenance: ProvenanceSnapshot;
  report: DiagnosticReport;
}
const profile = "figma-offline-fixed-v1";
const metadata = new Set([
  "locked",
  "exportSettings",
  "annotations",
  "pluginData",
  "sharedPluginData",
  "devStatus",
]);
const handled = new Set([
  "id",
  "type",
  "name",
  "children",
  "absoluteBoundingBox",
  "fills",
  "opacity",
  "cornerRadius",
  "rectangleCornerRadii",
  "clipsContent",
  "strokes",
  "strokeWeight",
  "strokeAlign",
  "layoutMode",
  "characters",
  "style",
  "characterStyleOverrides",
  "styleOverrideTable",
]);

export function convertFigmaSnapshot(
  input: FigmaConversionInput,
  options: ConversionLimits = {},
): FigmaConversion {
  const budget = limits(options);
  const manifest = structuredClone(
    shape("FigmaIntakeManifest", input.manifest),
  );
  for (const id of [
    input.projectId,
    input.designId,
    input.intakeId,
    input.actorId,
  ])
    shape("StableId", id);
  shape("Timestamp", input.observedAt);
  const selection = parseFigmaSelection(manifest.selectionUrl);
  const scopeId = canonicalDigest([
    input.projectId,
    input.designId,
    input.intakeId,
  ]);
  if (
    !(input.structureBytes instanceof Uint8Array) ||
    input.structureBytes.buffer instanceof SharedArrayBuffer
  )
    fail("INVALID_INPUT", "Expected non-shared source bytes.");
  if (input.structureBytes.byteLength > budget.maxInputBytes)
    throw new FigmaImportError(
      "INPUT_LIMIT",
      "Source exceeds input byte budget.",
      "",
      {
        measured: input.structureBytes.byteLength,
        allowed: budget.maxInputBytes,
        unit: "byte",
      },
    );
  const originalBytes = Buffer.from(input.structureBytes);
  const raw = manifest.structure;
  const projectionId = `conversion_${scopeId}`;
  if (raw.id === projectionId)
    fail(
      "ARTIFACT_INTEGRITY",
      "Source artifact collides with the derived conversion artifact.",
    );
  if (
    raw.mediaType !== "application/json" ||
    raw.byteLength !== originalBytes.byteLength ||
    raw.sha256 !== hashBytes(originalBytes)
  )
    fail(
      "ARTIFACT_INTEGRITY",
      "Source bytes do not match the supplied structure descriptor.",
    );
  const parsed = parseSource(originalBytes, selection.nodeId, budget);
  const sourceRef = { id: raw.id, sha256: raw.sha256 };
  const diagnostics: Diagnostic[] = [];
  const diagnosticIndex = new Map<string, Diagnostic>();
  const losses: DiagnosticReport["losses"] = [];
  const lossIds = new Set<string>();
  let reportEntries = 0;
  function reserveReportEntries(count = 1) {
    budget.checkpoint();
    const measured = reportEntries + count;
    if (measured > budget.maxReportEntries)
      throw new FigmaImportError(
        "NODE_LIMIT",
        "Conversion report entry limit exceeded.",
        "",
        { measured, allowed: budget.maxReportEntries, unit: "node" },
      );
    reportEntries = measured;
  }
  const evidence: FigmaConversionEvidence = {
    schemaVersion: "1.0",
    adapter: profile,
    source: sourceRef,
    entries: [],
    ignoredProperties: [],
  };
  const provenance: ProvenanceSnapshot = {
    schemaVersion: "1.0",
    id: `provenance_${scopeId}`,
    projectId: input.projectId,
    designId: input.designId,
    nodes: {},
    evidence: [],
    history: [],
  };
  const sourceMap: FigmaSourceMap = {
    schemaVersion: "1.0",
    projectId: input.projectId,
    designId: input.designId,
    snapshot: sourceRef,
    entries: [],
  };
  const resources: ResourceSnapshot = input.resources
    ? structuredClone(shape("ResourceSnapshot", input.resources.snapshot))
    : {
        schemaVersion: "1.0",
        id: `resources_${scopeId}`,
        projectId: input.projectId,
        components: {
          schemaVersion: "1.0",
          projectId: input.projectId,
          revision: profile,
          definitions: [],
          mappings: [],
        },
        tokens: {
          schemaVersion: "1.0",
          projectId: input.projectId,
          revision: profile,
          collections: [],
          selectedModes: {},
          definitions: [],
          resolved: [],
          adapters: [],
        },
        assets: [],
        fonts: [],
      };
  if (
    resources.projectId !== input.projectId ||
    resources.tokens.projectId !== input.projectId ||
    resources.components.projectId !== input.projectId
  )
    fail("FORBIDDEN", "Resource declaration project mismatch.");
  if (
    input.resources &&
    (!(input.resources.bytes instanceof Uint8Array) ||
      input.resources.bytes.buffer instanceof SharedArrayBuffer ||
      input.resources.bytes.byteLength > budget.maxInputBytes ||
      hashBytes(input.resources.bytes) !== canonicalDigest(resources))
  )
    fail(
      "ARTIFACT_INTEGRITY",
      "Resource declarations require matching canonical bytes.",
    );
  const resourceBytes = input.resources
    ? Buffer.from(input.resources.bytes)
    : canonicalBytes(resources);
  if (resources.fonts.length > 1024 || resources.assets.length > 1024)
    throw new FigmaImportError(
      "NODE_LIMIT",
      "Resource declarations exceed the conversion profile inventory limit.",
      "",
      {
        measured: Math.max(resources.fonts.length, resources.assets.length),
        allowed: 1024,
        unit: "node",
      },
    );
  function diagnostic(
    code: Diagnostic["code"],
    message: string,
    nodeId?: string,
    pointer = "",
    severity: Diagnostic["severity"] = "error",
  ) {
    const id = `diagnostic_${canonicalDigest([input.intakeId, code, nodeId ?? null, pointer, message])}`;
    let item = diagnosticIndex.get(id);
    if (!item) {
      reserveReportEntries();
      item = {
        schemaVersion: "1.0",
        id,
        code,
        message,
        severity,
        operations: ["inspect", "resolve", "render"],
        nodeIds: nodeId ? [nodeId] : [],
        pointer,
        evidenceIds: [],
        recovery:
          "Inspect original evidence and supply approved resources or implement the disclosed conversion feature.",
      };
      diagnosticIndex.set(id, item);
      diagnostics.push(item);
    }
    return item;
  }
  const nodeId = (node: SourceNode) =>
    `node_${canonicalDigest([profile, input.projectId, input.designId, input.intakeId, node.id])}`;
  function loss(
    node: SourceNode,
    property: string,
    reason: string,
    support: "unsupported" | "approximated" = "unsupported",
    code: Diagnostic["code"] = "UNSUPPORTED_FEATURE",
  ) {
    const pointer = `${node.pointer}${property ? `/${property}` : ""}`;
    const id = `loss_${canonicalDigest([nodeId(node), pointer, support, reason])}`;
    if (lossIds.has(id)) return;
    reserveReportEntries();
    lossIds.add(id);
    let evidencePointer = pointer;
    try {
      pointerValue(node.raw, property ? `/${property}` : "");
    } catch (error) {
      if (
        !(error instanceof KernelError) ||
        error.diagnostic.code !== "EVIDENCE_MISSING"
      )
        throw error;
      evidencePointer = node.pointer;
    }
    const evidenceId = `evidence_${id}`;
    provenance.evidence.push({
      id: evidenceId,
      artifact: sourceRef,
      kind: "source-property",
      sourceNodeId: node.id,
      pointer: evidencePointer,
    });
    losses.push({
      id,
      nodeId: nodeId(node),
      sourceNodeId: node.id,
      pointer,
      support,
      reason,
      operations: ["render", "editable-export", "handoff"],
      recovery:
        "Preserve the source; review the unsupported property instead of assuming fidelity.",
      evidenceIds: [evidenceId],
    });
    diagnostic(code, reason, nodeId(node), pointer).evidenceIds = [evidenceId];
  }
  function projection(
    node: SourceNode,
    outputPointer: string,
    value: unknown,
    rule: FigmaConversionEvidence["entries"][number]["rule"],
    sourcePointer = node.pointer,
  ) {
    reserveReportEntries();
    evidence.entries.push({
      nodeId: nodeId(node),
      sourceNodeId: node.id,
      sourcePointer,
      outputPointer,
      rule,
      value: shape("JsonValue", value),
    });
  }
  function inventory(node: SourceNode) {
    budget.checkpoint();
    sourceMap.entries.push({
      adapter: profile,
      document: `offline:${input.intakeId}`,
      sourceNodeId: node.id,
      nodeId: nodeId(node),
    });
    for (const key of Object.keys(node.raw)) {
      budget.checkpoint();
      if (metadata.has(key)) {
        reserveReportEntries();
        evidence.ignoredProperties.push({
          pointer: `${node.pointer}/${escapePointer(key)}`,
          reason: "nonvisual-metadata",
        });
        continue;
      }
      if (handled.has(key)) continue;
      const value = node.raw[key];
      if (
        (key === "visible" && value === true) ||
        (key === "blendMode" &&
          ["NORMAL", "PASS_THROUGH"].includes(String(value))) ||
        (["effects", "strokeDashes"].includes(key) &&
          Array.isArray(value) &&
          value.length === 0) ||
        (["cornerSmoothing", "rotation"].includes(key) && value === 0) ||
        (key === "isMask" && value === false)
      )
        continue;
      loss(
        node,
        escapePointer(key),
        "Unsupported or unknown source property is preserved, not silently applied.",
      );
    }
    for (const child of node.children) inventory(child);
  }
  if (parsed.root) inventory(parsed.root);
  function convert(node: SourceNode, parent?: Bounds): DesignNode | undefined {
    budget.checkpoint();
    const bounds = node.bounds;
    if (
      !bounds ||
      (node === parsed.root && (bounds.width <= 0 || bounds.height <= 0))
    ) {
      loss(
        node,
        "absoluteBoundingBox",
        "Missing or invalid geometry prevents a trustworthy draft.",
        "unsupported",
        "EVIDENCE_MISSING",
      );
      return undefined;
    }
    const common = {
      id: nodeId(node),
      ...(typeof node.raw.name === "string" ? { name: node.raw.name } : {}),
      layout: {
        width: bounds.width,
        height: bounds.height,
        position: "absolute" as const,
        offset: {
          x: parent ? bounds.x - parent.x : 0,
          y: parent ? bounds.y - parent.y : 0,
        },
      },
      metadata: {
        sourceAbsoluteBounds: bounds,
        rawSource: sourceRef,
        sourceNodeId: node.id,
      },
    };
    projection(node, "/layout", common.layout, "fixed-layout");
    projection(node, "/metadata/sourceAbsoluteBounds", bounds, "identity");
    if (common.name !== undefined)
      projection(
        node,
        "/name",
        common.name,
        "identity",
        `${node.pointer}/name`,
      );
    const style = appearance(node.raw, (key, reason) =>
      loss(node, key, reason),
    );
    const opaque = (reason: string): DesignNode => ({
      ...common,
      type: "unsupported",
      feature: node.type,
      reason,
      evidenceStatus: "raw-preserved",
    });
    if (
      node.raw.relativeTransform !== undefined ||
      (node.raw.rotation !== undefined && node.raw.rotation !== 0) ||
      (node.raw.visible !== undefined && node.raw.visible !== true)
    ) {
      loss(
        node,
        "",
        "Transformed or hidden geometry is not reconstructed from axis-aligned bounds.",
      );
      return opaque("Unsupported source geometry or visibility.");
    }
    if (
      Array.isArray(node.raw.fills) &&
      node.raw.fills.some(
        (paint) =>
          paint &&
          typeof paint === "object" &&
          !Array.isArray(paint) &&
          paint.type === "IMAGE",
      )
    ) {
      loss(
        node,
        "fills",
        "Image bytes, crop and rights are unresolved in the pure conversion profile.",
        "unsupported",
        "RESOURCE_UNRESOLVED",
      );
      return opaque(
        "Image content requires separately verified asset evidence.",
      );
    }
    let result: DesignNode;
    if (node.type === "FRAME" || node.type === "GROUP") {
      if (node.raw.layoutMode !== undefined && node.raw.layoutMode !== "NONE")
        loss(
          node,
          "layoutMode",
          "Auto-layout is retained as fixed captured geometry, not editable auto-layout semantics.",
          "approximated",
        );
      const children: DesignNode[] = [];
      for (const child of node.children) {
        const converted = convert(child, bounds);
        if (!converted) return undefined;
        children.push(converted);
      }
      result =
        node.type === "FRAME"
          ? {
              ...common,
              type: "frame",
              flow: "absolute",
              appearance: style,
              children,
            }
          : { ...common, type: "group", appearance: style, children };
    } else if (node.type === "RECTANGLE" || node.type === "ELLIPSE") {
      if (node.children.length) {
        loss(node, "children", "Leaf shape unexpectedly contains descendants.");
        return undefined;
      }
      result = {
        ...common,
        type: "shape",
        shape: node.type === "RECTANGLE" ? "rectangle" : "ellipse",
        appearance: style,
      };
    } else if (node.type === "TEXT") {
      const text = textStyle(
        node.raw,
        resources,
        (key, reason, font) =>
          loss(
            node,
            key,
            reason,
            "unsupported",
            font ? "FONT_MISSING" : "UNSUPPORTED_FEATURE",
          ),
        budget.checkpoint,
      );
      if (!text || typeof node.raw.characters !== "string")
        result = opaque(
          "Text cannot be rendered with missing or unsupported font/style evidence.",
        );
      else {
        const textAppearance = { ...style };
        delete textAppearance.fill;
        result = {
          ...common,
          type: "text",
          content: node.raw.characters,
          indexing: "utf-16",
          typography: text.typography,
          styledRanges: text.styledRanges,
          appearance: textAppearance,
        };
        projection(node, "/content", result.content, "identity");
        projection(node, "/typography", result.typography, "text-style");
        projection(node, "/styledRanges", result.styledRanges, "styled-ranges");
      }
    } else {
      loss(
        node,
        "type",
        "Node kind is outside the fixed offline profile; raw descendants remain inspectable.",
      );
      result = opaque(
        "Unsupported node kind; no editable children were invented.",
      );
    }
    projection(node, "/type", result.type, "node-kind");
    if ("appearance" in result && result.appearance)
      projection(node, "/appearance", result.appearance, "solid-appearance");
    return result;
  }
  let design: DesignIR | undefined;
  const root = parsed.root ? convert(parsed.root) : undefined;
  if (root && parsed.root?.bounds)
    design = {
      schemaVersion: "1.0",
      projectId: input.projectId,
      designId: input.designId,
      screen: {
        id: `screen_${scopeId}`,
        name: root.name ?? "Imported draft",
        viewport: {
          width: parsed.root.bounds.width,
          height: parsed.root.bounds.height,
          unit: "design-unit",
        },
        capture: {
          bounds: {
            x: 0,
            y: 0,
            width: parsed.root.bounds.width,
            height: parsed.root.bounds.height,
            unit: "design-unit",
          },
          scrollOffset: { x: 0, y: 0 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
          systemBars: "unknown",
        },
      },
      resources: {
        snapshotId: resources.id,
        sha256: hashBytes(resourceBytes),
        componentRegistryRevision: resources.components.revision,
        tokenRegistryRevision: resources.tokens.revision,
        selectedModes: resources.tokens.selectedModes,
      },
      root,
    };
  if (!parsed.root)
    diagnostic(
      "EVIDENCE_MISSING",
      "Selected node response is null; absence is not proof of deletion.",
    );
  const missing = ["verified-source-capture", "verified-reference-png"];
  if (
    manifest.reference &&
    manifest.reference.sourceNodeId !== selection.nodeId
  )
    fail(
      "INVALID_INPUT",
      "Reference declaration targets a different source node.",
    );
  for (const asset of manifest.assets)
    missing.push(`unverified-asset:${asset.imageRef}`);
  for (const font of manifest.fonts)
    missing.push(`unverified-font:${font.family}:${font.style}`);
  diagnostic(
    "VALIDATION_INCONCLUSIVE",
    "Offline bytes and metadata do not verify Figma authorship, version consistency, reference pixels, or resource rights.",
    undefined,
    "",
    "warning",
  );
  if (resources.fonts.length || resources.assets.length)
    diagnostic(
      "VALIDATION_INCONCLUSIVE",
      "Resource declarations are pinned, but resource bytes/rights/glyphs require the separate asset pipeline.",
      undefined,
      "",
      "warning",
    );
  const declaredVersion =
    manifest.declaredCapture?.sourceVersion ??
    (typeof parsed.envelope.version === "string"
      ? parsed.envelope.version
      : undefined);
  if (declaredVersion !== undefined) shape("Version", declaredVersion);
  if (
    manifest.declaredCapture?.sourceVersion &&
    parsed.envelope.version !== undefined &&
    manifest.declaredCapture.sourceVersion !== parsed.envelope.version
  )
    diagnostic(
      "CONFLICT",
      "Declared capture version and source metadata disagree.",
    );
  const source: SourceSnapshot = {
    schemaVersion: "1.0",
    id: `source_${canonicalDigest([input.intakeId, raw.sha256])}`,
    projectId: input.projectId,
    identity: {
      transport: "figma-offline",
      intakeId: input.intakeId,
      contentDigest: raw.sha256,
      binding: {
        status: "asserted",
        assertedUrl: manifest.selectionUrl,
        actorId: input.actorId,
      },
      ...(manifest.declaredCapture?.transport
        ? { declaredTransport: manifest.declaredCapture.transport }
        : {}),
      ...(declaredVersion ? { declaredSourceVersion: declaredVersion } : {}),
    },
    capturedAt: input.observedAt,
    captureEndedAt: input.observedAt,
    consistency: {
      guarantee: "unknown",
      limitations: [
        "Timestamps are caller-declared local byte observations, not observed Figma capture times.",
        "Only structure bytes were checked; manifest reference/resource descriptors are not decoded or authenticated.",
        "A nodes response does not establish untruncated traversal, file-versus-branch identity or capture consistency.",
      ],
    },
    completeness: "partial",
    requests: [],
    artifacts: [raw],
    missing,
    diagnosticIds: [],
  };
  if (design) {
    shape("DesignIR", design);
    const resolution = resolveDesign(design, resources, {
      resourceBytes,
      maxExpandedNodes: budget.maxNodes,
      maxDepth: budget.maxDepth,
    });
    reserveReportEntries(
      resolution.report.diagnostics.length + resolution.report.losses.length,
    );
    diagnostics.push(...resolution.report.diagnostics);
    losses.push(...resolution.report.losses);
  }
  const report: DiagnosticReport = {
    schemaVersion: "1.0",
    projectId: input.projectId,
    designId: input.designId,
    readiness: diagnostics.some((item) => item.severity === "error")
      ? "blocked"
      : "needs-review",
    assessments: [
      {
        stage: "schema-valid",
        status: design ? "pass" : "fail",
        diagnosticIds: [],
      },
      {
        stage: "dependency-resolved",
        status: "inconclusive",
        diagnosticIds: diagnostics.map((item) => item.id),
      },
      { stage: "renderable", status: "not-evaluated", diagnosticIds: [] },
      { stage: "exportable", status: "not-evaluated", diagnosticIds: [] },
      {
        stage: "implementation-ready",
        status: "not-evaluated",
        diagnosticIds: [],
      },
    ],
    diagnostics,
    losses,
    waiverEventIds: [],
  };
  source.diagnosticIds = diagnostics.map((item) => item.id);
  sourceMap.snapshot = { id: source.id, sha256: canonicalDigest(source) };
  budget.checkpoint();
  shape("FigmaConversionEvidence", evidence);
  const projectionValue = shape("JsonValue", evidence);
  budget.checkpoint();
  // Projections explicitly name their source/rule. Raw source values are never relabeled as transformed values.
  const projectionRef: ArtifactReference = {
    id: projectionId,
    sha256: canonicalDigest(evidence),
  };
  if (design)
    for (const [index, entry] of evidence.entries.entries()) {
      budget.checkpoint();
      const id = `evidence_${canonicalDigest([projectionRef.sha256, index])}`;
      provenance.evidence.push({
        id,
        artifact: projectionRef,
        kind: "source-property",
        sourceNodeId: entry.sourceNodeId,
        pointer: `/entries/${index}/value`,
      });
      const properties = provenance.nodes[entry.nodeId] ?? {};
      provenance.nodes[entry.nodeId] = properties;
      properties[entry.outputPointer] = {
        id: `provenance_${canonicalDigest([id, entry.outputPointer])}`,
        type: "figma-exact",
        authority: "exact-source",
        evidenceIds: [id],
        acceptedAt: input.observedAt,
        supersedes: [],
      };
    }
  if (design) {
    const problems = validateProvenance(
      design,
      provenance,
      (item): JsonValue => {
        budget.checkpoint();
        if (
          item.artifact.id === projectionRef.id &&
          item.artifact.sha256 === projectionRef.sha256
        )
          return projectionValue;
        if (
          item.artifact.id === sourceRef.id &&
          item.artifact.sha256 === sourceRef.sha256
        )
          return parsed.envelope;
        fail("ARTIFACT_INTEGRITY", "Unknown evidence artifact identity.");
      },
    );
    budget.checkpoint();
    if (problems.length)
      fail("EVIDENCE_MISSING", "Converted provenance did not validate.");
  }
  shape("SourceSnapshot", source);
  shape("FigmaSourceMap", sourceMap);
  shape("ProvenanceSnapshot", provenance);
  shape("DiagnosticReport", report);
  const result = {
    source,
    ...(design ? { design } : {}),
    resources,
    sourceMap,
    conversionEvidence: evidence,
    provenance,
    report,
  };
  const outputBytes = canonicalBytes(result).byteLength;
  if (outputBytes > 26_214_400)
    throw new FigmaImportError(
      "INPUT_LIMIT",
      "Converted output exceeds the profile byte budget.",
      "",
      { measured: outputBytes, allowed: 26_214_400, unit: "byte" },
    );
  budget.checkpoint();
  return { originalBytes, ...result };
}
