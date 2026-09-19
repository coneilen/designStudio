import { HostBoundaryError } from "./guards.js";

/** Native absence can be null despite the pinned asynchronous declaration. */
export function normalizeNativeSecret(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !(value instanceof Uint8Array) ||
    value.buffer instanceof SharedArrayBuffer
  )
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Native credential returned an invalid byte result; sensitive details withheld.",
      true,
    );
  return value;
}
