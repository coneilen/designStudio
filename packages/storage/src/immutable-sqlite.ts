import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { StorageError } from "./types.js";

const require = createRequire(import.meta.url);
const initialized = new Map<string, unknown>();

/** Called only by the separately admitted native validation composition, before any database opens. */
export function initializeImmutableSqlite(binding: string): void {
  if (!isMainThread || !isAbsolute(binding) || !binding.endsWith(".node"))
    throw new StorageError(
      "AUTHORIZATION_CHANGED",
      "Immutable initialization needs the pinned native binding.",
    );
  const filename = require.resolve(binding);
  const stat = lstatSync(filename);
  if (
    filename !== binding ||
    realpathSync(filename) !== filename ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1
  )
    throw new StorageError(
      "AUTHORIZATION_CHANGED",
      "Immutable binding identity is not canonical.",
    );
  const cached = require.cache[filename];
  if (cached) {
    if (
      !initialized.has(filename) ||
      initialized.get(filename) !== cached.exports
    )
      throw new StorageError(
        "ACTION_REQUIRED",
        "SQLite was already initialized outside the read-only command.",
      );
    return;
  }
  const previous = process.env.SQLITE_USE_URI;
  try {
    // Native addon initialization is synchronous; no await or caller callback may enter this scope.
    process.env.SQLITE_USE_URI = "1";
    const addon: unknown = require(filename);
    initialized.set(filename, addon);
  } finally {
    if (previous === undefined) delete process.env.SQLITE_USE_URI;
    else process.env.SQLITE_USE_URI = previous;
  }
}

export function immutableDatabaseUri(
  filename: string,
  binding: string,
): string {
  const module = require.resolve(binding);
  if (
    !initialized.has(module) ||
    require.cache[module]?.exports !== initialized.get(module)
  )
    throw new StorageError(
      "AUTHORIZATION_CHANGED",
      "Immutable SQLite command initialization is absent.",
    );
  const uri = pathToFileURL(filename);
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}
