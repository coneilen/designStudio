import { HostBoundaryError, type OperationGuard } from "./guards.js";
import {
  loadWindowsBindings,
  type NativeFileIdentity,
  type NativeHandle,
  sameNativeFile,
  sameNativePath,
  type WindowsBindings,
} from "./windows-native.js";

export const WINDOWS_PUBLICATION_PROFILE =
  "windows-ntfs-write-through-v1" as const;
export interface NativePublicationProof {
  profile: typeof WINDOWS_PUBLICATION_PROFILE;
  identity: NativeFileIdentity;
}
export class NativePublicationInterrupted extends HostBoundaryError {
  constructor(
    readonly identity: NativeFileIdentity,
    options: ErrorOptions,
  ) {
    super(
      "OUTPUT_UNCERTAIN",
      "Native rename is visible, but verified flush/cleanup evidence is incomplete; retry the owned publication.",
      false,
      options,
    );
  }
}
function withHandle<T>(
  native: WindowsBindings,
  filename: string,
  action: (handle: NativeHandle) => T,
): T {
  const handle = native.open(filename);
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: action(handle) };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    native.close(handle);
  } catch (error) {
    throw new HostBoundaryError(
      "INTERNAL_ERROR",
      "Native file handle could not be closed.",
      false,
      {
        cause: new AggregateError(result.ok ? [error] : [result.error, error]),
      },
    );
  }
  if (!result.ok) throw result.error;
  return result.value;
}
export class WindowsNtfsPublisher {
  async publish(
    source: string,
    destination: string,
    byteLength: number,
    guard: OperationGuard,
  ): Promise<NativePublicationProof> {
    const native = await loadWindowsBindings();
    guard.check();
    let renamed: NativeFileIdentity | undefined;
    try {
      return withHandle(native, source, (handle) => {
        const before = native.inspect(handle);
        if (
          !sameNativePath(before.path, source) ||
          before.byteLength !== byteLength
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Native source identity does not match the validated stage.",
          );
        native.flush(handle);
        guard.check();
        native.rename(handle, destination);
        renamed = { ...before, path: destination };
        // After the atomic mutation, finish flush/close even if cancellation arrives.
        native.flush(handle);
        const after = native.inspect(handle);
        if (
          !sameNativeFile(before, after) ||
          !sameNativePath(after.path, destination)
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Native destination identity does not match the owned source.",
          );
        return { profile: WINDOWS_PUBLICATION_PROFILE, identity: after };
      });
    } catch (error) {
      if (renamed)
        throw new NativePublicationInterrupted(renamed, { cause: error });
      if (error instanceof HostBoundaryError) throw error;
      throw new HostBoundaryError(
        "INTERNAL_ERROR",
        "Native publication failed before rename.",
        false,
        { cause: error },
      );
    }
  }
  async resume(
    destination: string,
    identity: NativeFileIdentity,
    guard: OperationGuard,
  ): Promise<NativePublicationProof> {
    const native = await loadWindowsBindings();
    guard.check();
    try {
      return withHandle(native, destination, (handle) => {
        const current = native.inspect(handle);
        if (
          !sameNativeFile(current, identity) ||
          !sameNativePath(current.path, destination)
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Interrupted native publication was replaced.",
          );
        guard.check();
        native.flush(handle);
        return { profile: WINDOWS_PUBLICATION_PROFILE, identity: current };
      });
    } catch (error) {
      throw new NativePublicationInterrupted(identity, { cause: error });
    }
  }
  async verify(
    destination: string,
    proof: NativePublicationProof,
    guard: OperationGuard,
  ): Promise<void> {
    const native = await loadWindowsBindings();
    guard.check();
    withHandle(native, destination, (handle) => {
      const current = native.inspect(handle);
      if (
        proof.profile !== WINDOWS_PUBLICATION_PROFILE ||
        !sameNativeFile(current, proof.identity) ||
        !sameNativePath(current.path, destination) ||
        !sameNativePath(proof.identity.path, destination)
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Native durability evidence does not match the current owned file.",
        );
    });
    guard.check();
  }
}
