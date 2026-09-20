import { types } from "node:util";
import { HostBoundaryError } from "./guards.js";
import { PAT_MAX_BYTES } from "./pat-input.js";

const typedBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)?.get;
const typedByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const typedFill = Uint8Array.prototype.fill;
function invalid(): never {
  throw new HostBoundaryError(
    "PROVIDER_UNAVAILABLE",
    "Native credential returned an invalid byte result; sensitive details withheld.",
    true,
  );
}

/** Runtime byte/absence representations differ from the pinned async declaration. */
export function normalizeNativeSecret(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  if (types.isProxy(value)) invalid();
  if (types.isUint8Array(value)) {
    if (
      !typedBuffer ||
      types.isSharedArrayBuffer(Reflect.apply(typedBuffer, value, []))
    )
      invalid();
    if (!typedByteLength) invalid();
    const byteLength: unknown = Reflect.apply(typedByteLength, value, []);
    if (
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength > PAT_MAX_BYTES
    ) {
      Reflect.apply(typedFill, value, [0]);
      invalid();
    }
    return value;
  }
  if (!Array.isArray(value)) invalid();
  const lengthProperty = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = lengthProperty?.value;
  // Bound the new compatibility copy before inspecting elements or allocating.
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > PAT_MAX_BYTES
  )
    invalid();
  let bytes: Uint8Array | undefined;
  let accepted = false;
  try {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      !lengthProperty?.writable ||
      Reflect.ownKeys(value).length !== length + 1
    )
      invalid();
    bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      const byte: unknown =
        property && Object.hasOwn(property, "value")
          ? property.value
          : undefined;
      if (
        !property ||
        !Object.hasOwn(property, "value") ||
        !property.writable ||
        !property.enumerable ||
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255
      )
        invalid();
      bytes[index] = byte;
    }
    accepted = true;
    return bytes;
  } catch {
    invalid();
  } finally {
    // Own data descriptors avoid getters, inherited values, setters and iterators.
    // Unsupported immutable/oversized provider storage is not claimed erasable.
    let scrubbed = true;
    try {
      for (let index = 0; index < length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (property && Object.hasOwn(property, "value") && property.writable)
          Object.defineProperty(value, String(index), { value: 0 });
        else scrubbed = false;
      }
    } catch {
      scrubbed = false;
    }
    if (!accepted || !scrubbed) bytes?.fill(0);
    if (accepted && !scrubbed) invalid();
  }
}
