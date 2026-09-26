import type {
  Artifact,
  CommitReceipt,
  ReferenceRecoveryBinding,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { expect, it } from "vitest";
import {
  projectRecoveryState,
  type ReferenceRecoveryRecord,
  recoveryEvidence,
  recoveryOutputs,
  referenceConversionId,
  referenceRecoveryHead,
  referenceRecoveryId,
  referenceRecoveryState,
  validateRecoveryRecord,
} from "../src/reference-recovery.js";

const artifact = (bytes: Uint8Array): Artifact => {
  const sha256 = hashBytes(bytes);
  return {
    id: `sha256_${sha256}`,
    sha256,
    path: `blobs/${sha256}`,
    byteLength: bytes.length,
    mediaType: "application/octet-stream",
  };
};
function record(): ReferenceRecoveryRecord {
  const binding: ReferenceRecoveryBinding = {
    schemaVersion: "1.0",
    projectId: "project",
    actorId: "actor",
    permissionScope: "permission",
    artifactRootId: "root",
    requestId: "original",
    originalJobId: "diagnostic_original",
    recoveryId: referenceRecoveryId(
      "project",
      "diagnostic_original",
      canonicalDigest,
    ),
    jobSha256: "a".repeat(64),
    recordSha256: "b".repeat(64),
    stateSha256: "c".repeat(64),
    metadataSha256: "d".repeat(64),
    stagesSha256: "e".repeat(64),
    identitySha256: "f".repeat(64),
    policySha256: "1".repeat(64),
    planSha256: "2".repeat(64),
    source: { id: "source", sha256: "3".repeat(64) },
    approval: { id: "approval", sha256: "4".repeat(64) },
    historicalEvidence: artifact(Buffer.from("synthetic evidence")),
    reference: artifact(Buffer.from("synthetic pixels")),
    recordedAt: "2026-09-24T00:00:00.000Z",
    confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE",
  };
  return {
    reservation: {
      binding,
      evidence: artifact(
        canonicalBytes(recoveryEvidence(binding, canonicalDigest)),
      ),
    },
    events: [],
  };
}
function append(
  r: ReferenceRecoveryRecord,
  event: Omit<
    ReferenceRecoveryRecord["events"][number],
    "sequence" | "previousSha256"
  >,
) {
  r.events.push({
    sequence: r.events.length + 1,
    previousSha256: referenceRecoveryHead(r, canonicalDigest),
    ...event,
  });
}
function committed() {
  const r = record();
  for (const [i, artifact] of recoveryOutputs(r.reservation).entries()) {
    append(r, { kind: "stage-intent" });
    append(r, {
      kind: "staged",
      staged: {
        stagingId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        artifact,
      },
    });
  }
  append(r, { kind: "publication-intent" });
  const b = r.reservation.binding;
  const receipt: CommitReceipt = {
    schemaVersion: "1.0",
    id: "receipt_recovery",
    projectId: "project",
    jobId: b.recoveryId,
    idempotency: {
      projectId: "project",
      actorId: "actor",
      operation: "write",
      key: b.recoveryId,
      payloadSha256: "5".repeat(64),
    },
    committedAt: b.recordedAt,
    outputs: recoveryOutputs(r.reservation),
    integrity: "verified",
    publication: "atomic",
  };
  receipt.idempotency.payloadSha256 = canonicalDigest({
    outputs: [...receipt.outputs].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    revision: null,
  });
  receipt.id = `receipt-${canonicalDigest([
    JSON.stringify(["project", "actor", "write", b.recoveryId]),
    receipt.idempotency.payloadSha256,
  ])}`;
  append(r, {
    kind: "committed",
    receipt,
    introduced: receipt.outputs.map((a) => a.id),
  });
  return r;
}
it("preserves stable original-diagnostic uniqueness independently of proof and consent", () => {
  const r = record();
  expect(
    referenceRecoveryState(validateRecoveryRecord(r, canonicalDigest)),
  ).toBe("reserved");
  const id = r.reservation.binding.recoveryId;
  r.reservation.binding.planSha256 = "9".repeat(64);
  r.reservation.evidence = artifact(
    canonicalBytes(recoveryEvidence(r.reservation.binding, canonicalDigest)),
  );
  expect(
    validateRecoveryRecord(r, canonicalDigest).reservation.binding.recoveryId,
  ).toBe(id);
});
it.each(["sequence", "previous", "kind", "original", "output", "introduced"])(
  "rejects altered append-only recovery %s",
  (kind) => {
    const r = committed();
    const event = r.events[7];
    if (!event) throw new Error("Missing fixture event.");
    if (kind === "sequence") event.sequence++;
    if (kind === "previous") event.previousSha256 = "0".repeat(64);
    if (kind === "kind") event.kind = "stage-intent";
    if (kind === "original") r.reservation.binding.originalJobId = "other";
    if (kind === "output" && event.receipt) event.receipt.outputs.reverse();
    if (kind === "introduced") event.introduced = ["foreign"];
    expect(() => validateRecoveryRecord(r, canonicalDigest)).toThrow();
  },
);
it("retains the recovery receipt identity after an exact derived-conversion intent", () => {
  const r = committed();
  const id = referenceConversionId(r, canonicalDigest);
  append(r, {
    kind: "conversion-intent",
    outputs: Array.from({ length: 6 }, (_, i) =>
      artifact(Buffer.from(`derived_${i}`)),
    ),
  });
  expect(
    referenceRecoveryState(validateRecoveryRecord(r, canonicalDigest)),
  ).toBe("committed");
  expect(referenceConversionId(r, canonicalDigest)).toBe(id);
  const modified = structuredClone(r);
  modified.events[8]?.outputs?.pop();
  expect(() => validateRecoveryRecord(modified, canonicalDigest)).toThrow();
});
it("projects only the exact receipt and protected outputs, rejecting incomplete reference graphs", () => {
  const r = committed();
  const receipt = r.events[7]?.receipt;
  if (!receipt) throw new Error("Missing fixture receipt.");
  const state = {
    jobs: [],
    resources: [],
    stages: [],
    artifacts: receipt.outputs,
    receipts: [
      {
        scope: JSON.stringify(["project", "actor", "write", receipt.jobId]),
        receipt,
      },
    ],
    references: receipt.outputs.map((a) => ({
      kind: "job",
      owner: receipt.id,
      artifactId: a.id,
    })),
    otherSha256: "0".repeat(64),
  };
  expect(projectRecoveryState(state, r, canonicalDigest).artifacts).toEqual([]);
  state.references.pop();
  expect(() => projectRecoveryState(state, r, canonicalDigest)).toThrow();
});
