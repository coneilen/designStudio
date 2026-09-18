import { createHash } from "node:crypto";
import { open, opendir } from "node:fs/promises";
import path from "node:path";

export const INSTALL_LIMITS = Object.freeze({
  files: 20000,
  manifestBytes: 8 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
});
export interface InventoryFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export function relativeName(filename: string): void {
  if (
    typeof filename !== "string" ||
    filename.length > 220 ||
    !filename ||
    filename
      .split("/")
      .some(
        (part) =>
          !/^[A-Za-z0-9_@+.-]+$/.test(part) ||
          /[. ]$/.test(part) ||
          part === "." ||
          part === ".." ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Invalid canonical installation path.");
}
export function physical(root: string, name: string): string {
  relativeName(name);
  return path.join(root, ...name.split("/"));
}
export function encodeInventory(files: readonly InventoryFile[]): Buffer {
  if (files.length < 1 || files.length > INSTALL_LIMITS.files)
    throw new Error("Installation file count exceeds bounds.");
  const seen = new Set<string>();
  let total = 0;
  const normalized = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      relativeName(file.path);
      if (
        seen.has(file.path.toLowerCase()) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > INSTALL_LIMITS.fileBytes ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw new Error("Invalid or aliased installation file.");
      seen.add(file.path.toLowerCase());
      total += file.bytes;
      if (total > INSTALL_LIMITS.totalBytes)
        throw new Error("Installation aggregate byte limit exceeded.");
      return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
    });
  for (const filename of seen) {
    let parent = path.posix.dirname(filename);
    while (parent !== ".") {
      if (seen.has(parent))
        throw new Error("Installation file/directory alias.");
      parent = path.posix.dirname(parent);
    }
  }
  const bytes = Buffer.from(JSON.stringify({ version: 1, files: normalized }));
  if (bytes.byteLength > INSTALL_LIMITS.manifestBytes)
    throw new Error("Installation manifest exceeds bounds.");
  return bytes;
}
export function decodeInventory(bytes: Uint8Array): readonly InventoryFile[] {
  if (bytes.byteLength > INSTALL_LIMITS.manifestBytes)
    throw new Error("Installation manifest exceeds bounds.");
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("files" in value) ||
    !Array.isArray(value.files)
  )
    throw new Error("Invalid installation inventory.");
  const files: InventoryFile[] = value.files.map((file: unknown) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("path" in file) ||
      typeof file.path !== "string" ||
      !("bytes" in file) ||
      typeof file.bytes !== "number" ||
      !("sha256" in file) ||
      typeof file.sha256 !== "string"
    )
      throw new Error("Invalid installation inventory entry.");
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (!Buffer.from(bytes).equals(encodeInventory(files)))
    throw new Error("Noncanonical installation inventory.");
  return Object.freeze(files.map((file) => Object.freeze(file)));
}
export async function boundedFile(
  filename: string,
  maximum: number,
): Promise<Buffer> {
  const file = await open(filename, "r");
  let result: Buffer;
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const next = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length > maximum)
      throw new Error("Installation metadata exceeds bounds.");
    result = buffer.subarray(0, length);
  } catch (error) {
    try {
      await file.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Installation read/close failed.",
        { cause: error },
      );
    }
    throw error;
  }
  await file.close();
  return result;
}
export async function exactTree(
  root: string,
  files: readonly InventoryFile[],
): Promise<string[]> {
  const remaining = new Set(files.map((file) => file.path));
  const allowedDirectories = new Set<string>([""]);
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      allowedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const directories: string[] = [];
  let entriesSeen = 0;
  const visit = async (relative: string): Promise<void> => {
    const directory = relative ? physical(root, relative) : root;
    directories.push(directory);
    const entries = [];
    for await (const entry of await opendir(directory)) {
      if (++entriesSeen > INSTALL_LIMITS.files * 2)
        throw new Error("Installation directory-entry bound exceeded.");
      entries.push(entry);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      relativeName(name);
      if (entry.isSymbolicLink())
        throw new Error("Installation refuses symlinks/reparse entries.");
      if (entry.isDirectory() && allowedDirectories.delete(name))
        await visit(name);
      else if (!entry.isFile() || !remaining.delete(name))
        throw new Error(
          `Installation contains an extra/aliased/wrong-kind entry: ${name}`,
        );
    }
  };
  await visit("");
  if (remaining.size)
    throw new Error("Installation inventory entries are missing.");
  return directories;
}
