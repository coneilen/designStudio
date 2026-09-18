import path from "node:path";
import { HostBoundaryError } from "./guards.js";
import { extendedDrivePath, nativeDrivePath } from "./windows-paths.js";

export type NativeHandle = number | bigint;
export interface NativeFileIdentity {
  path: string;
  fileId: string;
  volumeId: number;
  byteLength: number;
  filesystem: "NTFS";
}
export interface WindowsBindings {
  open(path: string): NativeHandle;
  inspect(handle: NativeHandle): NativeFileIdentity;
  rename(handle: NativeHandle, destination: string): void;
  flush(handle: NativeHandle): void;
  close(handle: NativeHandle): void;
}
export function sameNativeFile(
  a: NativeFileIdentity,
  b: NativeFileIdentity,
): boolean {
  return (
    a.fileId === b.fileId &&
    a.volumeId === b.volumeId &&
    a.byteLength === b.byteLength
  );
}
export function sameNativePath(a: string, b: string): boolean {
  return (
    path.win32.normalize(a).toLowerCase() ===
    path.win32.normalize(b).toLowerCase()
  );
}
let loaded: Promise<WindowsBindings> | undefined;
export function loadWindowsBindings(): Promise<WindowsBindings> {
  loaded ??= load().catch((error: unknown) => {
    if (error instanceof HostBoundaryError) throw error;
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Windows API binding initialization failed; no fallback.",
      true,
      { cause: error },
    );
  });
  return loaded;
}
async function load(): Promise<WindowsBindings> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "The write-through profile requires Windows x64/arm64 and local NTFS.",
      true,
    );
  let koffi: typeof import("koffi");
  try {
    koffi = await import("koffi");
  } catch (error) {
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Optional pinned Windows native prebuild is unavailable; no compiler or portable fallback.",
      true,
      { cause: error },
    );
  }
  if (koffi.sizeof("void *") !== 8)
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Unverified native pointer layout.",
      true,
    );
  const layout = koffi.struct({
    Flags: "uint32_t",
    RootDirectory: "void *",
    FileNameLength: "uint32_t",
    FileName: koffi.array("uint16_t", 1),
  });
  if (
    layout.members?.RootDirectory?.offset !== 8 ||
    layout.members?.FileNameLength?.offset !== 16 ||
    layout.members?.FileName?.offset !== 20
  )
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Unverified FILE_RENAME_INFO layout.",
      true,
    );
  const library = koffi.load("kernel32.dll");
  const createFile: (
    name: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: number,
  ) => NativeHandle = library.func(
    "uintptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, uintptr_t)",
  );
  const lastError: () => number = library.func(
    "uint32_t __stdcall GetLastError()",
  );
  const getVolume: (
    handle: NativeHandle,
    label: null,
    labelSize: number,
    serial: null,
    maxComponent: null,
    flags: null,
    fsName: Buffer,
    fsNameSize: number,
  ) => number = library.func(
    "int __stdcall GetVolumeInformationByHandleW(uintptr_t, void *, uint32_t, void *, void *, void *, _Out_ void *, uint32_t)",
  );
  const getInfo: (handle: NativeHandle, info: Buffer) => number = library.func(
    "int __stdcall GetFileInformationByHandle(uintptr_t, _Out_ void *)",
  );
  const getPath: (
    handle: NativeHandle,
    name: Buffer,
    characters: number,
    flags: number,
  ) => number = library.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(uintptr_t, _Out_ void *, uint32_t, uint32_t)",
  );
  const setInfo: (
    handle: NativeHandle,
    kind: number,
    info: Buffer,
    size: number,
  ) => number = library.func(
    "int __stdcall SetFileInformationByHandle(uintptr_t, int, void *, uint32_t)",
  );
  const flush: (handle: NativeHandle) => number = library.func(
    "int __stdcall FlushFileBuffers(uintptr_t)",
  );
  const close: (handle: NativeHandle) => number = library.func(
    "int __stdcall CloseHandle(uintptr_t)",
  );
  const failure = (operation: string) => {
    const code = lastError();
    return new HostBoundaryError(
      code === 183 || code === 80
        ? "CONFLICT"
        : code === 2
          ? "RESOURCE_UNRESOLVED"
          : "PATH_FORBIDDEN",
      `Native ${operation} failed (Win32 ${code}).`,
    );
  };
  return {
    open(filename) {
      const handle = createFile(
        extendedDrivePath(filename),
        0xc0010000,
        0,
        null,
        3,
        0x80200000,
        0,
      );
      if (handle === 0xffffffffffffffffn || handle === -1 || handle === -1n)
        throw failure("open");
      return handle;
    },
    inspect(handle) {
      const info = Buffer.alloc(52);
      if (!getInfo(handle, info)) throw failure("file-information");
      if (
        (info.readUInt32LE(0) & (0x400 | 0x10)) !== 0 ||
        info.readUInt32LE(40) !== 1
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Native publication refuses reparse points, directories and multiple links.",
        );
      const fsName = Buffer.alloc(64);
      if (!getVolume(handle, null, 0, null, null, null, fsName, 32))
        throw failure("filesystem-query");
      if (fsName.toString("utf16le").split("\0")[0] !== "NTFS")
        throw new HostBoundaryError(
          "UNSUPPORTED_HOST",
          "Only local NTFS has this publication profile.",
          true,
        );
      const filename = Buffer.alloc(65536);
      const characters = getPath(handle, filename, 32768, 0);
      if (!characters) throw failure("file-path");
      if (characters >= 32768)
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Native file path exceeds the verified buffer.",
        );
      const full = filename.subarray(0, characters * 2).toString("utf16le");
      const byteLength = Number(
        (BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36)),
      );
      if (!Number.isSafeInteger(byteLength))
        throw new HostBoundaryError(
          "INPUT_LIMIT",
          "Native file length cannot be represented safely.",
        );
      return {
        path: nativeDrivePath(full),
        filesystem: "NTFS",
        volumeId: info.readUInt32LE(28),
        fileId: info.subarray(44, 52).toString("hex"),
        byteLength,
      };
    },
    rename(handle, destination) {
      const name = Buffer.from(extendedDrivePath(destination), "utf16le");
      if (name.byteLength > 65532)
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Native destination is too long.",
        );
      const information = Buffer.alloc(20 + name.byteLength + 2);
      information.writeUInt32LE(name.byteLength, 16);
      name.copy(information, 20);
      if (!setInfo(handle, 3, information, information.byteLength))
        throw failure("no-replace-rename");
    },
    flush(handle) {
      if (!flush(handle)) throw failure("flush");
    },
    close(handle) {
      if (!close(handle)) throw failure("close-handle");
    },
  };
}
