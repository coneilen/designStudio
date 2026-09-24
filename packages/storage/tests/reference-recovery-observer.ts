import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import { ProjectFileSystem } from "@design-studio/host";
import Database from "better-sqlite3";
import { immutableDatabaseUri } from "../dist/immutable-sqlite.js";
import { LocalStore } from "../dist/index.js";
import { referenceRecoveryState } from "../dist/reference-recovery.js";
import { revision } from "./support.js";

export async function backupSyntheticOffline(root: string, database: string) {
  if (
    !/^reference-synthetic-/.test(path.basename(root)) ||
    path.dirname(database) !== root
  )
    throw new Error("Expected generated portable reference fixture.");
  const context = syntheticContext();
  context.projectId = "project_synthetic";
  context.authorization.projectId = context.projectId;
  context.authorization.actorId = "actor_synthetic";
  context.authorization.grants = [
    {
      resourceKind: "artifact",
      resourceId: "artifacts_synthetic",
      operations: ["read", "write"],
    },
  ];
  const open = async (directory: string, filename: string) => {
    const files = await ProjectFileSystem.create({
      projectId: context.projectId,
      authority: () => true,
      roots: [
        {
          id: "artifacts_synthetic",
          path: directory,
          access: "read-write",
          managedBlobs: true,
          trustedExclusiveAccess: true,
        },
      ],
    });
    const store = await LocalStore.open({
      databasePath: filename,
      nativeBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      projectId: context.projectId,
      artifactRootId: "artifacts_synthetic",
      permissionScope: "synthetic",
      canonicalBytes,
      authorize: async () => {},
      attestLocalDatabase: async () => {},
      fileSystem: files,
      ensurePublicationDurable: async () => {},
      ensureDatabaseBackupDurable: async () => {},
      verifyRevision: async () => {},
      assessApproval: async () => ({
        complete: false,
        blockingDiagnosticIds: [],
        waiverEligibleDiagnosticIds: [],
      }),
      authorizeRestore: async () => {},
      authorizeRetention: async () => {},
      canDiscardStage: async () => false,
      referenceRecovery: { authorize: async () => {}, verify: async () => {} },
      maintenance: {
        inventory: async (ctx, max) => {
          const value = await files.inventory("artifacts_synthetic", ctx, max);
          if (value.status !== "complete")
            throw new Error("Synthetic inventory failed.");
          return value.value;
        },
        removeBlob: async () => {
          throw new Error("Protected recovery bytes must not be removed.");
        },
      },
    });
    return { files, store };
  };
  const source = await open(path.join(root, "artifacts"), database);
  try {
    const backup = await source.store.backup(context);
    if (
      backup.status !== "complete" ||
      backup.value.metadata.storageVersion !== 5
    )
      throw new Error(`Synthetic backup failed: ${JSON.stringify(backup)}`);
    const ordinary = {
      ...context,
      jobId: "ordinary_write",
      requestId: "ordinary_write",
    };
    const firstJob = backup.value.metadata.jobs[0];
    if (!firstJob) throw new Error("Synthetic original job missing.");
    const mutations = [
      () =>
        source.store.stage(Buffer.from("forbidden ordinary stage"), ordinary),
      () => source.store.commit([], ordinary),
      () =>
        source.store.commitRevision(
          {
            branch: "sealed",
            base: null,
            outputs: [],
            revision: {
              ...revision(
                "sealed_revision",
                backup.value.metadata.artifacts.slice(0, 3),
              ),
              projectId: context.projectId,
            },
          },
          ordinary,
        ),
      () => source.store.checkOrdinaryWrite(ordinary),
      () => source.store.pin("cache", "forbidden_pin", [], ordinary),
      () => source.store.releasePin("cache", "forbidden_pin", ordinary),
      () => source.store.jobs.create(firstJob.submission, ordinary),
      () =>
        source.store.jobs.claim(
          firstJob.job.id,
          { state: firstJob.job.status, rowVersion: firstJob.rowVersion },
          "ordinary_owner",
          1000,
          ordinary,
        ),
      () =>
        source.store.jobs.requestCancel(
          firstJob.job.id,
          firstJob.rowVersion,
          ordinary,
        ),
      () =>
        source.store.jobs.reconcile(
          firstJob.job.id,
          firstJob.rowVersion,
          {
            kind: "interrupt",
            error: {
              code: "INTERRUPTED",
              message: "synthetic",
              retryable: false,
              diagnosticIds: [],
            },
          },
          ordinary,
        ),
    ];
    for (const mutate of mutations) {
      const result = await mutate();
      if (
        result.status === "complete" ||
        result.status === "partial" ||
        result.error.code !== "ACTION_REQUIRED"
      )
        throw new Error(
          `Ordinary sealed mutation was not denied before effects: ${JSON.stringify(result)}`,
        );
    }
    const unchanged = await source.store.backup(context);
    if (
      unchanged.status !== "complete" ||
      unchanged.value.sha256 !== backup.value.sha256
    )
      throw new Error(
        "Denied ordinary mutations changed recovery backup state.",
      );
    const gc = await source.store.collectGarbage(context);
    if (gc.status !== "complete" || gc.value.deleted.length)
      throw new Error("Synthetic recovery protection failed.");
    const destination = path.join(root, "restored");
    await mkdir(destination);
    const restored = await open(
      destination,
      path.join(root, "restored.sqlite"),
    );
    try {
      for (const kind of [
        "event",
        "original-record",
        "raw-row",
        "ref-edge",
        "duplicate-row",
      ]) {
        const bad = structuredClone(backup.value);
        if (bad.metadata.storageVersion !== 5)
          throw new Error("Synthetic schema changed.");
        const record = bad.metadata.referenceRecoveries[0];
        const event = record?.events[0];
        const job = bad.metadata.jobs.find(
          (j) => j.job.id === record?.reservation.binding.originalJobId,
        );
        const rows = bad.metadata.referenceRecoveryRows.find(
          (t) => t.table === "jobs",
        )?.rows;
        const row = rows?.find((r) => r.id === job?.job.id);
        if (!event || !job || !row || !rows)
          throw new Error("Synthetic recovery fixture missing.");
        if (kind === "event") event.previousSha256 = "0".repeat(64);
        if (kind === "event") {
          const raw = bad.metadata.referenceRecoveryRows
            .find((t) => t.table === "reference_recovery_events")
            ?.rows.find(
              (r) =>
                r.recovery === record?.reservation.binding.recoveryId &&
                r.sequence === event.sequence,
            );
          if (raw) raw.data = JSON.stringify(event);
        }
        if (kind === "original-record") {
          job.rowVersion++;
          row.data = JSON.stringify(job);
        }
        if (kind === "raw-row") row.data = `${row.data} `;
        if (kind === "duplicate-row") rows.push(structuredClone(row));
        if (kind === "ref-edge")
          bad.metadata.referenceRecoveryRows
            .find((t) => t.table === "artifact_refs")
            ?.rows.pop();
        bad.sha256 = canonicalDigest(bad.metadata);
        if ((await restored.store.restore(bad, context)).status === "complete")
          throw new Error(`Tampered ${kind} recovery backup was accepted.`);
      }
      const result = await restored.store.restore(backup.value, context);
      if (result.status !== "complete")
        throw new Error(`Synthetic restore failed: ${JSON.stringify(result)}`);
      const roundtrip = await restored.store.backup(context);
      if (
        roundtrip.status !== "complete" ||
        roundtrip.value.metadata.storageVersion !== 5
      )
        throw new Error("Synthetic restored backup failed.");
      const old = backup.value.metadata;
      const current = roundtrip.value.metadata;
      if (
        canonicalDigest(
          old.referenceRecoveries.map((r) => [r.reservation, r.events]),
        ) !==
          canonicalDigest(
            current.referenceRecoveries.map((r) => [r.reservation, r.events]),
          ) ||
        canonicalDigest(old.receipts) !== canonicalDigest(current.receipts) ||
        canonicalDigest(old.jobs) === canonicalDigest(current.jobs)
      )
        throw new Error(
          "Recovery archive or restore fencing changed unexpectedly.",
        );
      const archive = current.referenceRecoveries[0]?.archive;
      if (
        !archive ||
        archive.originBackupSha256 !== backup.value.sha256 ||
        referenceRecoveryState(current.referenceRecoveries[0] ?? null) !==
          "blocked"
      )
        throw new Error("Restored recovery was not explicitly archival.");
      const destination2 = path.join(root, "restored-twice");
      await mkdir(destination2);
      const repeated = await open(
        destination2,
        path.join(root, "restored-twice.sqlite"),
      );
      try {
        for (const kind of [
          "removed",
          "origin",
          "current",
          "protection",
          "row",
        ]) {
          const bad = structuredClone(roundtrip.value);
          if (bad.metadata.storageVersion !== 5)
            throw new Error("Synthetic archive schema changed.");
          const record = bad.metadata.referenceRecoveries[0];
          if (!record?.archive) throw new Error("Archive marker absent.");
          if (kind === "removed") delete record.archive;
          else if (kind === "origin")
            record.archive.originBackupSha256 = "0".repeat(64);
          else if (kind === "current" || kind === "protection") {
            if (kind === "current")
              record.archive.currentRecordSha256 = "0".repeat(64);
            else record.archive.protectionSha256 = "0".repeat(64);
            const { sha256: _sha, ...facts } = record.archive;
            record.archive.sha256 = canonicalDigest(facts);
          } else {
            const job = bad.metadata.jobs[0];
            if (!job) throw new Error("Missing archived job.");
            job.rowVersion++;
          }
          const raw = bad.metadata.referenceRecoveryRows
            .find((t) => t.table === "reference_recoveries")
            ?.rows.find((r) => r.id === record.reservation.binding.recoveryId);
          if (!raw) throw new Error("Missing archive raw control row.");
          raw.archive = record.archive ? JSON.stringify(record.archive) : null;
          bad.sha256 = canonicalDigest(bad.metadata);
          if (
            (await repeated.store.restore(bad, context)).status === "complete"
          )
            throw new Error(`Tampered archive ${kind} was accepted.`);
        }
        const result = await repeated.store.restore(roundtrip.value, context);
        if (result.status !== "complete")
          throw new Error(
            `Repeated archive restore failed: ${JSON.stringify(result)}`,
          );
        const next = await repeated.store.backup(context);
        if (
          next.status !== "complete" ||
          next.value.metadata.storageVersion !== 5
        )
          throw new Error("Repeated archive backup failed.");
        const marker = next.value.metadata.referenceRecoveries[0]?.archive;
        if (
          !marker ||
          marker.originBackupSha256 !== archive.originBackupSha256 ||
          marker.restoredFromBackupSha256 !== roundtrip.value.sha256 ||
          marker.currentRecordSha256 === archive.currentRecordSha256
        )
          throw new Error(
            "Repeated archive marker did not rebind fenced history.",
          );
        const gc = await repeated.store.collectGarbage(context);
        if (gc.status !== "complete" || gc.value.deleted.length)
          throw new Error("Archived recovery GC protection failed.");
        const database: unknown = Reflect.get(repeated.store, "db");
        if (!(database instanceof Database))
          throw new Error("Synthetic database observer is unavailable.");
        const saved = database
          .prepare<[], { id: string; archive: string }>(
            "SELECT id,archive FROM reference_recoveries",
          )
          .get();
        if (!saved) throw new Error("Synthetic archive row is missing.");
        try {
          database
            .prepare("UPDATE reference_recoveries SET archive=NULL WHERE id=?")
            .run(saved.id);
          if (
            (await repeated.store.referenceRecoverySnapshot(context)).status ===
            "complete"
          )
            throw new Error("Removed archival marker upgraded fenced history.");
          if (
            (await repeated.store.collectGarbage(context)).status === "complete"
          )
            throw new Error("GC ignored a removed archival marker.");
        } finally {
          database
            .prepare("UPDATE reference_recoveries SET archive=? WHERE id=?")
            .run(saved.archive, saved.id);
        }
      } finally {
        repeated.store.close();
        await repeated.files.closePreservingStages();
      }
      return {
        recoveryRecords: current.referenceRecoveries.length,
        restoredExecution: "fenced-not-resumable",
        gcDeleted: 0,
        tamperedDenied: true,
      };
    } finally {
      restored.store.close();
      await restored.files.closePreservingStages();
    }
  } finally {
    source.store.close();
    await source.files.closePreservingStages();
  }
}

