import type {
  ArtifactReference,
  FigmaCaptureManifest,
  NativeCaptureEnvelope,
  OperationContext,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { CAPTURE_LIMITS } from "@design-studio/figma-capture";
import {
  CURRENT_FIGMA_CONVERSION_POLICY,
  type FigmaConversionPolicy,
  type FigmaStructureConversion,
  figmaConversionPolicy,
} from "@design-studio/figma-import";
import type { LocalStore } from "@design-studio/storage";
import { ApplicationError, unwrap } from "./response.js";

type Output = NonNullable<NativeCaptureEnvelope["value"]>["artifacts"][number];
export interface ConversionEntry {
  role: Output["role"];
  bytes: Uint8Array;
}

export function captureConversionIdentity(
  captureId: string,
  manifest: FigmaCaptureManifest,
  nodes: ArtifactReference,
  intendedPolicy: FigmaConversionPolicy = CURRENT_FIGMA_CONVERSION_POLICY,
) {
  const policy = figmaConversionPolicy(intendedPolicy);
  const legacy = intendedPolicy === "fixed-v1";
  return {
    policy: intendedPolicy,
    designId: `design_${canonicalDigest([
      captureId,
      nodes.sha256,
      ...(!legacy ? [policy] : []),
    ])}`,
    operationId: `convert_${canonicalDigest([
      captureId,
      manifest,
      policy.structureAdapter,
      policy.version,
    ])}`,
  };
}

/** Called only after the native composition validates the committed capture/source relationship. */
export function captureConversionEntries(
  converted: FigmaStructureConversion,
  sourceArtifact: ArtifactReference,
): ConversionEntry[] {
  converted.sourceMap.snapshot = {
    id: sourceArtifact.id,
    sha256: sourceArtifact.sha256,
  };
  const projection = canonicalBytes(converted.conversionEvidence);
  const projectionRef = {
    id: `sha256_${hashBytes(projection)}`,
    sha256: hashBytes(projection),
  };
  for (const evidence of converted.provenance.evidence)
    if (evidence.artifact.sha256 === projectionRef.sha256)
      evidence.artifact = { ...projectionRef };
  const entries: ConversionEntry[] = [
    ...(converted.design
      ? [{ role: "design" as const, bytes: canonicalBytes(converted.design) }]
      : []),
    { role: "resources", bytes: canonicalBytes(converted.resources) },
    { role: "source-map", bytes: canonicalBytes(converted.sourceMap) },
    { role: "conversion-evidence", bytes: projection },
    { role: "provenance", bytes: canonicalBytes(converted.provenance) },
    { role: "report", bytes: canonicalBytes(converted.report) },
  ];
  if (
    entries.reduce((sum, entry) => sum + entry.bytes.length, 0) >
    CAPTURE_LIMITS.maxOutputBytes
  )
    throw new ApplicationError("INPUT_LIMIT");
  return entries;
}

export async function persistCaptureConversion(
  entries: ConversionEntry[],
  store: Pick<LocalStore, "getReceipt" | "stage" | "commit">,
  context: OperationContext,
  check: () => Promise<void>,
): Promise<Output[]> {
  let receipt = unwrap(await store.getReceipt(context.requestId, context));
  if (!receipt) {
    const staged = [];
    for (const entry of entries) {
      await check();
      staged.push(unwrap(await store.stage(entry.bytes, context)));
    }
    await check();
    receipt = unwrap(await store.commit(staged, context));
  }
  if (receipt.outputs.length !== entries.length)
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return entries.map((entry, index) => {
    const artifact = receipt.outputs[index];
    if (
      !artifact ||
      artifact.sha256 !== hashBytes(entry.bytes) ||
      artifact.byteLength !== entry.bytes.byteLength
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    return { role: entry.role, artifact };
  });
}
