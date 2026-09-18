import {
  type ContractName,
  type ContractTypes,
  parseContract,
  validateContract,
} from "@design-studio/contracts";
import { storedBinding } from "./bindings.js";
import { storedJob, storedResource, storedStage } from "./job-codec.js";
import {
  type BackupMetadata,
  type ProjectBackup,
  type RetentionPin,
  StorageError,
} from "./types.js";

// Transport encoding is not a design identity or an approval authentication scheme.
export function encodeBackup(
  backup: ProjectBackup,
  maxBytes: number,
): Uint8Array {
  limit(maxBytes);
  const serialized = JSON.stringify({
    format: "design-studio-local-backup-1",
    metadata: backup.metadata,
    sha256: backup.sha256,
    blobs: backup.blobs.map((blob) => ({
      sha256: blob.sha256,
      base64: Buffer.from(blob.bytes).toString("base64"),
    })),
  });
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.length > maxBytes)
    throw new StorageError("LIMIT", "Encoded backup exceeds output budget.");
  return bytes;
}

export function decodeBackup(
  bytes: Uint8Array,
  maxBytes: number,
): ProjectBackup {
  limit(maxBytes);
  if (bytes.length > maxBytes)
    throw new StorageError("LIMIT", "Encoded backup exceeds input budget.");
  let value: unknown;
  try {
    value = parseContract(
      "JsonValue",
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "json",
      { maxInputBytes: maxBytes },
    );
  } catch (cause) {
    throw new StorageError("INVALID_INPUT", "Invalid UTF-8/JSON backup.", {
      cause,
    });
  }
  if (
    !validateContract("JsonValue", value).success ||
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== "design-studio-local-backup-1" ||
    !("metadata" in value) ||
    !("sha256" in value) ||
    !validateContract("Sha256", value.sha256).success ||
    !("blobs" in value) ||
    !Array.isArray(value.blobs) ||
    value.blobs.length > 20000 ||
    Object.keys(value).length !== 4
  ) {
    throw new StorageError(
      "INVALID_INPUT",
      "Invalid or unsupported backup envelope.",
    );
  }
  const metadata = backupMetadata(value.metadata);
  const blobs = value.blobs.map((blob: unknown) => {
    if (
      typeof blob !== "object" ||
      blob === null ||
      !("sha256" in blob) ||
      typeof blob.sha256 !== "string" ||
      !validateContract("Sha256", blob.sha256).success ||
      !("base64" in blob) ||
      typeof blob.base64 !== "string" ||
      Object.keys(blob).length !== 2 ||
      !validBase64(blob.base64)
    )
      throw new StorageError("INVALID_INPUT", "Invalid backup byte encoding.");
    const data = Buffer.from(blob.base64, "base64");
    if (data.toString("base64") !== blob.base64)
      throw new StorageError(
        "INVALID_INPUT",
        "Noncanonical backup byte encoding.",
      );
    return { sha256: blob.sha256, bytes: new Uint8Array(data) };
  });
  // Full nested contracts, reference graph, exact byte integrity and trusted origin are
  // deliberately revalidated by LocalStore.restore before any database references commit.
  return { metadata, sha256: contract("Sha256", value.sha256), blobs };
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  return true;
}

function limit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 26214400)
    throw new StorageError(
      "INVALID_INPUT",
      "Backup codec requires a finite byte budget at most 25 MiB.",
    );
}

function contract<K extends ContractName>(
  name: K,
  value: unknown,
): ContractTypes[K] {
  const result = validateContract(name, value);
  if (!result.success)
    throw new StorageError("INVALID_INPUT", `Invalid backup ${name}.`);
  return result.value;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new StorageError("INVALID_INPUT", "Unexpected backup fields.");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 20000)
    throw new StorageError("LIMIT", "Backup table exceeds bounded profile.");
  return value;
}

export function backupMetadata(value: unknown): BackupMetadata {
  contract("JsonValue", value);
  const version =
    typeof value === "object" && value !== null && "storageVersion" in value
      ? value.storageVersion
      : undefined;
  const data = record(value, [
    "storageVersion",
    "projectId",
    "artifacts",
    "revisions",
    "heads",
    "reviews",
    "receipts",
    "pins",
    ...(version === 3 || version === 4
      ? ["jobs", "jobResources", "jobStages"]
      : []),
    ...(version === 4 ? ["artifactBindings"] : []),
  ]);
  if (
    data.storageVersion !== 2 &&
    data.storageVersion !== 3 &&
    data.storageVersion !== 4
  )
    throw new StorageError(
      "SCHEMA_INCOMPATIBLE",
      "Unsupported backup metadata.",
    );
  const legacy = {
    storageVersion: 2 as const,
    projectId: contract("StableId", data.projectId),
    artifacts: array(data.artifacts).map((item) => contract("Artifact", item)),
    revisions: array(data.revisions).map((item) => contract("Revision", item)),
    heads: array(data.heads).map((item) => {
      const head = record(item, ["designId", "branch", "revisionId"]);
      return {
        designId: contract("StableId", head.designId),
        branch: contract("StableId", head.branch),
        revisionId: contract("StableId", head.revisionId),
      };
    }),
    reviews: array(data.reviews).map((item) => {
      const review = record(item, ["reference", "event"]);
      return {
        reference: contract("ArtifactReference", review.reference),
        event: contract("ReviewEvent", review.event),
      };
    }),
    receipts: array(data.receipts).map((item) =>
      contract("CommitReceipt", item),
    ),
    pins: array(data.pins).map((item): RetentionPin => {
      const pin = record(item, ["id", "kind", "artifacts"]);
      if (
        pin.kind !== "bundle" &&
        pin.kind !== "job" &&
        pin.kind !== "legal" &&
        pin.kind !== "cache"
      )
        throw new StorageError("INVALID_INPUT", "Unknown retention owner.");
      return {
        id: contract("StableId", pin.id),
        kind: pin.kind,
        artifacts: array(pin.artifacts).map((reference) =>
          contract("ArtifactReference", reference),
        ),
      };
    }),
  };
  if (data.storageVersion === 2) return legacy;
  const jobs = {
    ...legacy,
    storageVersion: 3 as const,
    jobs: array(data.jobs).map(storedJob),
    jobResources: array(data.jobResources).map(storedResource),
    jobStages: array(data.jobStages).map(storedStage),
  };
  return data.storageVersion === 3
    ? jobs
    : {
        ...jobs,
        storageVersion: 4,
        artifactBindings: array(data.artifactBindings).map(storedBinding),
      };
}
