import type {
  Artifact,
  CommitReceipt,
  ReferenceRecoveryArchive,
  ReferenceRecoveryBinding,
  ReferenceRecoveryEvidence,
  StagedArtifact,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import type Database from "better-sqlite3";
import type { CaptureRecoveryState } from "./capture-recovery.js";
import { StorageError } from "./types.js";

export const referenceRecoverySchema = `
  CREATE TABLE reference_recoveries (original_job TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, archive TEXT);
  CREATE TABLE reference_recovery_events (recovery TEXT NOT NULL REFERENCES reference_recoveries(id), sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(recovery,sequence));
`;
export interface ReferenceRecoveryReservation {
  binding: ReferenceRecoveryBinding;
  evidence: Artifact;
}
export interface ReferenceRecoveryEvent {
  sequence: number;
  previousSha256: string;
  kind:
    | "stage-intent"
    | "staged"
    | "publication-intent"
    | "committed"
    | "conversion-intent"
    | "conversion-committed";
  staged?: StagedArtifact;
  receipt?: CommitReceipt;
  introduced?: string[];
  outputs?: Artifact[];
}
export interface ReferenceRecoveryRecord {
  reservation: ReferenceRecoveryReservation;
  events: ReferenceRecoveryEvent[];
  archive?: ReferenceRecoveryArchive;
}
export const recoveryOutputs = (record: ReferenceRecoveryReservation) => [
  record.binding.historicalEvidence,
  record.binding.reference,
  record.evidence,
];
export function recoveryEvidence(
  binding: ReferenceRecoveryBinding,
  digest: (value: unknown) => string,
): ReferenceRecoveryEvidence {
  return {
    schemaVersion: "1.0",
    kind: "offline-recovered-reference",
    binding: structuredClone(binding),
    bindingSha256: digest(binding),
  };
}
export function referenceRecoveryId(
  project: string,
  original: string,
  digest: (value: unknown) => string,
) {
  return `offline_reference_${digest([
    "offline-reference-recovery-slot-v1",
    project,
    original,
  ])}`;
}
export function referenceConversionId(
  record: ReferenceRecoveryRecord,
  digest: (value: unknown) => string,
) {
  const receipt = record.events[7]?.receipt;
  if (!receipt) fail("Reference conversion requires the recovery receipt.");
  return `convert_reference_${digest([
    "figma-capture-recovered-reference-v1",
    "fixed-v2",
    record.reservation.binding.source,
    record.reservation.evidence,
    digest(receipt),
  ])}`;
}
function fail(message: string): never {
  throw new StorageError("INTEGRITY", message);
}
function fields(value: unknown, names: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== names.sort().join(",")
  )
    fail("Invalid offline recovery record fields.");
}
export function validateRecoveryRecord(
  value: ReferenceRecoveryRecord,
  digest: (value: unknown) => string,
): ReferenceRecoveryRecord {
  fields(value, [
    "reservation",
    "events",
    ...(value.archive !== undefined ? ["archive"] : []),
  ]);
  fields(value.reservation, ["binding", "evidence"]);
  const { binding, evidence } = value.reservation;
  if (
    value.archive !== undefined &&
    (!validateContract("ReferenceRecoveryArchive", value.archive).success ||
      value.archive.sourceRecordSha256 !== binding.recordSha256 ||
      value.archive.bindingSha256 !== digest(value.reservation))
  )
    fail("Invalid recovery archive binding.");
  if (value.archive) {
    const { sha256, ...facts } = value.archive;
    if (sha256 !== digest(facts)) fail("Recovery archive digest changed.");
  }
  if (
    !validateContract("ReferenceRecoveryBinding", binding).success ||
    !validateContract("Artifact", evidence).success ||
    binding.recoveryId !==
      referenceRecoveryId(binding.projectId, binding.originalJobId, digest) ||
    evidence.sha256 !== digest(recoveryEvidence(binding, digest)) ||
    evidence.byteLength > 65536 ||
    !Array.isArray(value.events) ||
    value.events.length > 10
  )
    fail("Offline recovery binding is invalid.");
  const outputs = recoveryOutputs(value.reservation);
  if (new Set(outputs.map((a) => a.id)).size !== 3)
    fail("Offline recovery outputs must be distinct.");
  for (const artifact of outputs) {
    if (
      artifact.id !== `sha256_${artifact.sha256}` ||
      artifact.path !== `blobs/${artifact.sha256}` ||
      artifact.mediaType !== "application/octet-stream"
    )
      fail("Offline recovery output identity is invalid.");
  }
  const stages: StagedArtifact[] = [];
  let previous = digest(value.reservation);
  for (const [index, event] of value.events.entries()) {
    const kind =
      index < 6
        ? index % 2
          ? "staged"
          : "stage-intent"
        : index === 6
          ? "publication-intent"
          : index === 7
            ? "committed"
            : index === 8
              ? "conversion-intent"
              : "conversion-committed";
    fields(event, [
      "sequence",
      "previousSha256",
      "kind",
      ...(kind === "staged" ? ["staged"] : []),
      ...(kind === "conversion-intent" ? ["outputs"] : []),
      ...(kind === "committed" || kind === "conversion-committed"
        ? ["receipt", "introduced"]
        : []),
    ]);
    if (
      event.sequence !== index + 1 ||
      event.previousSha256 !== previous ||
      event.kind !== kind
    )
      fail("Offline recovery event chain is invalid.");
    if (kind === "staged") {
      fields(event.staged, ["stagingId", "artifact"]);
      if (
        !event.staged ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          event.staged.stagingId,
        ) ||
        digest(event.staged.artifact) !==
          digest(outputs[Math.floor(index / 2)]) ||
        stages.some((s) => s.stagingId === event.staged?.stagingId)
      )
        fail("Offline recovery staging identity is invalid.");
      stages.push(event.staged);
    }
    if (kind === "conversion-intent") {
      if (
        !Array.isArray(event.outputs) ||
        event.outputs.length < 6 ||
        event.outputs.length > 7 ||
        new Set(event.outputs.map((a) => a.id)).size !== event.outputs.length ||
        event.outputs.some(
          (a) =>
            !validateContract("Artifact", a).success ||
            a.id !== `sha256_${a.sha256}` ||
            a.path !== `blobs/${a.sha256}` ||
            a.mediaType !== "application/octet-stream",
        )
      )
        fail("Reference conversion intent outputs are invalid.");
    }
    if (kind === "committed" || kind === "conversion-committed") {
      const receipt = event.receipt;
      const key =
        kind === "committed"
          ? binding.recoveryId
          : referenceConversionId(value, digest);
      const scope = JSON.stringify([
        binding.projectId,
        binding.actorId,
        "write",
        key,
      ]);
      const payload = receipt
        ? digest({
            outputs: [...receipt.outputs].sort((a, b) =>
              a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
            ),
            revision: null,
          })
        : "";
      if (
        !receipt ||
        !validateContract("CommitReceipt", receipt).success ||
        receipt.projectId !== binding.projectId ||
        receipt.jobId !== key ||
        receipt.idempotency.projectId !== binding.projectId ||
        receipt.idempotency.actorId !== binding.actorId ||
        receipt.idempotency.operation !== "write" ||
        receipt.idempotency.key !== key ||
        receipt.idempotency.payloadSha256 !== payload ||
        receipt.id !== `receipt-${digest([scope, payload])}` ||
        Date.parse(receipt.committedAt) < Date.parse(binding.recordedAt) ||
        receipt.integrity !== "verified" ||
        receipt.publication !== "atomic" ||
        (kind === "committed" && digest(receipt.outputs) !== digest(outputs)) ||
        (kind === "conversion-committed" &&
          digest(receipt.outputs) !== digest(value.events[8]?.outputs)) ||
        !Array.isArray(event.introduced) ||
        new Set(event.introduced).size !== event.introduced.length ||
        event.introduced.some((id) => !receipt.outputs.some((a) => a.id === id))
      )
        fail("Offline recovery receipt is invalid.");
    }
    previous = digest(event);
  }
  return structuredClone(value);
}
export function referenceRecoveryHead(
  record: ReferenceRecoveryRecord,
  digest: (value: unknown) => string,
) {
  return digest(record.events.at(-1) ?? record.reservation);
}
export function referenceRecoveryState(record: ReferenceRecoveryRecord | null) {
  return record?.archive
    ? "blocked"
    : !record
      ? "unreserved"
      : record.events.length === 0
        ? "reserved"
        : record.events[7]?.kind === "committed"
          ? "committed"
          : "blocked";
}
export function readRecoveryRecords(
  db: Database.Database,
  digest: (value: unknown) => string,
): ReferenceRecoveryRecord[] {
  if (db.pragma("user_version", { simple: true }) !== 5) return [];
  const size = db
    .prepare<[], { count: number; bytes: number }>(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))+coalesce(length(CAST(archive AS BLOB)),0)),0) AS bytes FROM reference_recoveries",
    )
    .get();
  const events = db
    .prepare<[], { count: number; bytes: number }>(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM reference_recovery_events",
    )
    .get();
  if (
    !size ||
    !events ||
    size.count < 1 ||
    size.count > 1000 ||
    events.count > 10000 ||
    size.bytes + events.bytes > 26214400
  )
    throw new StorageError(
      "LIMIT",
      "Offline recovery metadata exceeds its bound.",
    );
  return db
    .prepare<
      [],
      { original_job: string; id: string; data: string; archive: string | null }
    >(
      "SELECT original_job,id,data,archive FROM reference_recoveries ORDER BY original_job",
    )
    .all()
    .map((row) => {
      const reservation: ReferenceRecoveryReservation = JSON.parse(row.data);
      const journal = db
        .prepare<[string], { sequence: number; data: string }>(
          "SELECT sequence,data FROM reference_recovery_events WHERE recovery=? ORDER BY sequence",
        )
        .all(row.id);
      const record = validateRecoveryRecord(
        {
          reservation,
          ...(row.archive !== null
            ? {
                archive: parseContract(
                  "ReferenceRecoveryArchive",
                  row.archive,
                  "json",
                ),
              }
            : {}),
          events: journal.map((entry) => {
            const event: ReferenceRecoveryEvent = JSON.parse(entry.data);
            if (event.sequence !== entry.sequence)
              fail("Offline recovery sequence changed.");
            return event;
          }),
        },
        digest,
      );
      if (
        record.reservation.binding.recoveryId !== row.id ||
        record.reservation.binding.originalJobId !== row.original_job
      )
        fail("Offline recovery primary identity changed.");
      return record;
    });
}
export function projectRecoveryState(
  state: CaptureRecoveryState,
  record: ReferenceRecoveryRecord,
  digest: (value: unknown) => string,
): CaptureRecoveryState {
  validateRecoveryRecord(record, digest);
  let projected = structuredClone(state);
  for (const final of record.events
    .filter((e) => e.kind === "committed" || e.kind === "conversion-committed")
    .reverse()) {
    const receipt = final.receipt;
    if (!receipt) fail("Offline recovery receipt is absent.");
    const scope = JSON.stringify([
      receipt.projectId,
      receipt.idempotency.actorId,
      "write",
      receipt.jobId,
    ]);
    const rows = projected.receipts.filter((r) => r.scope === scope);
    const refs = projected.references.filter(
      (r) => r.kind === "job" && r.owner === receipt.id,
    );
    if (
      rows.length !== 1 ||
      digest(rows[0]?.receipt) !== digest(receipt) ||
      digest(refs.map((r) => r.artifactId).sort()) !==
        digest(receipt.outputs.map((a) => a.id).sort()) ||
      receipt.outputs.some(
        (a) => !projected.artifacts.some((b) => digest(a) === digest(b)),
      )
    )
      fail("Offline recovery protection graph changed.");
    const introduced = new Set(final.introduced);
    projected = {
      ...projected,
      receipts: projected.receipts.filter((r) => r.scope !== scope),
      references: projected.references.filter(
        (r) => !(r.kind === "job" && r.owner === receipt.id),
      ),
      artifacts: projected.artifacts.filter((a) => !introduced.has(a.id)),
    };
  }
  return projected;
}
export const referenceBaseTables = Object.freeze([
  "identity",
  "artifacts",
  "revisions",
  "heads",
  "reviews",
  "receipts",
  "pins",
  "artifact_refs",
  "jobs",
  "job_resources",
  "job_stages",
  "artifact_bindings",
] as const);
export type ReferenceRawRow = Record<string, string | number | null>;
const controlTables = [
  "reference_recoveries",
  "reference_recovery_events",
] as const;
export interface ReferenceRawTable {
  table: (typeof referenceBaseTables)[number] | (typeof controlTables)[number];
  rows: ReferenceRawRow[];
}
const columns: Record<ReferenceRawTable["table"], readonly string[]> = {
  identity: ["project", "root", "permission"],
  artifacts: ["id", "hash", "path", "data"],
  revisions: ["id", "design", "data"],
  heads: ["design", "branch", "revision"],
  reviews: ["id", "design", "sequence", "hash", "data"],
  receipts: ["scope", "data"],
  pins: ["kind", "id", "data"],
  artifact_refs: ["owner_kind", "owner_id", "artifact_id"],
  jobs: ["id", "scope", "state", "created", "due", "data"],
  job_resources: ["key", "data"],
  job_stages: ["id", "job", "data"],
  artifact_bindings: ["logical_id", "hash", "artifact_id", "data"],
  reference_recoveries: ["original_job", "id", "data", "archive"],
  reference_recovery_events: ["recovery", "sequence", "data"],
};
const primary: Record<ReferenceRawTable["table"], readonly string[]> = {
  identity: ["project"],
  artifacts: ["id"],
  revisions: ["id"],
  heads: ["design", "branch"],
  reviews: ["id"],
  receipts: ["scope"],
  pins: ["kind", "id"],
  artifact_refs: ["owner_kind", "owner_id", "artifact_id"],
  jobs: ["id"],
  job_resources: ["key"],
  job_stages: ["id"],
  artifact_bindings: ["logical_id", "hash"],
  reference_recoveries: ["original_job"],
  reference_recovery_events: ["recovery", "sequence"],
};
const rowKey = (table: ReferenceRawTable["table"], row: ReferenceRawRow) =>
  JSON.stringify(primary[table].map((key) => row[key]));
