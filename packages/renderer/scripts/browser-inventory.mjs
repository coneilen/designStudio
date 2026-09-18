import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("../../../.tools/renderer-browser-1.63.0/", import.meta.url),
);
const files = [];
async function inventory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Browser payload link rejected");
    if (item.isDirectory()) await inventory(name);
    else if (item.isFile() && !name.includes(`${path.sep}.links${path.sep}`)) {
      const bytes = await readFile(name);
      const info = await stat(name);
      files.push({
        path: path.relative(root, name).split(path.sep).join("/"),
        byteLength: info.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await inventory(root);
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
process.stdout.write(
  `${JSON.stringify({ playwright: "1.63.0", files }, null, 2)}\n`,
);
