import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

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
