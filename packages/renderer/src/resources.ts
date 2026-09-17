import {
  AssetError,
  classify,
  decodeRaster,
  type RightsAuthority,
  sanitizeSvg,
  verifyBytes,
  verifyFont,
  verifyRights,
} from "@design-studio/assets";
import {
  type Artifact,
  type ArtifactReference,
  type Budget,
  type DesignIR,
  type DiagnosticReport,
  parseContract,
  type RenderRequest,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalDigest,
  dependencyBytes,
  hashBytes,
  type InstanceExpansion,
  resolveDesign,
} from "@design-studio/design-ir";
import { HostBoundaryError } from "@design-studio/host";
import { children } from "./layout.js";

export interface AcceptedInputs {
  revision: ArtifactReference;
  designBytes: Uint8Array;
  resourceBytes: Uint8Array;
  artifacts: { artifact: Artifact; bytes: Uint8Array }[];
}
export interface PreparedFont {
  id: string;
  bytes: string;
  face: ReturnType<typeof verifyFont>;
}
export interface PreparedImage {
  id: string;
  bytes: string;
  sha256: string;
  mediaType: "image/png" | "image/svg+xml";
  width: number;
  height: number;
}
export interface PreparedInputs {
  expanded: DesignIR;
  instances: InstanceExpansion[];
  report: DiagnosticReport;
  fonts: PreparedFont[];
  images: PreparedImage[];
  resourceHashes: string[];
}
function fail(message: string): never {
  throw new HostBoundaryError("RESOURCE_UNRESOLVED", message);
}
export function prepareInputs(
  request: RenderRequest,
  accepted: AcceptedInputs,
  rights: RightsAuthority,
  budget: Budget,
): PreparedInputs {
  if (!validateContract("RenderRequest", request).success)
    fail("Invalid render request.");
  if (canonicalDigest(accepted.revision) !== canonicalDigest(request.revision))
    fail("Accepted revision authority does not match request.");
  if (
    accepted.designBytes.byteLength > budget.maxInputBytes ||
    accepted.resourceBytes.byteLength > budget.maxInputBytes
  )
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Accepted input bytes exceed budget.",
    );
  const acceptedDesign = parseContract(
    "DesignIR",
    new TextDecoder("utf-8", { fatal: true }).decode(accepted.designBytes),
    "json",
  );
  if (canonicalDigest(acceptedDesign) !== canonicalDigest(request.design))
    fail("Requested design differs from accepted revision content.");
  const resolved = resolveDesign(request.design, request.resources, {
    resourceBytes: accepted.resourceBytes,
    maxExpandedNodes: budget.maxExpandedNodes,
    maxDepth: budget.maxDepth,
  });
  if (
    !resolved.design ||
    !resolved.closure ||
    resolved.closure.integrity !== "verified-bytes"
  ) {
    const cause = resolved.report.diagnostics.find(
      (d) => d.severity === "error",
    );
    if (cause) throw new HostBoundaryError(cause.code, cause.message);
    fail("Unresolved resource/layout dependency or unverified snapshot.");
  }
  const errors = resolved.report.diagnostics.filter(
    (d) => d.severity === "error",
  );
  if (
    errors.some((d) => d.code !== "UNSUPPORTED_FEATURE") ||
    (request.mode === "strict" && errors.length)
  )
    throw new HostBoundaryError(
      errors[0]?.code ?? "INVALID_LAYOUT",
      "Blocked unsupported/resource/layout input.",
    );
  const indexed = new Map<string, Uint8Array>();
  let total = accepted.resourceBytes.byteLength;
  for (const entry of accepted.artifacts) {
    if (!validateContract("Artifact", entry.artifact).success)
      fail("Invalid supplied resource descriptor.");
    const { bytes } = dependencyBytes(entry.artifact, entry.bytes);
    if (!indexed.has(entry.artifact.sha256)) total += bytes.byteLength;
    if (bytes.byteLength > budget.maxInputBytes)
      throw new HostBoundaryError("INPUT_LIMIT", "Resource input byte limit.");
    if (total > budget.maxSnapshotAssetBytes)
      throw new HostBoundaryError(
        "ASSET_LIMIT",
        "Resource snapshot byte limit.",
      );
    indexed.set(entry.artifact.sha256, bytes);
  }
  const bytesFor = (ref: ArtifactReference) =>
    indexed.get(ref.sha256) ?? fail(`Missing resource bytes: ${ref.id}.`);
  try {
    // indexed already owns defensive copies; recheck identity without copying each large blob again.
    for (const descriptor of resolved.closure.artifacts)
      verifyBytes(bytesFor(descriptor), descriptor);
  } catch (error) {
    if (error instanceof AssetError)
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Pinned resource descriptor disagrees with actual bytes.",
        false,
        { cause: error },
      );
    throw error;
  }
  for (const ref of resolved.closure.references) bytesFor(ref);
  const expectedFonts = request.resources.fonts.map((f) =>
    f.kind === "bundled"
      ? { id: f.artifact.id, sha256: f.artifact.sha256 }
      : { id: f.id, sha256: f.expectedSha256 },
  );
  const refs = (items: ArtifactReference[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (
    canonicalDigest(refs(request.profile.fontHashes)) !==
      canonicalDigest(refs(expectedFonts)) ||
    canonicalDigest(refs(request.profile.assetHashes)) !==
      canonicalDigest(
        refs(
          request.resources.assets.map((a) => ({
            id: a.artifact.id,
            sha256: a.artifact.sha256,
          })),
        ),
      )
  )
    fail("Render profile resource hashes do not match pinned closure.");
  const text = new Map<string, string>();
  function visit(node: DesignIR["root"]) {
    if (node.type === "text") {
      text.set(
        node.typography.fontId,
        (text.get(node.typography.fontId) ?? "") + node.content,
      );
      for (const run of node.styledRanges ?? [])
        text.set(
          run.typography.fontId,
          (text.get(run.typography.fontId) ?? "") +
            node.content.slice(run.start, run.end),
        );
    }
    for (const child of children(node)) visit(child);
  }
  visit(resolved.design.root);
  try {
    const fonts = request.resources.fonts.map((font): PreparedFont => {
      const ref =
        font.kind === "bundled"
          ? font.artifact
          : { id: font.id, sha256: font.expectedSha256 };
      const bytes = bytesFor(ref);
      const face = verifyFont(
        bytes,
        font,
        text.get(font.id) ?? "",
        bytesFor(font.license.notice),
        "embed",
        rights,
        budget,
      );
      if (face.style !== "normal" || face.weight !== 400)
        throw new HostBoundaryError(
          "UNSUPPORTED_FEATURE",
          "Only verified normal 400 static faces are supported.",
        );
      return {
        id: font.id,
        bytes: Buffer.from(bytes).toString("base64"),
        face,
      };
    });
    const images = request.resources.assets.map((asset): PreparedImage => {
      const original = bytesFor(asset.artifact);
      verifyRights(
        asset.license,
        original,
        bytesFor(asset.license.notice),
        "embed",
        rights,
      );
      const media = classify(original);
      if (media === "image/svg+xml") {
        const safe = sanitizeSvg(original, budget);
        if (safe.width !== asset.width || safe.height !== asset.height)
          fail("SVG dimensions differ from declared resource.");
        return {
          id: asset.id,
          bytes: Buffer.from(safe.bytes).toString("base64"),
          sha256: hashBytes(safe.bytes),
          mediaType: "image/svg+xml",
          width: safe.width,
          height: safe.height,
        };
      }
      const decoded = decodeRaster(original, budget);
      if (
        decoded.width !== asset.width ||
        decoded.height !== asset.height ||
        decoded.alpha !== asset.alpha
      )
        fail("Decoded resource dimensions/alpha differ from declaration.");
      return {
        id: asset.id,
        bytes: Buffer.from(original).toString("base64"),
        sha256: hashBytes(original),
        mediaType: "image/png",
        width: decoded.width,
        height: decoded.height,
      };
    });
    return {
      expanded: resolved.design,
      instances: resolved.instances,
      report: resolved.report,
      fonts,
      images,
      resourceHashes: [...indexed.keys()].sort(),
    };
  } catch (error) {
    if (error instanceof AssetError)
      throw new HostBoundaryError(
        error.diagnostic.code.startsWith("FONT")
          ? "FONT_MISSING"
          : error.diagnostic.code.startsWith("RIGHTS")
            ? "LICENSE_UNVERIFIED"
            : "ASSET_INVALID",
        `Pinned resource/font/rights verification failed: ${error.diagnostic.code}.`,
      );
    throw error;
  }
}
