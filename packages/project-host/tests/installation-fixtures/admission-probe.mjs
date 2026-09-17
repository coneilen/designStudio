import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const [workspace, destination, rootName = "root"] = process.argv.slice(2);
const mkdir = fs.mkdir;
const copyFile = fs.copyFile;
let blocked = 0;
function contain(filename) {
  const relative = path.relative(destination, path.resolve(filename));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    blocked++;
    throw new Error("TEST_BLOCKED_OUTSIDE_ALLOCATION");
  }
}
fs.mkdir = async (filename, options) => {
  contain(filename);
  return mkdir(filename, options);
};
fs.copyFile = async (source, target, flags) => {
  contain(target);
  return copyFile(source, target, flags);
};
syncBuiltinESMExports();
const { physicalDependencies } = await import(
  "../../scripts/package-candidate.mjs"
);
try {
  await physicalDependencies(
    workspace,
    [path.join(workspace, "packages", rootName)],
    destination,
  );
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
