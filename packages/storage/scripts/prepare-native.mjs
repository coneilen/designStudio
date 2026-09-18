import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const provenance = JSON.parse(
  await readFile(resolve(packageRoot, "native-provenance.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function extractVerifiedBinary(archive) {
  if (
    archive.length !== provenance.archiveBytes ||
    sha256(archive) !== provenance.archiveSha256
  )
    throw new Error("Native archive size/SHA256 mismatch.");
  const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  const header = tar.subarray(0, 512);
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const size = Number.parseInt(
    header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(),
    8,
  );
  const type = header[156];
  const checksum = Number.parseInt(
    header.subarray(148, 156).toString("ascii").trim(),
    8,
  );
  const calculated = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  if (
    name !== provenance.entry ||
    (type !== 0 && type !== 48) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 12 * 1024 * 1024 ||
    calculated !== checksum
  )
    throw new Error("Unexpected native archive entry/header.");
  const binary = tar.subarray(512, 512 + size);
  if (
    binary.length !== size ||
    sha256(binary) !== provenance.binarySha256 ||
    tar.subarray(512 + Math.ceil(size / 512) * 512).some((byte) => byte !== 0)
  )
    throw new Error("Native binary or archive trailer mismatch.");
  return binary;
}

export async function prepareNative(args = process.argv.slice(2)) {
  if (
    process.version !== `v${provenance.node}` ||
    process.versions.modules !== provenance.abi ||
    process.platform !== provenance.platform ||
    process.arch !== provenance.arch
  )
    throw new Error(
      "No approved prebuild for this Node/platform/architecture. No compiler fallback is allowed.",
    );
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--archive"))
    throw new Error(
      "Usage: prepare-native.mjs [--archive <verified-offline-archive>]",
    );
  const destination = resolve(
    packageRoot,
    "..",
    "..",
    ".tools",
    "sqlite-prebuild",
  );
  let archive;
  if (args[1]) {
    const { stat } = await import("node:fs/promises");
    if ((await stat(args[1])).size !== provenance.archiveBytes)
      throw new Error("Offline archive has unexpected size.");
    archive = await readFile(args[1]);
  } else {
    const response = await fetch(provenance.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Native archive download failed: HTTP ${response.status}.`,
      );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > provenance.archiveBytes)
        throw new Error("Native archive exceeds pinned size.");
      chunks.push(chunk);
    }
    archive = Buffer.concat(chunks);
  }
  const binary = extractVerifiedBinary(archive);
  const target = resolve(
    destination,
    "build",
    "Release",
    "better_sqlite3.node",
  );
  await mkdir(dirname(target), { recursive: true });
  try {
    const existing = await readFile(target);
    if (sha256(existing) !== provenance.binarySha256)
      throw new Error(
        "Existing native binary is not the pinned binary; inspect/remove it explicitly.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, binary, { flag: "wx" });
      await rename(staging, target);
    } finally {
      await rm(staging, { force: true });
    }
  }
  return { nativeBinding: target, binarySha256: provenance.binarySha256 };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await prepareNative()));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Native preparation failed.",
    );
    process.exitCode = 1;
  }
}
