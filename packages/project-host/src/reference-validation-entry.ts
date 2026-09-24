import { HostBoundaryError } from "@design-studio/host";
import {
  loadNative,
  type ReadLease,
  type RetainedReadLease,
  refuse,
} from "./native.js";

/** Internal: roots and authority come only from the current native work owner. */
export async function pinRetainedReferenceEntry(input: {
  root: string;
  relative: string;
  directory: boolean;
  sid: string;
  authorize(): Promise<void>;
  retainedPins: Set<ReadLease>;
}) {
  const { root, relative, directory, sid, retainedPins } = input;
  const authorize = input.authorize.bind(input);
  const parts = relative === "" ? [] : relative.split("/");
  if (
    (!parts.length && !directory) ||
    parts.length > 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]{1,120}$/.test(part) ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part),
    )
  )
    refuse("Retained validation path is outside the admitted roots.");
  await authorize();
  const native = await loadNative();
  const held: RetainedReadLease[] = [];
  const own = (pin: RetainedReadLease) => {
    held.push(pin);
    retainedPins.add(pin);
    return pin;
  };
  const close = () => {
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
        "Retained descendant pins did not close.",
      );
  };
  try {
    let leaf = own(native.pinRetainedRoot(root, sid));
    for (const [index, part] of parts.entries())
      leaf = own(
        native.pinRetainedChild(
          leaf,
          part,
          index < parts.length - 1 || directory,
        ),
      );
    const check = async () => {
      if (held.length !== parts.length + 1)
        refuse("Retained descendant ownership is closed.");
      await authorize();
      leaf.check();
      await authorize();
      leaf.check();
    };
    await check();
    return Object.freeze({
      handle: leaf.handle,
      identity: leaf.identity,
      byteLength: leaf.byteLength,
      read: leaf.read.bind(leaf),
      check,
      close,
    });
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new HostBoundaryError(
        error instanceof HostBoundaryError ? error.code : "INTERRUPTED",
        "Retained descendant admission and cleanup failed.",
        false,
        { cause: new AggregateError([error, cleanup]) },
      );
    }
    throw error;
  }
}
