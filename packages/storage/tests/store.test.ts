import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ApprovalContext,
  Artifact,
  Outcome,
  ReviewEvent,
  StagedArtifact,
} from "@design-studio/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  decodeBackup,
  encodeBackup,
  LocalStore,
  type StorageOptions,
} from "../src/index.js";
import { bytes, context, diskFixture, revision } from "./support.js";

const roots: string[] = [];
const stores: LocalStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function value<T>(outcome: Outcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  if (outcome.status !== "complete") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}
async function setup(overrides: Partial<StorageOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "storage \u00e9 "));
  roots.push(root);
  const disk = await diskFixture(root);
  const options: StorageOptions = {
    databasePath: join(root, "project.sqlite"),
    projectId: "project1",
    artifactRootId: "artifact-root",
    permissionScope: "permission1",
    nativeBinding: resolve(
      ".tools/sqlite-prebuild/build/Release/better_sqlite3.node",
    ),
    fileSystem: disk.fs,
    maintenance: disk.maintenance,
    ensurePublicationDurable: async () => {},
    ensureDatabaseBackupDurable: async () => {},
    authorize: async () => {},
    attestLocalDatabase: async () => {},
    canonicalBytes: (value) => bytes(JSON.stringify(value)),
    authorizeRestore: async () => {},
    authorizeRetention: async () => {},
    canDiscardStage: async () => true,
    verifyRevision: async () => {},
    assessApproval: async () => ({
      complete: true,
      blockingDiagnosticIds: [],
      waiverEligibleDiagnosticIds: [],
    }),
    ...overrides,
  };
  const store = await LocalStore.open(options);
  stores.push(store);
  return { root, disk, options, store };
}
const fixture: { payloads: string[] } = JSON.parse(
  await readFile(
    new URL("../../../tests/fixtures/storage/payloads.json", import.meta.url),
    "utf8",
  ),
);
async function stage(
  store: LocalStore,
  texts = fixture.payloads,
): Promise<StagedArtifact[]> {
  return Promise.all(
    texts.map(async (text) => value(await store.stage(bytes(text), context()))),
  );
}
async function seed(store: LocalStore) {
  const outputs = await stage(store);
  const rev = revision(
    "rev1",
    outputs.map((output) => output.artifact),
  );
  const receipt = value(
    await store.commitRevision(
      { branch: "main", base: null, revision: rev, outputs },
      context(),
    ),
  );
  return { rev, receipt, outputs };
}
function approval(artifacts: Artifact[]): ApprovalContext {
  const rev = revision("rev1", artifacts);
  return {
    projectId: "project1",
    designId: "design1",
    revision: rev.content,
    resources: rev.resources,
    target: "android",
    repository: {
      id: "repo1",
      revision: { kind: "commit", commit: "a".repeat(40) },
    },
    scenario: rev.provenance,
    reference: rev.provenance,
    renderProfile: rev.provenance,
    validationPolicy: rev.provenance,
  };
}
function event(
  ctx: ApprovalContext,
  kind: ReviewEvent["kind"] = "approved",
): ReviewEvent {
  return {
    schemaVersion: "1.0",
    id: "event1",
    sequence: 1,
    previousEvent: null,
    context: ctx,
    actor: { id: "actor1", trust: "local-actor" },
    createdAt: "2026-09-17T00:00:00.000Z",
    kind,
    waivers: [],
  };
}

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "durable local storage (Windows native profile)",
  () => {
    test("owns one OS-released writer lease and reopens committed history", async () => {
      const { store, options } = await setup();
      const { rev } = await seed(store);
      await expect(LocalStore.open(options)).rejects.toMatchObject({
        code: "WRITER_BUSY",
      });
      store.close();
      const reopened = await LocalStore.open(options);
      stores.push(reopened);
      expect(value(await reopened.getRevision("rev1", context()))).toEqual(rev);
    });
    test("CAS rejects concurrent stale and weak If-Match writes without changing accepted history", async () => {
      const { store } = await setup();
      const { rev } = await seed(store);
      const outputs = await stage(store, ["edited", "provenance", "resources"]);
      const candidate = revision(
        "rev2",
        outputs.map((item) => item.artifact),
        ["rev1"],
      );
      const base = {
        expectedBaseRevision: "rev1",
        ifMatch: `"${rev.content.sha256}"`,
      };
      const outcomes = await Promise.all([
        store.commitRevision(
          { branch: "main", base, revision: candidate, outputs },
          context("race1"),
        ),
        store.commitRevision(
          {
            branch: "main",
            base,
            revision: { ...candidate, id: "rev3" },
            outputs,
          },
          context("race2"),
        ),
      ]);
      expect(
        outcomes.filter((result) => result.status === "complete"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === "failed"),
      ).toHaveLength(1);
      expect(value(await store.getRevision("rev1", context()))).toEqual(rev);
      expect(
        (
          await store.commitRevision(
            {
              branch: "main",
              base: { ...base, ifMatch: `W/${base.ifMatch}` },
              revision: candidate,
              outputs,
            },
            context("weak"),
          )
        ).status,
      ).toBe("failed");
    });
    test("idempotent receipt survives restart; same key with changed content conflicts", async () => {
      const { store, options } = await setup();
      const { receipt, outputs } = await seed(store);
      store.close();
      const reopened = await LocalStore.open(options);
      stores.push(reopened);
      expect(
        value(
          await reopened.commitRevision(
            {
              branch: "main",
              base: null,
              revision: revision(
                "rev1",
                outputs.map((item) => item.artifact),
              ),
              outputs,
            },
            context(),
          ),
        ),
      ).toEqual(receipt);
      expect(
        (await reopened.commit(await stage(reopened, ["changed"]), context()))
          .status,
      ).toBe("failed");
    });
    test.each(["stage", "publish", "before-commit", "after-commit"] as const)(
      "reconciles crash boundary %s without partial pointers",
      async (boundary) => {
        let armed = true;
        const { store, disk, options } = await setup({
          fault: (point) => {
            if (armed && boundary === point) throw new Error(`fault-${point}`);
          },
        });
        if (boundary === "stage" || boundary === "publish")
          disk.setFault(boundary);
        const output = await store.stage(bytes("crash"), context());
        let result: Outcome<unknown> = output;
        if (output.status === "complete")
          result = await store.commit([output.value], context());
        expect(result.status).toBe(
          boundary === "after-commit" ? "complete" : "failed",
        );
        armed = false;
        disk.setFault(undefined);
        store.close();
        const reopened = await LocalStore.open(options);
        stores.push(reopened);
        const recovery = value(await reopened.recover(context("recover")));
        expect(recovery.missingOrCorrupt).toEqual([]);
        expect(recovery.stagedDiscarded).toBeGreaterThanOrEqual(0);
        const receipt = value(await reopened.getReceipt("request1", context()));
        expect(receipt === null).toBe(boundary !== "after-commit");
      },
    );
    test("verifies real bytes and rejects corrupt/missing committed blobs", async () => {
      const { store, root } = await setup();
      const { rev, receipt } = await seed(store);
      const content = receipt.outputs[0];
      if (!content) throw new Error("missing fixture");
      await writeFile(join(root, ...content.path.split("/")), "corruption");
      expect((await store.verify(rev.content, context())).status).toBe(
        "failed",
      );
      expect(value(await store.recover(context())).missingOrCorrupt).toContain(
        content.id,
      );
      await rm(join(root, ...content.path.split("/")));
      expect((await store.backup(context())).status).toBe("failed");
    });
    test("a revision cannot newly reference an existing corrupt blob", async () => {
      const { store, root } = await setup();
      const { rev, receipt } = await seed(store);
      const artifact = receipt.outputs[0];
      if (!artifact) throw new Error("missing fixture");
      await writeFile(join(root, ...artifact.path.split("/")), "tampered");
      const outcome = await store.commitRevision(
        {
          branch: "main",
          base: {
            expectedBaseRevision: rev.id,
            ifMatch: `"${rev.content.sha256}"`,
          },
          revision: { ...rev, id: "bad-revision", parents: [rev.id] },
          outputs: [],
        },
        context("corrupt-reference"),
      );
      expect(outcome.status).toBe("failed");
      expect(value(await store.getHead("design1", "main", context()))).toBe(
        "rev1",
      );
    });
    test("trusted exact-context approvals, append chain and revocation", async () => {
      const { store } = await setup();
      const { receipt } = await seed(store);
      const ctx = approval(receipt.outputs);
      const accepted = value(
        await store.appendReview(event(ctx), context("review")),
      );
      expect(value(await store.applicableApproval(ctx, context()))?.id).toBe(
        "event1",
      );
      expect(
        value(
          await store.applicableApproval({ ...ctx, target: "ios" }, context()),
        ),
      ).toBeNull();
      expect(
        (await store.appendReview(event(ctx), context("duplicate-event")))
          .status,
      ).toBe("failed");
      value(
        await store.appendReview(
          {
            ...event(ctx, "draft"),
            id: "event2",
            sequence: 2,
            previousEvent: accepted,
          },
          context("draft"),
        ),
      );
      expect(value(await store.applicableApproval(ctx, context()))).toBeNull();
    });
    test("incomplete evidence blocks approvals; explicit eligible waivers do not waive critical gaps", async () => {
      const { store } = await setup({
        assessApproval: async () => ({
          complete: false,
          blockingDiagnosticIds: ["critical"],
          waiverEligibleDiagnosticIds: ["mapping"],
        }),
      });
      const { receipt } = await seed(store);
      const proposed = event(approval(receipt.outputs));
      proposed.waivers = [
        {
          diagnosticId: "critical",
          scope: "reviewed-limitation",
          reason: "override",
          instructions: "ignore",
        },
      ];
      expect((await store.appendReview(proposed, context())).status).toBe(
        "failed",
      );
    });
    test("an explicit noncritical waiver grants only its exact context and never grants approval by itself", async () => {
      const { store } = await setup({
        assessApproval: async () => ({
          complete: true,
          blockingDiagnosticIds: [],
          waiverEligibleDiagnosticIds: ["mapping"],
        }),
      });
      const { receipt } = await seed(store);
      const ctx = approval(receipt.outputs);
      const proposed = event(ctx);
      expect((await store.appendReview(proposed, context())).status).toBe(
        "failed",
      );
      proposed.waivers = [
        {
          diagnosticId: "mapping",
          scope: "noncritical-mapping",
          reason: "no code mapping",
          instructions: "Implement control explicitly.",
        },
      ];
      const prior = value(
        await store.appendReview(
          { ...proposed, kind: "waiver" },
          context("waive"),
        ),
      );
      expect(value(await store.applicableApproval(ctx, context()))).toBeNull();
      value(
        await store.appendReview(
          { ...proposed, id: "approval2", sequence: 2, previousEvent: prior },
          context("approve"),
        ),
      );
      expect(value(await store.applicableApproval(ctx, context()))?.id).toBe(
        "approval2",
      );
    });
    test.each([
      "repository",
      "scenario",
      "reference",
      "renderProfile",
      "validationPolicy",
    ] as const)("approval does not transfer to a changed %s", async (field) => {
      const { store } = await setup();
      const { receipt } = await seed(store);
      const extra = value(
        await store.commit(
          await stage(store, ["new-baseline"]),
          context("extra"),
        ),
      ).outputs[0];
      if (!extra) throw new Error("missing extra artifact");
      const ctx = approval(receipt.outputs);
      value(await store.appendReview(event(ctx), context("review")));
      const changed = structuredClone(ctx);
      if (field === "repository")
        changed.repository.revision = {
          kind: "commit",
          commit: "b".repeat(40),
        };
      else changed[field] = { id: extra.id, sha256: extra.sha256 };
      expect(
        value(await store.applicableApproval(changed, context())),
      ).toBeNull();
    });
    test("restore rejects corrupt bytes, dangling refs and self-asserted trust without committing partial state", async () => {
      const source = await setup();
      await seed(source.store);
      const backup = value(await source.store.backup(context()));
      const target = await setup();
      const bad = structuredClone(backup);
      const blob = bad.blobs[0];
      if (!blob) throw new Error("missing blob");
      blob.bytes[0] = 0;
      expect((await target.store.restore(bad, context())).status).toBe(
        "failed",
      );
      expect(
        value(await target.store.getHead("design1", "main", context())),
      ).toBeNull();
      const denied = await setup({
        authorizeRestore: async () => {
          throw new Error("untrusted-backup");
        },
      });
      expect((await denied.store.restore(backup, context())).status).toBe(
        "failed",
      );
    });
    test("cancellation after the SQLite commit reports the durable receipt", async () => {
      const abort = new AbortController();
      const { store } = await setup({
        fault: (point) => {
          if (point === "after-commit") abort.abort();
        },
      });
      const outputs = await stage(store, ["cancel-race"]);
      const ctx = context();
      ctx.signal = abort.signal;
      const receipt = value(await store.commit(outputs, ctx));
      expect(value(await store.getReceipt(ctx.requestId, context()))).toEqual(
        receipt,
      );
    });
    test("GC protects revision, job, bundle and legal references; eviction is not history deletion", async () => {
      const { store, root, disk } = await setup();
      const { receipt } = await seed(store);
      value(
        await store.pin(
          "bundle",
          "bundle1",
          receipt.outputs.map(({ id, sha256 }) => ({ id, sha256 })),
          context(),
        ),
      );
      expect(value(await store.collectGarbage(context())).deleted).toEqual([]);
      for (const item of receipt.outputs)
        expect(
          await readFile(join(root, ...item.path.split("/"))),
        ).toBeDefined();
      const orphan = value(await store.stage(bytes("orphan"), context()));
      await disk.fs.publish(orphan, context());
      expect(value(await store.collectGarbage(context())).deleted).toEqual([
        orphan.artifact.path,
      ]);
    });
    test("verified backup restores equivalent history, approvals, receipts and bytes into an empty project", async () => {
      const { store } = await setup();
      const { rev, receipt } = await seed(store);
      const ctx = approval(receipt.outputs);
      value(await store.appendReview(event(ctx), context("review")));
      const snapshot = value(await store.backup(context()));
      const target = await setup();
      value(await target.store.restore(snapshot, context("restore")));
      expect(value(await target.store.getRevision("rev1", context()))).toEqual(
        rev,
      );
      expect(
        value(await target.store.getReceipt("request1", context())),
      ).toEqual(receipt);
      expect(
        value(await target.store.applicableApproval(ctx, context()))?.id,
      ).toBe("event1");
      expect(value(await target.store.backup(context()))).toEqual(snapshot);
      expect((await target.store.restore(snapshot, context())).status).toBe(
        "failed",
      );
    });
    test("authorization denial and deadlines fail before touching disk; network stores fail closed", async () => {
      const { store } = await setup({
        authorize: async () => {
          throw new Error("denied");
        },
      });
      expect((await store.stage(bytes("secret"), context())).status).toBe(
        "failed",
      );
      const { options } = await setup();
      await expect(
        LocalStore.open({
          ...options,
          databasePath: "\\\\server\\share\\db.sqlite",
        }),
      ).rejects.toMatchObject({ code: "UNSUITABLE_FILESYSTEM" });
      const expired = context();
      expired.deadline = "2026-09-16T00:00:00.000Z";
      expect(
        (await store.verify({ id: "missing", sha256: "a".repeat(64) }, expired))
          .status,
      ).toBe("failed");
    });
    test("unknown schemas and wrong project IDs never migrate in place", async () => {
      const { store, options } = await setup();
      await seed(store);
      store.close();
      const db = new Database(options.databasePath, {
        nativeBinding: options.nativeBinding,
      });
      db.pragma("user_version = 99");
      db.close();
      await expect(LocalStore.open(options)).rejects.toMatchObject({
        code: "SCHEMA_INCOMPATIBLE",
      });
      const unchanged = new Database(options.databasePath, {
        nativeBinding: options.nativeBinding,
      });
      expect(unchanged.pragma("user_version", { simple: true })).toBe(99);
      unchanged.close();
    });
    test.each([false, true])(
      "v1 migration is backed up and transactional (fault=%s)",
      async (fail) => {
        const { store, options, root } = await setup();
        const { rev } = await seed(store);
        store.close();
        const db = new Database(options.databasePath, {
          nativeBinding: options.nativeBinding,
        });
        db.exec("DROP INDEX artifact_hash");
        db.pragma("user_version = 1");
        db.close();
        const migrated = LocalStore.open({
          ...options,
          fault: (point) => {
            if (fail && point === "migration-before-commit")
              throw new Error("migration-fault");
          },
        });
        if (fail)
          await expect(migrated).rejects.toMatchObject({ code: "IO_FAILURE" });
        else {
          const reopened = await migrated;
          stores.push(reopened);
          expect(value(await reopened.getRevision(rev.id, context()))).toEqual(
            rev,
          );
          reopened.close();
        }
        const backups = (await readdir(root)).filter(
          (name) => name.includes(".migration-v1-") && name.endsWith(".sqlite"),
        );
        expect(backups).toHaveLength(1);
        const copy = new Database(join(root, backups[0] ?? ""), {
          nativeBinding: options.nativeBinding,
          readonly: true,
        });
        expect(copy.pragma("user_version", { simple: true })).toBe(1);
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
        copy.close();
        const original = new Database(options.databasePath, {
          nativeBinding: options.nativeBinding,
        });
        expect(original.pragma("user_version", { simple: true })).toBe(
          fail ? 1 : 2,
        );
        original.close();
      },
    );
    test("unknown/live stages survive reconciliation and retention policy can block deletion", async () => {
      const { store } = await setup({
        canDiscardStage: async () => false,
        authorizeRetention: async () => {
          throw new Error("legal-hold-policy");
        },
      });
      const output = value(
        await store.stage(bytes("still-running-job"), context()),
      );
      const report = value(await store.recover(context()));
      expect(report.stagedRetained).toContain(output.stagingId);
      expect(report.stagedDiscarded).toBe(0);
      expect((await store.collectGarbage(context())).status).toBe("failed");
      expect(
        value(await store.commit([output], context())).outputs,
      ).toHaveLength(1);
    });
    test("GC grants a host removal reservation only during exact guarded removal", async () => {
      const { store, disk } = await setup();
      const staged = value(
        await store.stage(bytes("temporary-orphan"), context()),
      );
      await disk.fs.publish(staged, context());
      const ctx = context("gc");
      expect(store.hasRemovalReservation(staged.artifact, ctx)).toBe(false);
      const remove = disk.maintenance.removeBlob;
      disk.maintenance.removeBlob = async (artifact) => {
        expect(store.hasRemovalReservation(artifact, ctx)).toBe(true);
        expect(
          store.hasRemovalReservation(
            { ...artifact, sha256: "a".repeat(64) },
            ctx,
          ),
        ).toBe(false);
        expect(store.hasRemovalReservation(artifact, context("gc"))).toBe(
          false,
        );
        await remove(artifact);
      };
      value(await store.collectGarbage(ctx));
      expect(store.hasRemovalReservation(staged.artifact, ctx)).toBe(false);
    });
    test("backup takes explicit per-design read authority, not just blob-root access", async () => {
      let deny = false;
      const { store } = await setup({
        authorize: async (_context, scope) => {
          if (deny && scope.resourceKind === "design")
            throw new Error("design-denied");
        },
      });
      await seed(store);
      deny = true;
      expect((await store.backup(context())).status).toBe("failed");
    });
    test("database rejects a changed root or permission scope before any blob lookup", async () => {
      const { store, options } = await setup();
      await seed(store);
      store.close();
      await expect(
        LocalStore.open({ ...options, artifactRootId: "different-root" }),
      ).rejects.toMatchObject({ code: "SCHEMA_INCOMPATIBLE" });
      await expect(
        LocalStore.open({
          ...options,
          permissionScope: "different-permission",
        }),
      ).rejects.toMatchObject({ code: "SCHEMA_INCOMPATIBLE" });
    });
    test("project export survives transport to a file and verified restore; malformed bytes fail", async () => {
      const source = await setup();
      const { rev } = await seed(source.store);
      const backup = value(await source.store.backup(context()));
      const encoded = encodeBackup(backup, 1048576);
      const destination = join(source.root, "synthetic export \u00e9.json");
      await writeFile(destination, encoded);
      const decoded = decodeBackup(await readFile(destination), 1048576);
      const target = await setup();
      value(await target.store.restore(decoded, context()));
      expect(value(await target.store.getRevision("rev1", context()))).toEqual(
        rev,
      );
      expect(() => decodeBackup(bytes("{"), 1048576)).toThrow();
      expect(() => decodeBackup(encoded, 1)).toThrow();
      expect(() => encodeBackup(backup, 1)).toThrow();
      const duplicate = bytes(
        new TextDecoder()
          .decode(encoded)
          .replace('{"format":', '{"format":"discarded-duplicate","format":'),
      );
      expect(() => decodeBackup(duplicate, 1048576)).toThrow();
    });
    test("public revision boundary rejects accessors without invoking them", async () => {
      const { store } = await setup();
      let invoked = false;
      const output = await stage(store);
      const request = {
        branch: "main",
        base: null,
        revision: revision(
          "rev1",
          output.map((item) => item.artifact),
        ),
        outputs: output,
      };
      Object.defineProperty(request.revision, "actorId", {
        enumerable: true,
        get() {
          invoked = true;
          return "actor1";
        },
      });
      expect((await store.commitRevision(request, context())).status).toBe(
        "failed",
      );
      expect(invoked).toBe(false);
    });
    test("GC reservation prevents a racing commit from creating a pointer to removed bytes", async () => {
      const { store, disk } = await setup();
      const staged = value(
        await store.stage(bytes("racing-orphan"), context()),
      );
      await disk.fs.publish(staged, context());
      let queued: Promise<Outcome<unknown>> | undefined;
      const remove = disk.maintenance.removeBlob;
      disk.maintenance.removeBlob = async (artifact) => {
        queued = store.commit([staged], context("racing-commit"));
        await remove(artifact);
      };
      expect(
        value(await store.collectGarbage(context("gc"))).deleted,
      ).toHaveLength(1);
      expect((await queued)?.status).toBe("failed");
      expect(
        value(await store.getReceipt("racing-commit", context())),
      ).toBeNull();
    });
    test("unverified publication durability cannot create a committed pointer", async () => {
      const { store } = await setup({
        ensurePublicationDurable: async () => {
          throw new Error("directory-durability-unverified");
        },
      });
      const outputs = await stage(store);
      expect((await store.commit(outputs, context())).status).toBe("failed");
      expect(value(await store.getReceipt("request1", context()))).toBeNull();
    });
    test("uncertain host publication stays interrupted without a durable receipt", async () => {
      const { store, disk } = await setup();
      const outputs = await stage(store);
      disk.fs.publish = async (_staged, ctx) => ({
        schemaVersion: "1.0",
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        status: "interrupted",
        error: {
          code: "OUTPUT_UNCERTAIN",
          message: "Test link succeeded, cleanup failed.",
          retryable: false,
          diagnosticIds: [],
        },
        diagnosticIds: [],
      });
      const result = await store.commit(outputs, context());
      expect(result.status).toBe("interrupted");
      if (result.status !== "complete")
        expect(result.error.code).toBe("OUTPUT_UNCERTAIN");
      expect(value(await store.getReceipt("request1", context()))).toBeNull();
    });
    test("even an empty backup obeys its complete metadata output budget", async () => {
      const { store } = await setup();
      const ctx = context();
      ctx.budget.maxOutputBytes = 1;
      expect((await store.backup(ctx)).status).toBe("failed");
    });
    test("forking an accepted revision creates a CAS-protected alternative without rewriting its source head", async () => {
      const { store } = await setup();
      const { rev } = await seed(store);
      const base = {
        expectedBaseRevision: rev.id,
        ifMatch: `"${rev.content.sha256}"`,
      };
      expect(
        value(
          await store.forkBranch(
            "design1",
            "alternative",
            base,
            context("fork"),
          ),
        ),
      ).toBe(rev.id);
      expect(
        (
          await store.forkBranch(
            "design1",
            "alternative",
            base,
            context("duplicate-fork"),
          )
        ).status,
      ).toBe("failed");
      const outputs = await stage(store, [
        "alternative",
        "provenance",
        "resources",
      ]);
      value(
        await store.commitRevision(
          {
            branch: "alternative",
            base,
            revision: revision(
              "rev2",
              outputs.map((item) => item.artifact),
              ["rev1"],
            ),
            outputs,
          },
          context("alternative"),
        ),
      );
      expect(value(await store.getHead("design1", "main", context()))).toBe(
        "rev1",
      );
      expect(
        value(await store.getHead("design1", "alternative", context())),
      ).toBe("rev2");
    });
  },
);
