import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { loadNative } from "../../project-host/dist/native.js";
import { pinImmutableReferenceDatabase } from "../../project-host/dist/reference-validation-database.js";
import { openDatabase } from "../dist/database.js";
import { initializeImmutableSqlite } from "../dist/immutable-sqlite.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const binding = path.resolve(
  ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
);
const mode = process.argv[2];
const root = await mkdtemp(path.join(tmpdir(), "immutable-command-synthetic-"));
const priorEnvironment = process.env.SQLITE_USE_URI;
const pins = new Set();
let snapshot;
let connection;
try {
  if (mode === "preloaded") {
    require(binding);
    assert.throws(
      () => initializeImmutableSqlite(binding),
      /already initialized/,
    );
  } else if (mode === "load-failure") {
    const bad = path.join(root, "invalid.node");
    await writeFile(bad, Buffer.from("not a native addon"));
    assert.throws(() => initializeImmutableSqlite(bad));
  } else if (mode === "worker") {
    const url = pathToFileURL(
      path.resolve("packages\\storage\\dist\\immutable-sqlite.js"),
    ).href;
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      import(${JSON.stringify(url)}).then(({initializeImmutableSqlite}) => {
        try { initializeImmutableSqlite(${JSON.stringify(binding)}); parentPort.postMessage(false); }
        catch { parentPort.postMessage(true); }
      });
    `,
      { eval: true },
    );
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await new Promise((resolve) => worker.once("exit", resolve));
    assert.equal(result, true);
  } else {
    initializeImmutableSqlite(binding);
    initializeImmutableSqlite(binding);
    assert.equal(process.env.SQLITE_USE_URI, priorEnvironment);
    if (mode === "alias") {
      assert.throws(() =>
        initializeImmutableSqlite(
          `${path.dirname(binding)}\\..\\Release\\better_sqlite3.node`,
        ),
      );
    } else if (mode === "caller-uri") {
      for (const databasePath of [
        "file:///C:/private.sqlite?immutable=1",
        "file::memory:?cache=shared",
        "\\\\server\\share\\private.sqlite",
      ]) {
        let attested = false;
        await assert.rejects(
          openDatabase({
            databasePath,
            attestLocalDatabase: async () => {
              attested = true;
              throw new Error("Not admitted");
            },
          }),
        );
        assert.equal(attested, false);
      }
    } else {
      const native = await loadNative();
      const sid = native.principal();
      const owned = path.join(root, "owned");
      native.createDirectory(owned, sid);
      const filename = path.join(owned, "main.sqlite");
      native.createFile(filename, sid, Buffer.alloc(0));
      const initial = new Database(filename, { nativeBinding: binding });
      initial.pragma("journal_mode=WAL");
      initial.exec(`
        CREATE TABLE identity(project,root,permission);
        INSERT INTO identity VALUES('synthetic','artifacts','private');
        CREATE TABLE synthetic(value);
        INSERT INTO synthetic VALUES(42);
        PRAGMA application_id=1146311729;
        PRAGMA user_version=4;
      `);
      initial.close();
      const before = await readFile(filename);
      const beforeNames = (await readdir(owned)).sort();
      const pin = () =>
        pinImmutableReferenceDatabase({
          filename,
          sid,
          authoritySha256: "a".repeat(64),
          retainedPins: pins,
          authorize: async () => {},
        });
      if (mode === "database-limit") {
        await truncate(filename, 26214400);
        const exact = await pin();
        exact.close();
        await truncate(filename, 26214401);
        const oversized = await readFile(filename);
        let admitted = false;
        await assert.rejects(
          pin().then((value) => {
            admitted = true;
            value.close();
          }),
          { code: "INPUT_LIMIT" },
        );
        assert.equal(admitted, false);
        assert.deepEqual(await readFile(filename), oversized);
        assert.deepEqual((await readdir(owned)).sort(), beforeNames);
      } else if (mode === "missing") {
        await rm(filename);
        await assert.rejects(pin());
        assert.deepEqual(await readdir(owned), []);
      } else if (mode === "sidecars") {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          for (const bytes of [
            Buffer.alloc(0),
            Buffer.from("retained synthetic journal"),
          ]) {
            const name = filename + suffix;
            await writeFile(name, bytes);
            await assert.rejects(pin(), /sidecar/);
            assert.deepEqual(await readFile(name), bytes);
            // Fixture cleanup only, never recovery or an implementation fallback.
            await rm(name);
          }
        }
        assert.deepEqual(await readFile(filename), before);
        assert.deepEqual((await readdir(owned)).sort(), beforeNames);
      } else if (mode === "live-writer") {
        const writer = new Database(filename, { nativeBinding: binding });
        try {
          writer.prepare("SELECT value FROM synthetic").get();
          await assert.rejects(pin());
          assert.throws(() => native.pinRead(filename, false, sid));
        } finally {
          writer.close();
        }
      } else {
        snapshot = await pin();
        await assert.rejects(writeFile(filename, Buffer.from("denied")));
        await assert.rejects(truncate(filename, 0));
        await assert.rejects(rm(filename));
        await assert.rejects(
          rename(filename, path.join(owned, "replaced.sqlite")),
        );
        connection = await openDatabase({
          access: "read-only",
          readonlySnapshot: snapshot,
          databasePath: filename,
          nativeBinding: binding,
          projectId: "synthetic",
          artifactRootId: "artifacts",
          permissionScope: "private",
          attestLocalDatabase: async () => {
            const pin = native.inspect(filename, false, sid);
            pin.close();
          },
        });
        assert.deepEqual(
          connection.prepare("SELECT value FROM synthetic").get(),
          { value: 42 },
        );
        assert.throws(
          () => connection.exec("INSERT INTO synthetic VALUES(43)"),
          /readonly/i,
        );
        await snapshot.check();
        connection.close();
        connection = undefined;
        await snapshot.check();
        assert.deepEqual(await readFile(filename), before);
        assert.deepEqual((await readdir(owned)).sort(), beforeNames);
      }
    }
  }
  assert.equal(process.env.SQLITE_USE_URI, priorEnvironment);
  process.stdout.write(
    JSON.stringify({ mode, passed: true, environmentRestored: true }),
  );
} finally {
  connection?.close();
  snapshot?.close();
  for (const pin of [...pins].reverse()) pin.close();
  await rm(root, { recursive: true, force: true });
}
