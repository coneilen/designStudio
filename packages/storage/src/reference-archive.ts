import type { ReferenceRecoveryArchive } from "@design-studio/contracts";
import type { CaptureRecoveryState } from "./capture-recovery.js";
import {
  projectRecoveryState,
  type ReferenceRawTable,
  type ReferenceRecoveryRecord,
  referenceRowsDigest,
  validateRecoveryRecord,
  validateReferenceRows,
} from "./reference-recovery.js";
import { type ReferenceBackupMetadata, StorageError } from "./types.js";

type Digest = (value: unknown) => string;
function fail(): never {
  throw new StorageError(
    "INTEGRITY",
    "Recovery snapshot/archive evidence is inconsistent.",
  );
}
export function validateReferenceRowProjection(
  supplied: ReferenceRawTable[],
  expected: Record<ReferenceRawTable["table"], object[]>,
  digest: Digest,
) {
  const rows = validateReferenceRows(supplied, true);
  for (const table of rows) {
    const decoded = table.rows.map((row) => {
      if (!("data" in row)) return row;
      if (typeof row.data !== "string") fail();
      const data: unknown = JSON.parse(row.data);
      if (JSON.stringify(data) !== row.data) fail();
      if (table.table === "reference_recoveries" && row.archive !== null) {
        if (typeof row.archive !== "string") fail();
        const archive: unknown = JSON.parse(row.archive);
        if (JSON.stringify(archive) !== row.archive) fail();
        return { ...row, data, archive };
      }
      return { ...row, data };
    });
    if (
      digest(decoded.map(digest).sort()) !==
      digest(expected[table.table].map(digest).sort())
    )
      fail();
  }
  return rows;
}
export function referenceStateForBackup(
  metadata: ReferenceBackupMetadata,
  scopes: string[],
  references: CaptureRecoveryState["references"],
  digest: Digest,
): CaptureRecoveryState {
  return {
    jobs: [...metadata.jobs].sort((a, b) => a.job.id.localeCompare(b.job.id)),
    resources: [...metadata.jobResources].sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    stages: [...metadata.jobStages].sort((a, b) =>
      a.stagingId.localeCompare(b.stagingId),
    ),
    artifacts: [...metadata.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
    receipts: metadata.receipts
      .map((receipt, i) => ({ receipt, scope: scopes[i] ?? fail() }))
      .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)),
    references: [...references].sort((a, b) => {
      const left = [a.kind, a.owner, a.artifactId].join("\0");
      const right = [b.kind, b.owner, b.artifactId].join("\0");
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    otherSha256: digest(
      ["revisions", "heads", "reviews", "pins", "artifact_bindings"].map(
        (name) =>
          (
            metadata.referenceRecoveryRows.find((t) => t.table === name)
              ?.rows ?? fail()
          )
            .map(digest)
            .sort(),
      ),
    ),
  };
}
function snapshotFacts(
  record: ReferenceRecoveryRecord,
  state: CaptureRecoveryState,
  rows: ReferenceRawTable[],
  digest: Digest,
) {
  validateRecoveryRecord(record, digest);
  const original = state.jobs.find(
    (j) => j.job.id === record.reservation.binding.originalJobId,
  );
  if (!original) fail();
  const projected = projectRecoveryState(state, record, digest);
  const receipts = record.events.flatMap((e) => (e.receipt ? [e.receipt] : []));
  return {
    currentRecordSha256: digest(original),
    currentStateSha256: digest(projected),
    currentMetadataSha256: referenceRowsDigest(rows, digest, [record]),
    protectionSha256: digest(
      receipts.map((receipt) => ({
        receipt,
        references: state.references.filter(
          (r) => r.kind === "job" && r.owner === receipt.id,
        ),
        artifacts: receipt.outputs.map(
          (a) => state.artifacts.find((v) => v.id === a.id) ?? fail(),
        ),
      })),
    ),
  };
}
export function validateRecoverySnapshot(
  record: ReferenceRecoveryRecord,
  state: CaptureRecoveryState,
  rows: ReferenceRawTable[],
  digest: Digest,
) {
  const actual = snapshotFacts(record, state, rows, digest);
  const archive = record.archive;
  if (archive) {
    if (
      archive.currentRecordSha256 !== actual.currentRecordSha256 ||
      archive.currentStateSha256 !== actual.currentStateSha256 ||
      archive.currentMetadataSha256 !== actual.currentMetadataSha256 ||
      archive.protectionSha256 !== actual.protectionSha256
    )
      fail();
  } else {
    const binding = record.reservation.binding;
    if (
      binding.recordSha256 !== actual.currentRecordSha256 ||
      binding.stateSha256 !== actual.currentStateSha256 ||
      binding.metadataSha256 !== actual.currentMetadataSha256 ||
      state.jobs.find((j) => j.job.id === binding.originalJobId)?.job ===
        undefined ||
      digest(
        state.jobs.find((j) => j.job.id === binding.originalJobId)?.job,
      ) !== binding.jobSha256
    )
      fail();
  }
}
export function restoredReferenceArchive(
  source: ReferenceRecoveryRecord,
  backupSha256: string,
  state: CaptureRecoveryState,
  rows: ReferenceRawTable[],
  digest: Digest,
): ReferenceRecoveryArchive {
  const facts: Omit<ReferenceRecoveryArchive, "sha256"> = {
    kind: "restored-offline-reference-v1",
    originBackupSha256: source.archive?.originBackupSha256 ?? backupSha256,
    restoredFromBackupSha256: backupSha256,
    sourceRecordSha256: source.reservation.binding.recordSha256,
    bindingSha256: digest(source.reservation),
    ...snapshotFacts(source, state, rows, digest),
  };
  return { ...facts, sha256: digest(facts) };
}
