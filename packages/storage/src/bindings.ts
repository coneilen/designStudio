import type { Artifact, ArtifactReference } from "@design-studio/contracts";
import type Database from "better-sqlite3";
import { bounded, fields, jobCheck } from "./job-codec.js";
import {
  type LogicalArtifactBinding,
  StorageError,
  type StoredArtifactBinding,
} from "./types.js";

export const BINDING_LIMITS = Object.freeze({
  perCommit: 128,
  total: 20000,
  metadataBytes: 26214400,
});
export const bindingKey = (reference: ArtifactReference) =>
  JSON.stringify([reference.id, reference.sha256]);

export function binding(input: unknown): LogicalArtifactBinding {
  const data = fields(input, ["reference", "artifact"]);
  const reference = jobCheck("ArtifactReference", data.reference);
  const artifact = jobCheck("ArtifactReference", data.artifact);
  if (reference.sha256 !== artifact.sha256 || reference.id === artifact.id)
    throw new StorageError(
      "INVALID_INPUT",
      "Binding must join distinct logical/physical IDs with the same hash.",
    );
  return { reference, artifact };
}
export function storedBinding(input: unknown): StoredArtifactBinding {
  const data = fields(input, ["reference", "artifact", "receiptId"]);
  return {
    ...binding({ reference: data.reference, artifact: data.artifact }),
    receiptId: jobCheck("StableId", data.receiptId),
  };
}
export function bindings(input: unknown): LogicalArtifactBinding[] {
  const result = bounded(input, BINDING_LIMITS.perCommit).map(binding);
  if (
    new Set(result.map((item) => bindingKey(item.reference))).size !==
    result.length
  )
    throw new StorageError(
      "INVALID_INPUT",
      "Duplicate logical reference binding.",
    );
  return result.sort((a, b) =>
    bindingKey(a.reference).localeCompare(bindingKey(b.reference), "en"),
  );
}
export class ArtifactBindings {
  constructor(private readonly db: Database.Database) {}
  bounds(): void {
    const size = this.db
      .prepare<[], { count: number; bytes: number }>(
        "SELECT count(*) AS count,coalesce(sum(length(cast(data AS BLOB))),0) AS bytes FROM artifact_bindings",
      )
      .get();
    if (
      !size ||
      size.count > BINDING_LIMITS.total ||
      size.bytes > BINDING_LIMITS.metadataBytes
    )
      throw new StorageError(
        "LIMIT",
        "Binding metadata exceeds bounded profile.",
      );
  }
  get(reference: ArtifactReference): StoredArtifactBinding | undefined {
    const row = this.db
      .prepare<[string, string], { data: string; artifact_id: string }>(
        "SELECT data,artifact_id FROM artifact_bindings WHERE logical_id=? AND hash=?",
      )
      .get(reference.id, reference.sha256);
    if (!row) return undefined;
    const value = storedBinding(JSON.parse(row.data));
    if (
      bindingKey(value.reference) !== bindingKey(reference) ||
      row.artifact_id !== value.artifact.id
    )
      throw new StorageError(
        "INTEGRITY",
        "Binding key and stored identity disagree.",
      );
    return value;
  }
  all(): StoredArtifactBinding[] {
    this.bounds();
    return this.db
      .prepare<[], { data: string }>(
        "SELECT data FROM artifact_bindings ORDER BY logical_id,hash",
      )
      .all()
      .map((row) => storedBinding(JSON.parse(row.data)));
  }
  admit(values: LogicalArtifactBinding[]): void {
    const stored = this.all();
    const fresh = values.filter(
      (value) =>
        !stored.some(
          (item) => bindingKey(item.reference) === bindingKey(value.reference),
        ),
    );
    if (
      stored.length + fresh.length > BINDING_LIMITS.total ||
      Buffer.byteLength(JSON.stringify([...stored, ...fresh]), "utf8") +
        fresh.length * 256 >
        BINDING_LIMITS.metadataBytes
    )
      throw new StorageError(
        "LIMIT",
        "Binding admission exceeds bounded store capacity.",
      );
  }
  checkPhysical(artifact: Artifact): void {
    if (
      this.db
        .prepare("SELECT 1 FROM artifact_bindings WHERE logical_id=? LIMIT 1")
        .get(artifact.id)
    )
      throw new StorageError(
        "CONFLICT",
        "Physical artifact cannot shadow a logical identifier.",
      );
  }
  validate(input: LogicalArtifactBinding): void {
    if (
      this.db
        .prepare("SELECT 1 FROM artifacts WHERE id=?")
        .get(input.reference.id) ||
      this.db
        .prepare("SELECT 1 FROM artifact_bindings WHERE logical_id=? LIMIT 1")
        .get(input.artifact.id)
    )
      throw new StorageError(
        "CONFLICT",
        "Binding cannot shadow physical identity or chain aliases.",
      );
    const prior = this.get(input.reference);
    if (prior && bindingKey(prior.artifact) !== bindingKey(input.artifact))
      throw new StorageError(
        "CONFLICT",
        "Pinned logical binding is immutable.",
      );
  }
  put(input: StoredArtifactBinding): void {
    this.validate(input);
    const prior = this.get(input.reference);
    if (prior) return;
    this.db
      .prepare("INSERT INTO artifact_bindings VALUES (?,?,?,?)")
      .run(
        input.reference.id,
        input.reference.sha256,
        input.artifact.id,
        JSON.stringify(input),
      );
    this.db
      .prepare("INSERT INTO artifact_refs VALUES ('binding',?,?)")
      .run(bindingKey(input.reference), input.artifact.id);
    this.bounds();
  }
}
