import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { StoredJob, StoredJobStage } from "../src/job-types.js";

export function mutateOpenSyntheticCapture(
  store: object,
  id: string,
  change: (record: StoredJob) => void,
  onlyWhenJobExists?: string,
): void {
  const db: unknown = Reflect.get(store, "db");
  if (
    !(db instanceof Database) ||
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), db.name),
    )
  )
    throw new Error(
      "Mutation helper requires this test's open temporary database",
    );
  if (
    onlyWhenJobExists &&
    !db.prepare("SELECT 1 FROM jobs WHERE id=?").get(onlyWhenJobExists)
  )
    return;
  const row = db
    .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
    .get(id);
  if (!row) throw new Error("Missing synthetic job");
  const record: StoredJob = JSON.parse(row.data);
  change(record);
  db.prepare("UPDATE jobs SET data=?,state=? WHERE id=?").run(
    JSON.stringify(record),
    record.job.status,
    id,
  );
}

export function corruptSyntheticCapture(
  filename: string,
  nativeBinding: string,
  id: string,
  change: (record: StoredJob) => void,
): void {
  const relative = path.relative(tmpdir(), filename);
  if (
    path.isAbsolute(relative) ||
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(relative)
  )
    throw new Error(
      "Corruption helper accepts only this test's owned temporary database",
    );
  const db = new Database(filename, { nativeBinding });
  try {
    const row = db
      .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
      .get(id);
    if (!row) throw new Error("Missing synthetic job");
    const record: StoredJob = JSON.parse(row.data);
    change(record);
    db.prepare("UPDATE jobs SET data=?,state=? WHERE id=?").run(
      JSON.stringify(record),
      record.job.status,
      id,
    );
  } finally {
    db.close();
  }
}

export function corruptSyntheticCaptureStage(
  filename: string,
  nativeBinding: string,
  jobId: string,
  change: (stage: StoredJobStage) => void,
): void {
  if (
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), filename),
    )
  )
    throw new Error(
      "Stage corruption requires this test's exact temporary database",
    );
  const db = new Database(filename, { nativeBinding });
  try {
    const row = db
      .prepare<[string], { id: string; data: string }>(
        "SELECT id,data FROM job_stages WHERE job=? ORDER BY id LIMIT 1",
      )
      .get(jobId);
    if (!row) throw new Error("Missing synthetic stage");
    const stage: StoredJobStage = JSON.parse(row.data);
    change(stage);
    db.prepare("UPDATE job_stages SET data=? WHERE id=?").run(
      JSON.stringify(stage),
      row.id,
    );
  } finally {
    db.close();
  }
}

export function addSyntheticStoppedCaptures(
  filename: string,
  nativeBinding: string,
  originalId: string,
  count: number,
  digest: (value: unknown) => string,
): void {
  if (
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), filename),
    ) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1000
  )
    throw new Error(
      "Capacity fixture requires its exact temporary database and finite count",
    );
  const db = new Database(filename, { nativeBinding });
  try {
    const row = db
      .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
      .get(originalId);
    if (!row) throw new Error("Missing capacity fixture original");
    const original: StoredJob = JSON.parse(row.data);
    db.transaction(() => {
      for (let index = 0; index < count; index++) {
        const record = structuredClone(original);
        const requestId = `capacity_${index}`;
        const id = `capture_${digest([record.job.projectId, record.job.actorId, requestId])}`;
        record.job.id = id;
        record.requestId = requestId;
        record.submission.id = id;
        record.job.idempotency.key = requestId;
        record.job.idempotency.payloadSha256 = digest(record.submission);
        record.job.status = "cancelled";
        record.job.attempt = 0;
        record.rowVersion = 1;
        record.generation = 0;
        delete record.job.error;
        record.effects = [];
        record.usage = {
          inputBytes: 0,
          outputBytes: 0,
          externalCalls: 0,
          modelTokens: 0,
          costMicros: 0,
        };
        db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)").run(
          id,
          JSON.stringify([
            "job-v1",
            record.job.projectId,
            record.job.actorId,
            "capture",
            requestId,
          ]),
          "cancelled",
          record.createdAt,
          null,
          JSON.stringify(record),
        );
        for (const artifact of [
          record.job.input.id,
          record.job.resources.snapshotId,
        ])
          db.prepare("INSERT INTO artifact_refs VALUES (?,?,?)").run(
            "job-input",
            id,
            artifact,
          );
      }
    })();
  } finally {
    db.close();
  }
}
