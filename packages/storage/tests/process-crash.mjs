import Database from "better-sqlite3";

const [path, binding] = process.argv.slice(2);
const db = new Database(path, { nativeBinding: binding });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("locking_mode = EXCLUSIVE");
db.exec("CREATE TABLE IF NOT EXISTS crash_evidence (value TEXT NOT NULL)");
db.prepare("INSERT INTO crash_evidence VALUES (?)").run("committed");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO crash_evidence VALUES (?)").run("uncommitted");
// Abrupt exit deliberately skips close/rollback and tests SQLite's OS lock release.
process.exit(17);