/** Only the generated synthetic application fixture may use this raw test observer. */
export async function observeSyntheticReference(
  root: string,
  database: string,
) {
  if (
    !/^(reference-synthetic-|ds-ph-reference-)/.test(path.basename(root)) ||
    ![root, path.join(root, "db")].includes(path.dirname(database)) ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error("Expected synthetic reference fixture.");
  const binding = path.resolve(
    ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
  );
  const db = new Database(immutableDatabaseUri(database, binding), {
    nativeBinding: binding,
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = Object.fromEntries(
      ["jobs", "job_resources", "job_stages", "receipts", "artifacts"].map(
        (table) => [table, db.prepare(`SELECT * FROM ${table}`).all()],
      ),
    );
    const schema = db.pragma("user_version", { simple: true });
    const controls =
      schema === 5
        ? db.prepare("SELECT * FROM reference_recoveries ORDER BY id").all()
        : [];
    const events =
      schema === 5
        ? db
            .prepare(
              "SELECT * FROM reference_recovery_events ORDER BY recovery,sequence",
            )
            .all()
        : [];
    const files: {
      name: string;
      hash: string;
      inode: number;
      links: number;
    }[] = [];
    const { createHash } = await import("node:crypto");
    for (const dir of await readdir(path.join(root, "artifacts"))) {
      if (!/^\.host-[a-f0-9-]+$/.test(dir)) continue;
      for (const name of await readdir(path.join(root, "artifacts", dir))) {
        const filename = path.join(root, "artifacts", dir, name);
        const stat = await lstat(filename);
        files.push({
          name: `${dir}/${name}`,
          hash: createHash("sha256")
            .update(await readFile(filename))
            .digest("hex"),
          inode: stat.ino,
          links: stat.nlink,
        });
      }
    }
    return {
      rows,
      schema,
      controls,
      events,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    db.close();
  }
}
