import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const [mode, source, destination] = process.argv.slice(2);
let blocked = 0;
const mkdir = fs.mkdir;
if (mode === "admission" || mode === "copy-tamper") {
  fs.mkdir = async (filename, options) => {
    if (path.resolve(filename) === destination) {
      if (mode === "admission") {
        blocked++;
        throw new Error("TEST_BLOCKED_CANDIDATE_ALLOCATION");
      }
      await fs.writeFile(
        path.join(source, "LICENSE"),
        "changed after admission",
      );
    }
    return mkdir(filename, options);
  };
  syncBuiltinESMExports();
}
const api = await import("../../scripts/package-candidate.mjs");
try {
  if (mode === "admission")
    await api.packageCandidate({
      workspace: process.cwd(),
      nodeRoot: source,
      browserRoot: path.resolve(".tools", "renderer-browser-1.63.0"),
      sqliteBinding: path.resolve(
        ".tools",
        "sqlite-prebuild",
        "build",
        "Release",
        "better_sqlite3.node",
      ),
      output: destination,
    });
  else if (mode === "copy" || mode === "copy-tamper")
    // An extra caller argument cannot select a different closure.
    await api.copyRuntime(source, destination, ["npm.cmd"]);
  else throw new Error("Invalid test mode.");
  process.stdout.write(JSON.stringify({ status: "copied", blocked }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "rejected",
      blocked,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
