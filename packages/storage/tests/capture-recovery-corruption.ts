import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FigmaReferenceEvidence } from "@design-studio/contracts";
import Database from "better-sqlite3";
import type { StoredJob, StoredJobStage } from "../src/job-types.js";

export function rewriteSyntheticRetainedEvidence(
  filename: string,
  nativeBinding: string,
  jobId: string,
  change: (evidence: FigmaReferenceEvidence, image: Buffer) => void,
  canonical: (value: unknown) => Uint8Array,
): void {
  if (
    !/^reference-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), filename),
    ) ||
    !jobId.startsWith("diagnostic_")
  )
    throw new Error(
      "Retained evidence corruption requires the exact synthetic fixture",
    );
  const db = new Database(filename, { nativeBinding });
  try {
    const rows = db
      .prepare<[string], { data: string }>(
        "SELECT data FROM job_stages WHERE job=? ORDER BY id",
      )
      .all(jobId);
    if (rows.length !== 2)
      throw new Error("Expected two synthetic retained stages");
    const stages = rows.map((row) => JSON.parse(row.data) as StoredJobStage);
    const root = path.join(path.dirname(filename), "artifacts");
    const bodies = stages.map((stage) => {
      const artifact = stage.staged.artifact;
      if (
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        artifact.path !== `blobs/${artifact.sha256}`
      )
        throw new Error("Synthetic stage path is not canonical");
      return readFileSync(path.join(root, artifact.path));
    });
    const index = bodies.findIndex((body) => body[0] === 0x7b);
    const json = bodies[index];
    const image = bodies[1 - index];
    const jsonStage = stages[index];
    const imageStage = stages[1 - index];
    if (!json || !image || !jsonStage || !imageStage)
      throw new Error("Missing synthetic role");
    const evidence: FigmaReferenceEvidence = JSON.parse(json.toString("utf8"));
    change(evidence, image);
    const rewrite = (stage: StoredJobStage, bytes: Uint8Array) => {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const old = stage.staged.artifact;
      if (old.sha256 !== hash) {
        writeFileSync(path.join(root, "blobs", hash), bytes, { flag: "wx" });
        unlinkSync(path.join(root, old.path));
      }
      stage.staged.artifact = {
        ...old,
        id: `sha256_${hash}`,
        sha256: hash,
        path: `blobs/${hash}`,
        byteLength: bytes.length,
      };
      db.prepare("UPDATE job_stages SET data=? WHERE id=?").run(
        JSON.stringify(stage),
        stage.stagingId,
      );
    };
    rewrite(imageStage, image);
    if (evidence.reference)
      evidence.reference.artifact = {
        id: imageStage.staged.artifact.id,
        sha256: imageStage.staged.artifact.sha256,
      };
    let encoded = canonical(evidence);
    for (let i = 0; i < 8; i++) {
      evidence.usage.persistedBytes = image.length + encoded.length;
      encoded = canonical(evidence);
    }
    rewrite(jsonStage, encoded);
    const row = db
      .prepare<[string], { data: string }>("SELECT data FROM jobs WHERE id=?")
      .get(jobId);
    if (!row) throw new Error("Missing synthetic diagnostic");
    const record: StoredJob = JSON.parse(row.data);
    record.usage.inputBytes = image.length + encoded.length;
    record.usage.outputBytes = record.usage.inputBytes;
    db.prepare("UPDATE jobs SET data=? WHERE id=?").run(
      JSON.stringify(record),
      jobId,
    );
  } finally {
    db.close();
  }
}

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

export function removeSyntheticCaptureProtection(
  store: object,
  jobId: string,
): void {
  const db: unknown = Reflect.get(store, "db");
  if (
    !(db instanceof Database) ||
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), db.name),
    )
  )
    throw new Error(
      "Protection corruption requires the exact open temporary fixture database",
    );
  const result = db
    .prepare(
      "DELETE FROM artifact_refs WHERE owner_kind='job-input' AND owner_id=?",
    )
    .run(jobId);
  if (!result.changes) throw new Error("Missing synthetic protected inputs");
}

export function addSyntheticCaptureProtection(
  store: object,
  jobId: string,
  kind: "job-input" | "job",
): void {
  const db: unknown = Reflect.get(store, "db");
  if (
    !(db instanceof Database) ||
    !/^capture-recovery-synthetic-[^\\]+\\state\.sqlite$/.test(
      path.relative(tmpdir(), db.name),
    )
  )
    throw new Error(
      "Protection corruption requires the exact open temporary fixture database",
    );
  const extra = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM artifact_refs WHERE owner_kind='job-input' AND owner_id=?) ORDER BY id LIMIT 1",
    )
    .get(jobId);
  if (!extra) throw new Error("Missing extra synthetic artifact");
  db.prepare("INSERT INTO artifact_refs VALUES (?,?,?)").run(
    kind,
    jobId,
    extra.id,
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
