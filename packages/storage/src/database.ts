import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { StorageError, type StorageOptions } from "./types.js";

const applicationId = 0x44535431;
const coreSchema = `
  CREATE TABLE identity (project TEXT NOT NULL, root TEXT NOT NULL, permission TEXT NOT NULL);
  CREATE TABLE artifacts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE revisions (id TEXT PRIMARY KEY, design TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE heads (design TEXT NOT NULL, branch TEXT NOT NULL, revision TEXT NOT NULL REFERENCES revisions(id), PRIMARY KEY(design, branch));
  CREATE TABLE reviews (id TEXT PRIMARY KEY, design TEXT NOT NULL, sequence INTEGER NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(design, sequence));
  CREATE TABLE receipts (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE pins (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
  CREATE TABLE artifact_refs (owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), PRIMARY KEY(owner_kind,owner_id,artifact_id));
`;
const jobSchema = `
  CREATE TABLE jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created TEXT NOT NULL, due TEXT, data TEXT NOT NULL);
  CREATE INDEX jobs_scan ON jobs(state,created,id);
  CREATE TABLE job_resources (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE job_stages (id TEXT PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), data TEXT NOT NULL);
  CREATE INDEX job_stages_owner ON job_stages(job,id);
`;
const bindingSchema = `
  CREATE TABLE artifact_bindings (logical_id TEXT NOT NULL, hash TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL, PRIMARY KEY(logical_id,hash));
`;

export async function openDatabase(
  options: StorageOptions,
): Promise<Database.Database> {
  const path = options.databasePath;
  if (
    !isAbsolute(path) ||
    /^(?:\\\\|\/\/)|^[a-z]+:\/\//i.test(path) ||
    path.includes("\0")
  ) {
    throw new StorageError(
      "UNSUITABLE_FILESYSTEM",
      "A host-attested local absolute database path is required.",
    );
  }
  await options.attestLocalDatabase(path, {
    projectId: options.projectId,
    artifactRootId: options.artifactRootId,
    permissionScope: options.permissionScope,
  });
  let db: Database.Database | undefined;
  try {
    db = new Database(path, {
      nativeBinding: options.nativeBinding,
      timeout: 0,
    });
    db.pragma("locking_mode = EXCLUSIVE");
    // Retained SQLite OS locks are the service lease; a dead process releases them.
    db.exec("BEGIN EXCLUSIVE; COMMIT");
    const version = db.pragma("user_version", { simple: true });
    const app = db.pragma("application_id", { simple: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (
      (version === 0 && (tables.length !== 0 || app !== 0)) ||
      (version !== 0 &&
        (app !== applicationId ||
          (version !== 1 && version !== 2 && version !== 3 && version !== 4)))
    ) {
      throw new StorageError(
        "SCHEMA_INCOMPATIBLE",
        "Unsupported or foreign database; restore a compatible backup or migrate explicitly.",
      );
    }
    if (version !== 0) {
      const identity = db
        .prepare<[], { project: string; root: string; permission: string }>(
          "SELECT project,root,permission FROM identity",
        )
        .get();
      if (
        identity?.project !== options.projectId ||
        identity.root !== options.artifactRootId ||
        identity.permission !== options.permissionScope
      )
        throw new StorageError(
          "SCHEMA_INCOMPATIBLE",
          "Database project/artifact-root/permission scope binding does not match.",
        );
    }
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      throw new StorageError("INTEGRITY", "SQLite integrity check failed.");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    if (version === 0) {
      const connection = db;
      connection.transaction(() => {
        connection.exec(coreSchema);
        connection
          .prepare("INSERT INTO identity VALUES (?,?,?)")
          .run(
            options.projectId,
            options.artifactRootId,
            options.permissionScope,
          );
        connection.exec("CREATE INDEX artifact_hash ON artifacts(hash)");
        connection.exec(jobSchema);
        connection.exec(bindingSchema);
        connection.pragma(`application_id = ${applicationId}`);
        connection.pragma("user_version = 4");
      })();
    } else if (version === 1 || version === 2 || version === 3) {
      // Every upgrade retains a separate valid database before altering schema.
      const backup = `${path}.migration-v${version}-${randomUUID()}.sqlite`;
      await db.backup(backup);
      const copy = new Database(backup, {
        nativeBinding: options.nativeBinding,
        readonly: true,
      });
      try {
        if (
          copy.pragma("integrity_check", { simple: true }) !== "ok" ||
          copy.pragma("user_version", { simple: true }) !== version
        )
          throw new StorageError(
            "INTEGRITY",
            "Migration backup verification failed.",
          );
      } finally {
        copy.close();
      }
      try {
        await options.ensureDatabaseBackupDurable(backup);
      } catch (cause) {
        throw new StorageError(
          "ACTION_REQUIRED",
          "Migration requires trusted database-backup durability; the verified backup and original schema are retained.",
          { cause },
        );
      }
      const connection = db;
      connection.transaction(() => {
        if (version === 1)
          connection.exec("CREATE INDEX artifact_hash ON artifacts(hash)");
        if (version < 3) connection.exec(jobSchema);
        connection.exec(bindingSchema);
        options.fault?.("migration-before-commit");
        connection.pragma("user_version = 4");
      })();
    }
    const foreignKeys = db.pragma("foreign_key_check");
    if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0)
      throw new StorageError(
        "INTEGRITY",
        "SQLite foreign keys are inconsistent.",
      );
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof StorageError) throw error;
    if (
      error instanceof Database.SqliteError &&
      (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
    ) {
      throw new StorageError(
        "WRITER_BUSY",
        "Another local service owns this database.",
        { cause: error },
      );
    }
    throw new StorageError(
      "IO_FAILURE",
      "Cannot open or migrate the local database; any migration backup is retained.",
      { cause: error },
    );
  }
}
