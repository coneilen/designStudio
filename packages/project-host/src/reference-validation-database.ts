import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { HostBoundaryError } from "@design-studio/host";
import { digest } from "./installation-manifest.js";
import { loadNative, type ReadLease, refuse } from "./native.js";
import { REFERENCE_VALIDATION_POLICY } from "./reference-validation-profile.js";

/** Internal helper; the native work owner supplies the admitted path, SID and live authority. */
export async function pinImmutableReferenceDatabase(input: {
  filename: string;
  sid: string;
  authoritySha256: string;
  authorize(): Promise<void>;
  retainedPins: Set<ReadLease>;
}) {
  const { filename, sid, retainedPins, authoritySha256 } = input;
  const authorize = input.authorize.bind(input);
  await authorize();
  if (
    path.resolve(filename) !== filename ||
    (await realpath(filename)) !== filename
  )
    refuse(
      "Immutable database path must be the canonical native-attested path.",
    );
  const native = await loadNative();
  const parent = path.dirname(filename);
  const held: ReadLease[] = [];
  const release = () => {
    const errors: unknown[] = [];
    for (const pin of [...held].reverse()) {
      try {
        pin.close();
        held.splice(held.indexOf(pin), 1);
        retainedPins.delete(pin);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Immutable database pins did not close.",
      );
  };
  const noSidecars = async () => {
    let count = 0;
    const names = new Set<string>();
    for await (const entry of await opendir(parent)) {
      if (++count > 20000)
        refuse("Immutable database directory exceeds its bound.");
      const name = entry.name.normalize("NFC").toLowerCase();
      if (names.has(name)) refuse("Immutable database directory aliases.");
      names.add(name);
    }
    const name = path.basename(filename).toLowerCase();
    if (
      ["-wal", "-shm", "-journal"].some((suffix) =>
        names.has(`${name}${suffix}`),
      )
    )
      refuse("Immutable validation refuses every retained SQLite sidecar.");
  };
  try {
    await noSidecars();
    for (const [entry, directory] of [
      [parent, true],
      [filename, false],
    ] as const) {
      const pin = native.pinRead(entry, directory, sid);
      held.push(pin);
      retainedPins.add(pin);
    }
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      refuse("Immutable main database identity is not an ordinary owned file.");
    if (before.size > REFERENCE_VALIDATION_POLICY.maxInputBytes)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Immutable main database exceeds its separate size bound.",
      );
    const check = async () => {
      if (held.length !== 2) refuse("Immutable database pin is closed.");
      await authorize();
      await noSidecars();
      const after = await lstat(filename);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        (await realpath(filename)) !== filename
      )
        refuse("Immutable main database changed.");
      const fresh = native.pinRead(filename, false, sid);
      retainedPins.add(fresh);
      try {
        if (
          fresh.identity.file !== held[1]?.identity.file ||
          fresh.identity.volume !== held[1]?.identity.volume ||
          fresh.byteLength !== before.size
        )
          refuse("Immutable native database identity changed.");
      } finally {
        fresh.close();
        retainedPins.delete(fresh);
      }
      await authorize();
    };
    await check();
    return {
      identitySha256: digest(
        Buffer.from(
          JSON.stringify({
            authoritySha256,
            identities: held.map((pin) => pin.identity),
            size: before.size,
            mtime: before.mtimeMs,
          }),
        ),
      ),
      check,
      close: release,
      async checkReleased() {
        if (held.length) refuse("Immutable database pins remain held.");
        await authorize();
        await noSidecars();
        const after = await lstat(filename);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.nlink !== 1 ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          (await realpath(filename)) !== filename
        )
          refuse("Database preimage changed after immutable pin release.");
        const inspected = native.inspect(filename, false, sid);
        inspected.close();
        await authorize();
      },
    };
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Immutable database admission and cleanup failed.",
      );
    }
    throw error;
  }
}
