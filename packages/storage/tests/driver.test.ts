import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, toNamespacedPath } from "node:path";
import Database from "better-sqlite3";
import { aroundEach, expect, onTestFinished, test } from "vitest";
import { loadNative, type ReadLease } from "../../project-host/src/native.js";
import { ownedTest } from "../../project-host/tests/support.js";
import { inStorageTest, storageTestSignal } from "./lifetime.js";

aroundEach((run, context) => inStorageTest(context.signal, run));

test
  .skipIf(process.platform !== "win32" || process.arch !== "x64")
  .each([185, 186, 187, 194, 195, 196, 240])(
  "verifies internally encoded SQLite backup boundaries from a %i-unit admitted source",
  async (sourceUnits) => {
    const signal = storageTestSignal();
    const work = ownedTest(async (root, _own, beforeCleanup) => {
      const native = await loadNative();
      const sid = native.principal();
      const databases = new Set<Database.Database>();
      const pins = new Set<ReadLease>();
      beforeCleanup(() => {
        const errors: unknown[] = [];
        for (const pin of pins) {
          try {
            pin.close();
            pins.delete(pin);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const database of databases) {
          try {
            database.close();
            databases.delete(database);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            "Synthetic backup owners remain open.",
          );
      });
      const length = sourceUnits - root.length - "database.sqlite".length - 2;
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThanOrEqual(255);
      const directory = join(root, "d".repeat(length));
      native.createDirectory(directory, sid);
      const source = join(directory, "database.sqlite");
      const final = `${source}.migration-v4-00000000-0000-4000-8000-000000000001.sqlite`;
      const pending = `${final}.pending`;
      expect(source.length).toBe(sourceUnits);
      expect(pending.length).toBe(sourceUnits + 65);
      expect(final.length).toBe(sourceUnits + 57);
      signal.throwIfAborted();
      native.createFile(source, sid, Buffer.alloc(0));
      native.createFile(pending, sid, Buffer.alloc(0));
      const binding = resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      );
      const database = new Database(source, {
        nativeBinding: binding,
        timeout: 0,
      });
      databases.add(database);
      database.pragma("locking_mode = EXCLUSIVE");
      database.exec("BEGIN EXCLUSIVE; COMMIT");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.exec(
        "PRAGMA application_id=1146311729; PRAGMA user_version=4; CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES ('generated preimage');",
      );
      database.pragma("wal_checkpoint(FULL)");
      const schema = database
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        )
        .all();
      const rows = database.prepare("SELECT * FROM synthetic").all();
      const sourceBytes = await readFile(source);
      await database.backup(toNamespacedPath(pending));
      signal.throwIfAborted();
      const backupBytes = await readFile(pending);
      const identity = await lstat(pending, { bigint: true });
      const verifyCopy = async (filename: string) => {
        expect(filename.startsWith("\\\\?\\")).toBe(false);
        const pin = native.pinRead(filename, false, sid);
        pins.add(pin);
        const copy = new Database(toNamespacedPath(filename), {
          nativeBinding: binding,
          readonly: true,
          fileMustExist: true,
        });
        databases.add(copy);
        expect(copy.pragma("application_id", { simple: true })).toBe(
          0x44535431,
        );
        expect(copy.pragma("user_version", { simple: true })).toBe(4);
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(
          copy
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
            )
            .all(),
        ).toEqual(schema);
        expect(copy.prepare("SELECT * FROM synthetic").all()).toEqual(rows);
        copy.close();
        databases.delete(copy);
        expect(await readFile(filename)).toEqual(backupBytes);
        pin.close();
        pins.delete(pin);
      };
      await verifyCopy(pending);
      await rename(pending, final);
      await verifyCopy(final);
      const published = await lstat(final, { bigint: true });
      expect([published.dev, published.ino, published.nlink]).toEqual([
        identity.dev,
        identity.ino,
        1n,
      ]);
      expect(await readFile(source)).toEqual(sourceBytes);
      database.close();
      databases.delete(database);
      signal.throwIfAborted();
      const allowed = [source, pending, final].flatMap((filename) =>
        ["", "-wal", "-shm", "-journal"].map(
          (suffix) => `${basename(filename)}${suffix}`,
        ),
      );
      expect(
        (await readdir(directory)).every((name) => allowed.includes(name)),
      ).toBe(true);
      expect(pins.size).toBe(0);
      expect(databases.size).toBe(0);
      sourceBytes.fill(0);
      backupBytes.fill(0);
    });
    onTestFinished(() =>
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    await work;
  },
);

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "stable native driver persists WAL transactions on Windows space/Unicode paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "storage SQLite \u00e9 "));
    const path = join(root, "project.sqlite");
    let db: Database.Database | undefined;
    try {
      db = new Database(path, {
        nativeBinding: resolve(
          ".tools/sqlite-prebuild/build/Release/better_sqlite3.node",
        ),
      });
      expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
      db.exec("CREATE TABLE evidence (value TEXT NOT NULL)");
      db.transaction(() =>
        db?.prepare("INSERT INTO evidence VALUES (?)").run("retained"),
      )();
      const connection = db;
      expect(() =>
        connection.transaction(() => {
          connection
            .prepare("INSERT INTO evidence VALUES (?)")
            .run("rolled-back");
          throw new Error("crash-before-commit");
        })(),
      ).toThrow("crash-before-commit");
      db.close();
      db = new Database(path, {
        nativeBinding: resolve(
          ".tools/sqlite-prebuild/build/Release/better_sqlite3.node",
        ),
      });
      expect(db.prepare("SELECT value FROM evidence").all()).toEqual([
        { value: "retained" },
      ]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
