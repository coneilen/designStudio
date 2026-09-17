import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { HostBoundaryError, type OperationGuard } from "@design-studio/host";

export interface PinnedFile {
  path: string;
  sha256: string;
  maxBytes: number;
}
export function validatePin(pin: PinnedFile): void {
  if (
    !pin ||
    !path.isAbsolute(pin.path) ||
    pin.path.startsWith("\\\\") ||
    pin.path.includes("\0") ||
    !/^[0-9a-f]{64}$/.test(pin.sha256) ||
    !Number.isSafeInteger(pin.maxBytes) ||
    pin.maxBytes <= 0 ||
    pin.maxBytes > 250_000_000
  )
    throw new HostBoundaryError("INVALID_INPUT", "Invalid trusted file pin.");
}
export async function realDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(directory)) !== path.resolve(directory)
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Owned temp root must be an existing real directory.",
      );
  } catch (cause) {
    if (cause instanceof HostBoundaryError) throw cause;
    throw new HostBoundaryError(
      "PATH_FORBIDDEN",
      "Owned temp root is unavailable.",
      false,
      { cause },
    );
  }
}
export async function verifyFile(
  pin: PinnedFile,
  guard?: OperationGuard,
): Promise<void> {
  validatePin(pin);
  try {
    const before = await lstat(pin.path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (await realpath(pin.path)) !== path.resolve(pin.path)
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Pinned implementation must be a real unaliased file.",
      );
    if (before.size > pin.maxBytes)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Pinned file exceeds its inspection bound.",
      );
    const handle = await open(pin.path, "r");
    try {
      const digest = createHash("sha256");
      const chunk = Buffer.alloc(65536);
      let total = 0;
      for (;;) {
        guard?.check();
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > pin.maxBytes)
          throw new HostBoundaryError(
            "INPUT_LIMIT",
            "Pinned file grew past its bound.",
          );
        digest.update(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== total ||
        digest.digest("hex") !== pin.sha256
      )
        throw new HostBoundaryError(
          "TOOL_VERSION_UNSUPPORTED",
          "Trusted worker file identity does not match its pin.",
        );
    } finally {
      await handle.close();
    }
    guard?.check();
  } catch (cause) {
    if (cause instanceof HostBoundaryError) throw cause;
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Pinned file inspection is unavailable.",
      true,
      { cause },
    );
  }
}
