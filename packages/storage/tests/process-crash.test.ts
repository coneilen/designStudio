import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "real abrupt process exit releases writer lock and WAL keeps only committed rows",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "storage crash \u00e9 "));
    const path = join(root, "crash.sqlite");
    const nativeBinding = resolve(
      ".tools/sqlite-prebuild/build/Release/better_sqlite3.node",
    );
    try {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./process-crash.mjs", import.meta.url)),
          path,
          nativeBinding,
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 262144 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(17);
      const db = new Database(path, { nativeBinding });
      try {
        expect(db.prepare("SELECT value FROM crash_evidence").all()).toEqual([
          { value: "committed" },
        ]);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
