import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as Koffi from "koffi";
import { portableRelativePath } from "../src/filesystem.js";

type Handle = number | bigint;
export class NativeProbeError extends Error {
  constructor(
    readonly operation: string,
    readonly win32Code: number,
    options?: ErrorOptions,
  ) {
    super(
      `Owned native probe ${operation} failed (Win32 ${win32Code}).`,
      options,
    );
  }
}

/** Test-only feasibility harness: it cannot adopt or operate on an existing root. */
export class OwnedWriteThroughProbe {
  private readonly ownedNames = new Set<string>();
  private handles = 0;
  private closed = false;
  private readonly createFile: (
    name: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: number,
  ) => Handle;
  private readonly getLastError: () => number;
  private readonly getVolume: (
    handle: Handle,
    volumeName: null,
    volumeNameSize: number,
    serial: null,
    maximumComponent: null,
    flags: null,
    fsName: Buffer,
    fsNameSize: number,
  ) => number;
  private readonly getInfo: (handle: Handle, info: Buffer) => number;
  private readonly setInfo: (
    handle: Handle,
    kind: number,
    info: Buffer,
    size: number,
  ) => number;
  private readonly flush: (handle: Handle) => number;
  private readonly closeHandle: (handle: Handle) => number;
  private readonly library: Koffi.LibraryHandle;
  private constructor(
    koffi: typeof Koffi,
    private readonly directory: string,
    private readonly identity: { dev: number; ino: number },
  ) {
    if (koffi.sizeof("void *") !== 8)
      throw new Error("Probe requires a verified 64-bit handle layout.");
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
      throw new Error(
        "Unexpected FILE_RENAME_INFO layout; refusing native calls.",
      );
    this.library = koffi.load("kernel32.dll");
    this.createFile = this.library.func(
      "uintptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, uintptr_t)",
    );
    this.getLastError = this.library.func("uint32_t __stdcall GetLastError()");
    this.getVolume = this.library.func(
      "int __stdcall GetVolumeInformationByHandleW(uintptr_t, void *, uint32_t, void *, void *, void *, _Out_ void *, uint32_t)",
    );
    this.getInfo = this.library.func(
      "int __stdcall GetFileInformationByHandle(uintptr_t, _Out_ void *)",
    );
    this.setInfo = this.library.func(
      "int __stdcall SetFileInformationByHandle(uintptr_t, int, void *, uint32_t)",
    );
    this.flush = this.library.func("int __stdcall FlushFileBuffers(uintptr_t)");
    this.closeHandle = this.library.func(
      "int __stdcall CloseHandle(uintptr_t)",
    );
  }
  static async create(): Promise<OwnedWriteThroughProbe> {
    if (
      process.platform !== "win32" ||
      !["x64", "arm64"].includes(process.arch)
    )
      throw new Error("Unsupported host for the Windows-only native probe.");
    // The installed optional prebuild is loaded directly; no cnoke/install/compiler call.
    const koffi = await import("koffi");
    const directory = await mkdtemp(
      path.join(tmpdir(), "studio-native-write-through owned-"),
    );
    try {
      return new OwnedWriteThroughProbe(
        koffi,
        directory,
        await lstat(directory),
      );
    } catch (error) {
      await rm(directory, { recursive: true });
      throw error;
    }
  }
  get openHandleCount(): number {
    return this.handles;
  }
  private file(name: string): string {
    portableRelativePath(name);
    if (name.includes("/"))
      throw new Error("Probe accepts flat owned names only.");
    return path.join(this.directory, name);
  }
  private async checkRoot(): Promise<void> {
    const current = await lstat(this.directory);
    if (
      this.closed ||
      current.isSymbolicLink() ||
      current.dev !== this.identity.dev ||
      current.ino !== this.identity.ino
    )
      throw new Error("Owned probe directory identity changed.");
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    await this.checkRoot();
    if (bytes.byteLength > 65536)
      throw new Error("Probe fixture byte bound exceeded.");
    await writeFile(this.file(name), bytes, { flag: "wx", mode: 0o600 });
    this.ownedNames.add(name);
  }
  async read(name: string): Promise<Uint8Array> {
    await this.checkRoot();
    if (!this.ownedNames.has(name)) throw new Error("Not an owned probe file.");
    return Uint8Array.from(await readFile(this.file(name)));
  }
  async exists(name: string): Promise<boolean> {
    await this.checkRoot();
    try {
      await stat(this.file(name));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  private info(handle: Handle): Buffer {
    const bytes = Buffer.alloc(52);
    if (!this.getInfo(handle, bytes))
      throw new NativeProbeError("file-information", this.getLastError());
    if (
      (bytes.readUInt32LE(0) & (0x400 | 0x10)) !== 0 ||
      bytes.readUInt32LE(40) !== 1
    )
      throw new Error("Probe refuses reparse/directory/multiply-linked files.");
    return bytes;
  }
  async rename(source: string, destination: string) {
    await this.checkRoot();
    const sourcePath = this.file(source);
    const destinationPath = this.file(destination);
    if (!this.ownedNames.has(source))
      throw new Error("Source is not an owned probe file.");
    const sourceStat = await lstat(sourcePath);
    if (
      sourceStat.isSymbolicLink() ||
      !sourceStat.isFile() ||
      sourceStat.nlink !== 1
    )
      throw new Error("Source is not an owned regular file.");
    const openFlags = 0x80200000; // FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT
    const handle = this.createFile(
      sourcePath,
      0xc0010000,
      0,
      null,
      3,
      openFlags,
      0,
    );
    if (handle === 0xffffffffffffffffn || handle === -1 || handle === -1n)
      throw new NativeProbeError("open", this.getLastError());
    this.handles++;
    let evidence: Record<string, string | number | boolean> | undefined;
    let failure: unknown;
    try {
      const fsName = Buffer.alloc(64);
      if (!this.getVolume(handle, null, 0, null, null, null, fsName, 32))
        throw new NativeProbeError("filesystem-query", this.getLastError());
      const filesystem = fsName.toString("utf16le").split("\0")[0];
      if (filesystem !== "NTFS")
        throw new Error("Probe requires the documented local NTFS profile.");
      const before = this.info(handle);
      if (!this.flush(handle))
        throw new NativeProbeError("preflush", this.getLastError());
      const target = Buffer.from(destinationPath, "utf16le");
      const renameInfo = Buffer.alloc(20 + target.byteLength + 2);
      // Zero Flags/ReplaceIfExists and RootDirectory; no replace/copy/reboot operation.
      renameInfo.writeUInt32LE(target.byteLength, 16);
      target.copy(renameInfo, 20);
      if (!this.setInfo(handle, 3, renameInfo, renameInfo.byteLength))
        throw new NativeProbeError("rename", this.getLastError());
      this.ownedNames.delete(source);
      this.ownedNames.add(destination);
      if (!this.flush(handle))
        throw new NativeProbeError("postflush", this.getLastError());
      const after = this.info(handle);
      if (
        !before.subarray(28, 32).equals(after.subarray(28, 32)) ||
        !before.subarray(44, 52).equals(after.subarray(44, 52))
      )
        throw new Error("Native rename changed the opened file identity.");
      evidence = {
        filesystem,
        openFlags,
        shareMode: 0,
        renameClass: 3,
        replaceIfExists: false,
        preflush: true,
        rename: true,
        postflush: true,
        sameFileIdentity: true,
        handleClosed: true,
        guarantee: "documented-ntfs-write-through-request-not-power-cut-tested",
      };
    } catch (error) {
      failure = error;
    }
    if (!this.closeHandle(handle))
      throw new NativeProbeError("close-handle", this.getLastError(), {
        cause: failure,
      });
    this.handles--;
    if (failure !== undefined) throw failure;
    if (!evidence)
      throw new Error("Native probe completed without verifiable evidence.");
    return evidence;
  }
  async close(): Promise<void> {
    await this.checkRoot();
    if (this.handles)
      throw new Error("Refusing cleanup while an owned native handle is open.");
    this.closed = true;
    this.library.unload();
    await rm(this.directory, { recursive: true });
  }
}
