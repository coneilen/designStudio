import type {
  EffectiveReference,
  ReferenceConversionEvidence,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { convertFigmaStructure } from "@design-studio/figma-import";
import {
  type ReferenceRecoveryRecord,
  referenceConversionId,
} from "@design-studio/storage";
import { captureConversionEntries } from "./capture-conversion.js";
import type { ReferenceReader } from "./reference-proof.js";
import { ref, same } from "./reference-proof.js";
import { ApplicationError, unwrap } from "./response.js";

export async function prepareReferenceConversion(
  reader: ReferenceReader,
  record: ReferenceRecoveryRecord,
  effective: EffectiveReference,
  verifiedCapture: object,
  proposal: Parameters<ReferenceReader["verifiedCaptureOutputs"]>[1],
) {
  const capture = reader.verifiedCaptureOutputs(verifiedCapture, proposal);
  const nodes = capture.artifacts.find((a) => a.role === "nodes")?.artifact;
  if (
    !nodes ||
    !same(effective.source, proposal.binding.source) ||
    effective.receiptSha256 !== canonicalDigest(record.events[7]?.receipt)
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  const operationId = referenceConversionId(record, canonicalDigest);
  const designId = `design_${canonicalDigest([operationId, nodes, effective])}`;
  await reader.check();
  const read = unwrap(
    await reader.store.readVerified(ref(nodes), reader.context),
  );
  try {
    await reader.check();
    const converted = convertFigmaStructure(
      {
        policy: "fixed-v2",
        selection: {
          fileKey: proposal.binding.fileKey,
          nodeId: proposal.binding.nodeId,
        },
        structure: read.artifact,
        structureBytes: read.bytes,
        projectId: reader.work.project.projectId,
        designId,
        intakeId: proposal.binding.originalJobId,
        actorId: reader.work.actorId,
        observedAt: record.reservation.binding.recordedAt,
      },
      {
        deadline: Date.parse(reader.context.deadline),
        now: () => reader.context.clock.now(),
        signal: reader.context.signal,
      },
    );
    try {
      const sourceImageId = `evidence_${canonicalDigest(["recovered-reference", effective])}`;
      converted.provenance.evidence.push({
        id: sourceImageId,
        artifact: effective.reference,
        kind: "source-image",
        sourceNodeId: proposal.binding.nodeId,
        snapshotId: effective.source.id,
        region: proposal.binding.bounds,
      });
      const entries = captureConversionEntries(converted, effective.source);
      const projection = entries.find((e) => e.role === "conversion-evidence");
      if (!projection) throw new ApplicationError("ARTIFACT_INTEGRITY");
      const evidence: ReferenceConversionEvidence = {
        schemaVersion: "1.0",
        composition: "figma-capture-recovered-reference-v1",
        policy: "fixed-v2",
        source: effective.source,
        structure: ref(nodes),
        projection: {
          id: `sha256_${hashBytes(projection.bytes)}`,
          sha256: hashBytes(projection.bytes),
        },
        effectiveReference: effective,
      };
      const bytes = canonicalBytes(evidence);
      const outputs = [...entries.map((e) => e.bytes), bytes];
      if (
        outputs.reduce((sum, b) => sum + b.length, 0) >
        reader.context.budget.maxOutputBytes
      )
        throw new ApplicationError("INPUT_LIMIT");
      await reader.check();
      return {
        operationId,
        outputs,
        evidence: {
          id: `sha256_${hashBytes(bytes)}`,
          sha256: hashBytes(bytes),
        },
        readiness:
          converted.report.readiness === "blocked"
            ? ("blocked" as const)
            : ("needs-review" as const),
      };
    } finally {
      converted.originalBytes.fill(0);
    }
  } finally {
    read.bytes.fill(0);
  }
}

export function assertReferenceConversionReceipt(
  prepared: Awaited<ReturnType<typeof prepareReferenceConversion>>,
  receipt: NonNullable<ReferenceRecoveryRecord["events"][number]["receipt"]>,
) {
  if (
    receipt.jobId !== prepared.operationId ||
    receipt.outputs.length !== prepared.outputs.length ||
    receipt.outputs.some(
      (a, i) =>
        a.sha256 !== hashBytes(prepared.outputs[i] ?? new Uint8Array()) ||
        a.byteLength !== prepared.outputs[i]?.length,
    )
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
}