export function validateReferenceRows(
  value: unknown,
  controls = false,
): ReferenceRawTable[] {
  const names = controls
    ? [...referenceBaseTables, ...controlTables]
    : [...referenceBaseTables];
  if (!Array.isArray(value) || value.length !== names.length)
    fail("Recovery raw snapshot table set is invalid.");
  let remaining = 26214400;
  return value.map((entry: unknown, index) => {
    fields(entry, ["table", "rows"]);
    if (
      !entry ||
      typeof entry !== "object" ||
      !("table" in entry) ||
      !("rows" in entry)
    )
      fail("Recovery raw snapshot is invalid.");
    const table = names.find((name) => name === entry.table);
    if (
      !table ||
      table !== names[index] ||
      !Array.isArray(entry.rows) ||
      entry.rows.length > (table === "jobs" ? 1000 : 20000) ||
      (table === "identity" && entry.rows.length !== 1)
    )
      fail("Recovery raw snapshot rows exceed their closed table scope.");
    let last: string | undefined;
    const secondary = new Set<string>();
    const rows = entry.rows.map((input: unknown) => {
      fields(input, [...columns[table]]);
      if (!input || typeof input !== "object")
        fail("Invalid recovery raw row.");
      const row: ReferenceRawRow = {};
      for (const [key, cell] of Object.entries(input)) {
        if (
          typeof cell !== "string" &&
          cell !== null &&
          !(typeof cell === "number" && Number.isSafeInteger(cell))
        )
          fail("Recovery raw rows contain non-SQL values.");
        remaining -= typeof cell === "string" ? Buffer.byteLength(cell) : 16;
        if (remaining < 0)
          throw new StorageError(
            "LIMIT",
            "Recovery raw snapshot exceeds its metadata bound.",
          );
        row[key] = cell;
      }
      const key = rowKey(table, row);
      if (last !== undefined && last >= key)
        fail("Recovery raw rows are duplicated or not canonically ordered.");
      last = key;
      const extra =
        table === "jobs"
          ? JSON.stringify(row.scope)
          : table === "reviews"
            ? JSON.stringify([row.design, row.sequence])
            : key;
      if (secondary.has(extra))
        fail("Recovery raw snapshot violates uniqueness.");
      secondary.add(extra);
      return row;
    });
    return { table, rows };
  });
}
export function readReferenceRows(
  db: Database.Database,
  controls = false,
): ReferenceRawTable[] {
  let remaining = 26214400;
  const names = controls
    ? [...referenceBaseTables, ...controlTables]
    : [...referenceBaseTables];
  const tables = names.map((table) => {
    const size = db
      .prepare<[], { count: number; bytes: number }>(
        `SELECT count(*) AS count,coalesce(sum(${columns[table].map((key) => `coalesce(length(CAST(${key} AS BLOB)),0)`).join("+")}),0) AS bytes FROM ${table}`,
      )
      .get();
    if (!size || size.count > 20000 || size.bytes > remaining)
      throw new StorageError(
        "LIMIT",
        "Recovery raw metadata exceeds its pre-read bound.",
      );
    remaining -= size.bytes;
    const rows = db
      .prepare<[], ReferenceRawRow>(`SELECT * FROM ${table}`)
      .all();
    rows.sort((a, b) =>
      rowKey(table, a) < rowKey(table, b)
        ? -1
        : rowKey(table, a) > rowKey(table, b)
          ? 1
          : 0,
    );
    return { table, rows };
  });
  return validateReferenceRows(tables, controls);
}
/** Exact serialized old rows, independent of the separately authenticated control tables. */
export function referenceMetadataDigest(
  db: Database.Database,
  digest: (value: unknown) => string,
  records: ReferenceRecoveryRecord[] = [],
) {
  return referenceRowsDigest(readReferenceRows(db), digest, records);
}
export function referenceRowsDigest(
  tables: ReferenceRawTable[],
  digest: (value: unknown) => string,
  records: ReferenceRecoveryRecord[] = [],
) {
  const completed = records.flatMap((r) =>
    r.events.filter(
      (e) => e.kind === "committed" || e.kind === "conversion-committed",
    ),
  );
  const receipts = completed.flatMap((e) => (e?.receipt ? [e.receipt] : []));
  const introduced = new Set(completed.flatMap((e) => e?.introduced ?? []));
  const values = tables
    .filter((t) => referenceBaseTables.some((name) => name === t.table))
    .map(({ table, rows: raw }) => {
      const rows = raw.filter((row) => {
        if (!row || typeof row !== "object") fail("Invalid database row.");
        if (
          table === "artifacts" &&
          "id" in row &&
          typeof row.id === "string" &&
          introduced.has(row.id)
        )
          return false;
        if (
          table === "receipts" &&
          "data" in row &&
          typeof row.data === "string"
        ) {
          const receipt = parseContract("CommitReceipt", row.data, "json");
          if (receipts.some((r) => digest(r) === digest(receipt))) return false;
        }
        if (
          table === "artifact_refs" &&
          "owner_kind" in row &&
          "owner_id" in row &&
          row.owner_kind === "job" &&
          receipts.some((r) => r.id === row.owner_id)
        )
          return false;
        return true;
      });
      return [table, rows.map((row) => digest(row)).sort()];
    });
  return digest(values);
}
