import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_INVENTORY_SHA256 =
  "__REVIEWED_BOOTSTRAP_MODULE_INVENTORY_SHA256__";
const bootstrap = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.join(bootstrap, "node_modules");
const maxFile = 512 * 1024 * 1024;
function readHash(filename, maximum, collect = false) {
  const stat = lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maximum
  )
    throw new Error("Bootstrap preflight requires bounded physical files.");
  const fd = openSync(filename, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    const parts = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > maximum) throw new Error("Bootstrap module exceeds limit.");
      hash.update(buffer.subarray(0, count));
      if (collect) parts.push(Buffer.from(buffer.subarray(0, count)));
    }
    return {
      bytes,
      sha256: hash.digest("hex"),
      content: collect ? Buffer.concat(parts) : undefined,
    };
  } finally {
    closeSync(fd);
  }
}
export async function preflight() {
  if (
    process.version !== "v24.21.0" ||
    process.execArgv.length !== 0 ||
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    Object.keys(process.env).some(
      (key) => /^(NODE_OPTIONS|NODE_PATH)$/i.test(key) && process.env[key],
    )
  )
    throw new Error(
      "Bootstrap requires selected Windows x64 Node 24.21.0 without injected loaders.",
    );
  const inventory = readHash(
    path.join(bootstrap, "bootstrap-modules.json"),
    8 * 1024 * 1024,
    true,
  );
  if (inventory.sha256 !== MODULE_INVENTORY_SHA256)
    throw new Error(
      "Bootstrap module inventory differs from the explicitly trusted preflight bytes.",
    );
  const parsed = JSON.parse(inventory.content.toString());
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.files) ||
    parsed.files.length < 1 ||
    parsed.files.length > 20000
  )
    throw new Error("Invalid bootstrap inventory shape.");
  const files = new Map();
  const directories = new Set([moduleRoot.toLowerCase()]);
  let total = 0;
  for (const file of parsed.files) {
    if (
      typeof file.path !== "string" ||
      file.path.length > 220 ||
      file.path
        .split("/")
        .some(
          (part) =>
            !/^[A-Za-z0-9_@+.-]+$/.test(part) ||
            /[. ]$/.test(part) ||
            part === "." ||
            part === ".." ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > maxFile ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid bootstrap module path/identity.");
    const filename = path.join(moduleRoot, ...file.path.split("/"));
    const key = filename.toLowerCase();
    if (files.has(key)) throw new Error("Aliased bootstrap module.");
    files.set(key, file);
    total += file.bytes;
    if (total > 2 * 1024 * 1024 * 1024)
      throw new Error("Bootstrap aggregate byte limit exceeded.");
    let parent = path.dirname(filename);
    while (parent !== moduleRoot) {
      directories.add(parent.toLowerCase());
      parent = path.dirname(parent);
    }
  }
  const seen = new Set();
  const visit = (directory) => {
    if (!directories.has(directory.toLowerCase()))
      throw new Error("Unexpected bootstrap directory.");
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory).toLowerCase() !== directory.toLowerCase()
    )
      throw new Error("Bootstrap directory resolution escape.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Bootstrap resolution links are forbidden.");
      if (entry.isDirectory()) visit(filename);
      else {
        const file = files.get(filename.toLowerCase());
        if (!file || !entry.isFile())
          throw new Error("Unexpected bootstrap module file.");
        const actual = readHash(filename, file.bytes);
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
          throw new Error("Bootstrap module identity mismatch.");
        seen.add(filename.toLowerCase());
      }
    }
  };
  visit(moduleRoot);
  if (seen.size !== files.size)
    throw new Error("Bootstrap module file is missing.");
  const check = (value) => {
    if (isBuiltin(value)) return;
    const url = new URL(value);
    if (
      url.protocol !== "file:" ||
      url.host ||
      url.search ||
      url.hash ||
      !seen.has(path.resolve(fileURLToPath(url)).toLowerCase())
    )
      throw new Error(
        "Bootstrap module resolution outside the selected closure.",
      );
  };
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      check(result.url);
      if (
        !isBuiltin(specifier) &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(specifier)
      ) {
        const name = specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1);
        if (
          !fileURLToPath(result.url)
            .toLowerCase()
            .startsWith(
              `${path.join(moduleRoot, ...name).toLowerCase()}${path.sep}`,
            )
        )
          throw new Error(
            "Bootstrap global/ancestor package fallback is forbidden.",
          );
      }
      return result;
    },
    load(url, context, next) {
      check(url);
      return next(url, context);
    },
  });
  try {
    const api = await import(
      "./node_modules/@design-studio/project-host/dist/installation.js"
    );
    return { api, close: () => hook.deregister() };
  } catch (error) {
    hook.deregister();
    throw error;
  }
}
