import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadNative } from "../dist/native.js";
import { pinImmutableReferenceDatabase } from "../dist/reference-validation-database.js";

const root = process.argv[2];
if (
  !root ||
  !/^ds-ph-reference-/.test(path.basename(root)) ||
  path.resolve(root) !== root ||
  (await lstat(root)).isSymbolicLink()
)
  throw new Error("Expected exact generated crash fixture.");
const directory = path.join(root, "db");
const filename = path.join(directory, "state.sqlite");
const snapshot = async () => {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 26214400)
      throw new Error("Unexpected synthetic crash entry.");
    entries.push([
      name,
      stat.ino,
      stat.size,
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ]);
  }
  return JSON.stringify(entries);
};
const before = await snapshot();
if (
  !(await readdir(directory)).some((n) =>
    /^state\.sqlite-(wal|shm|journal)$/.test(n),
  )
)
  throw new Error("Synthetic crash did not preserve SQLite sidecars.");
const pins = new Set();
let denied = false;
try {
  const pin = await pinImmutableReferenceDatabase({
    filename,
    sid: (await loadNative()).principal(),
    retainedPins: pins,
    authoritySha256: "0".repeat(64),
    authorize: async () => {},
  });
  pin.close();
} catch (error) {
  if (error?.code !== "ACTION_REQUIRED") throw error;
  denied = true;
}
if (!denied || pins.size || before !== (await snapshot()))
  throw new Error("Cold read-only crash inspection was not preserving.");
console.log(JSON.stringify({ denied: true, unchanged: true, pins: 0 }));
