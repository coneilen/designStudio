import * as fs from "node:fs";
import { HostBoundaryError } from "../src/guards.js";

export interface PortablePinOwner {
  close(): void;
}

/** Test-only read acquisition. Directories remain observations, not native pins or ACL/share-lock claims. */
export function portableRetainedPin(
  filename: string,
  directory: boolean,
  owners: Set<PortablePinOwner>,
) {
  if (
    !/[\\/](?:reference-synthetic-|capture-recovery-synthetic-|portable-retained-pin-)[^\\/]+[\\/]/.test(
      filename,
    )
  )
    throw new Error("Portable pin requires a generated synthetic fixture.");
  const before = fs.lstatSync(filename, { bigint: true });
  const valid = (stat: fs.BigIntStats) =>
    !stat.isSymbolicLink() &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n);
  if (!valid(before))
    throw new HostBoundaryError("PATH_FORBIDDEN", "Synthetic pin refused.");
  const fd = directory
    ? undefined
    : fs.openSync(
        filename,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
  let closed = false;
  const owner: PortablePinOwner = {
    close() {
      if (closed) return;
      if (fd !== undefined) fs.closeSync(fd);
      closed = true;
      owners.delete(owner);
    },
  };
  owners.add(owner);
  try {
    const opened =
      fd === undefined
        ? fs.lstatSync(filename, { bigint: true })
        : fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(filename, { bigint: true });
    if (
      !valid(opened) ||
      !valid(current) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Synthetic acquisition identity changed.",
      );
    const volume = Number(opened.dev),
      byteLength = Number(opened.size);
    if (!Number.isSafeInteger(volume) || !Number.isSafeInteger(byteLength))
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Synthetic pin metadata exceeds numeric bounds.",
      );
    return {
      handle: fd ?? 0,
      identity: { path: filename, volume, file: String(opened.ino) },
      byteLength,
      async check() {
        if (closed)
          throw new HostBoundaryError("FORBIDDEN", "Synthetic pin closed.");
        const pathStat = fs.lstatSync(filename, { bigint: true });
        const held =
          fd === undefined ? pathStat : fs.fstatSync(fd, { bigint: true });
        if (
          !valid(held) ||
          !valid(pathStat) ||
          held.dev !== opened.dev ||
          held.ino !== opened.ino ||
          pathStat.dev !== opened.dev ||
          pathStat.ino !== opened.ino
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Synthetic pinned identity changed.",
          );
      },
      read(): never {
        throw new Error("Portable pin does not consume body bytes.");
      },
      close: owner.close,
    };
  } catch (error) {
    try {
      owner.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Synthetic acquisition cleanup retains its descriptor owner.",
      );
    }
    throw error;
  }
}

export function closePortablePins(owners: Set<PortablePinOwner>) {
  const errors: unknown[] = [];
  for (const owner of [...owners]) {
    try {
      owner.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Synthetic retained descriptors did not close.",
    );
}
