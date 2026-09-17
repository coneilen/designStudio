import path from "node:path";
import { HostBoundaryError } from "@design-studio/host";

export type Handle = number | bigint;
export interface Identity {
  path: string;
  volume: number;
  file: string;
}
export interface Lease {
  handle: Handle;
  identity: Identity;
  close(): void;
}
export interface ReadLease extends Lease {
  read(buffer: Buffer): number;
}
export interface InstallationEntry extends Lease {
  write(bytes: Buffer): void;
  finalize(publicBrowser?: boolean): void;
}
export interface Native {
  principal(): string;
  localAppData(): string;
  createDirectory(filename: string, sid: string): void;
  createFile(
    filename: string,
    sid: string,
    bytes: Buffer,
    destination?: string,
  ): void;
  inspect(filename: string, directory: boolean, sid?: string): Lease;
  pinRead(filename: string, directory: boolean, sid?: string): ReadLease;
  pinInstallation(
    filename: string,
    directory: boolean,
    sid: string,
    publicBrowser?: boolean,
  ): ReadLease;
  createInstallationEntry(
    filename: string,
    directory: boolean,
    sid: string,
  ): InstallationEntry;
}

export function refuse(message: string): never {
  throw new HostBoundaryError("ACTION_REQUIRED", message);
}

let loading: Promise<Native> | undefined;
export function loadNative(): Promise<Native> {
  loading ??= load();
  return loading;
}

async function load(): Promise<Native> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Fixture provisioning requires Windows x64/arm64 and local NTFS.",
      true,
    );
  let koffi: typeof import("koffi");
  try {
    koffi = await import("koffi");
  } catch (cause) {
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Pinned optional Koffi prebuild unavailable; no fallback or compiler.",
      true,
      { cause },
    );
  }
  const sa = koffi.struct({
    length: "uint32_t",
    descriptor: "void *",
    inherit: "int",
  });
  const renameLayout = koffi.struct({
    flags: "uint32_t",
    root: "void *",
    length: "uint32_t",
    name: "uint16_t",
  });
  const tokenUser = koffi.struct({ sid: "void *", attributes: "uint32_t" });
  const fileTime = koffi.struct({ low: "uint32_t", high: "uint32_t" });
  const fileInformation = koffi.struct({
    attributes: "uint32_t",
    creation: fileTime,
    access: fileTime,
    write: fileTime,
    volume: "uint32_t",
    sizeHigh: "uint32_t",
    sizeLow: "uint32_t",
    links: "uint32_t",
    indexHigh: "uint32_t",
    indexLow: "uint32_t",
  });
  const aclLayout = koffi.struct({
    revision: "uint8_t",
    reserved: "uint8_t",
    size: "uint16_t",
    count: "uint16_t",
    reserved2: "uint16_t",
  });
  const aceLayout = koffi.struct({
    type: "uint8_t",
    flags: "uint8_t",
    size: "uint16_t",
    mask: "uint32_t",
    sid: "uint32_t",
  });
  if (
    koffi.sizeof("void *") !== 8 ||
    koffi.sizeof(sa) !== 24 ||
    sa.members?.descriptor?.offset !== 8 ||
    sa.members?.inherit?.offset !== 16 ||
    renameLayout.members?.root?.offset !== 8 ||
    renameLayout.members?.length?.offset !== 16 ||
    renameLayout.members?.name?.offset !== 20 ||
    koffi.sizeof(tokenUser) !== 16 ||
    tokenUser.members?.attributes?.offset !== 8 ||
    koffi.sizeof(fileInformation) !== 52 ||
    fileInformation.members?.volume?.offset !== 28 ||
    fileInformation.members?.links?.offset !== 40 ||
    fileInformation.members?.indexHigh?.offset !== 44 ||
    koffi.sizeof(aclLayout) !== 8 ||
    aclLayout.members?.count?.offset !== 4 ||
    aceLayout.members?.mask?.offset !== 4 ||
    aceLayout.members?.sid?.offset !== 8
  )
    refuse("Unverified Windows security/rename ABI layout.");
  const kernel = koffi.load("kernel32.dll");
  const advapi = koffi.load("advapi32.dll");
  const shell = koffi.load("shell32.dll");
  const ole = koffi.load("ole32.dll");
  const lastError: () => number = kernel.func(
    "uint32_t __stdcall GetLastError()",
  );
  const closeHandle: (handle: Handle) => number = kernel.func(
    "int __stdcall CloseHandle(uintptr_t)",
  );
  const currentProcess: () => Handle = kernel.func(
    "uintptr_t __stdcall GetCurrentProcess()",
  );
  const currentThread: () => Handle = kernel.func(
    "uintptr_t __stdcall GetCurrentThread()",
  );
  const openProcessToken: (
    process: Handle,
    access: number,
    token: Buffer,
  ) => number = advapi.func(
    "int __stdcall OpenProcessToken(uintptr_t, uint32_t, _Out_ void *)",
  );
  const openThreadToken: (
    thread: Handle,
    access: number,
    self: number,
    token: Buffer,
  ) => number = advapi.func(
    "int __stdcall OpenThreadToken(uintptr_t, uint32_t, int, _Out_ void *)",
  );
  const tokenInfo: (
    token: Handle,
    kind: number,
    buffer: Buffer | null,
    size: number,
    length: Buffer,
  ) => number = advapi.func(
    "int __stdcall GetTokenInformation(uintptr_t, int, _Out_ void *, uint32_t, _Out_ void *)",
  );
  const sidToString: (sid: unknown, text: unknown[]) => number = advapi.func(
    "int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)",
  );
  const validSid: (sid: unknown) => number = advapi.func(
    "int __stdcall IsValidSid(void *)",
  );
  const localFree: (pointer: unknown) => unknown = kernel.func(
    "void * __stdcall LocalFree(void *)",
  );
  const knownFolder: (
    id: Buffer,
    flags: number,
    token: Handle,
    result: unknown[],
  ) => number = shell.func(
    "int32_t __stdcall SHGetKnownFolderPath(void *, uint32_t, uintptr_t, _Out_ void **)",
  );
  const coFree: (pointer: unknown) => void = ole.func(
    "void __stdcall CoTaskMemFree(void *)",
  );
  const convertDescriptor: (
    sddl: string,
    revision: number,
    result: unknown[],
    size: Buffer,
  ) => number = advapi.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32_t, _Out_ void **, _Out_ void *)",
  );
  const createDirectory: (name: string, attributes: Buffer) => number =
    kernel.func("int __stdcall CreateDirectoryW(const char16_t *, void *)");
  const createFile: (
    name: string,
    access: number,
    share: number,
    attributes: Buffer | null,
    disposition: number,
    flags: number,
    template: Handle,
  ) => Handle = kernel.func(
    "uintptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, uintptr_t)",
  );
  const getInfo: (handle: Handle, info: Buffer) => number = kernel.func(
    "int __stdcall GetFileInformationByHandle(uintptr_t, _Out_ void *)",
  );
  const getPath: (
    handle: Handle,
    buffer: Buffer,
    size: number,
    flags: number,
  ) => number = kernel.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(uintptr_t, _Out_ void *, uint32_t, uint32_t)",
  );
  const getVolume: (
    handle: Handle,
    label: null,
    labelSize: number,
    serial: null,
    max: null,
    flags: null,
    name: Buffer,
    size: number,
  ) => number = kernel.func(
    "int __stdcall GetVolumeInformationByHandleW(uintptr_t, void *, uint32_t, void *, void *, void *, _Out_ void *, uint32_t)",
  );
  const driveType: (root: string) => number = kernel.func(
    "uint32_t __stdcall GetDriveTypeW(const char16_t *)",
  );
  const securityInfo: (
    handle: Handle,
    kind: number,
    flags: number,
    owner: unknown[],
    group: null,
    dacl: unknown[],
    sacl: null,
    descriptor: unknown[],
  ) => number = advapi.func(
    "uint32_t __stdcall GetSecurityInfo(uintptr_t, int, uint32_t, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)",
  );
  const descriptorControl: (
    descriptor: unknown,
    control: Buffer,
    revision: Buffer,
  ) => number = advapi.func(
    "int __stdcall GetSecurityDescriptorControl(void *, _Out_ void *, _Out_ void *)",
  );
  const getAce: (acl: unknown, index: number, result: unknown[]) => number =
    advapi.func("int __stdcall GetAce(void *, uint32_t, _Out_ void **)");
  const validAcl: (acl: unknown) => number = advapi.func(
    "int __stdcall IsValidAcl(void *)",
  );
  const write: (
    handle: Handle,
    bytes: Buffer,
    size: number,
    written: Buffer,
    overlap: null,
  ) => number = kernel.func(
    "int __stdcall WriteFile(uintptr_t, void *, uint32_t, _Out_ void *, void *)",
  );
  const read: (
    handle: Handle,
    bytes: Buffer,
    size: number,
    readBytes: Buffer,
    overlap: null,
  ) => number = kernel.func(
    "int __stdcall ReadFile(uintptr_t, _Out_ void *, uint32_t, _Out_ void *, void *)",
  );
  const descriptorDacl: (
    descriptor: unknown,
    present: Buffer,
    dacl: unknown[],
    defaulted: Buffer,
  ) => number = advapi.func(
    "int __stdcall GetSecurityDescriptorDacl(void *, _Out_ void *, _Out_ void **, _Out_ void *)",
  );
  const setSecurity: (
    handle: Handle,
    kind: number,
    flags: number,
    owner: null,
    group: null,
    dacl: unknown,
    sacl: null,
  ) => number = advapi.func(
    "uint32_t __stdcall SetSecurityInfo(uintptr_t, int, uint32_t, void *, void *, void *, void *)",
  );
  const flush: (handle: Handle) => number = kernel.func(
    "int __stdcall FlushFileBuffers(uintptr_t)",
  );
  const setInfo: (
    handle: Handle,
    kind: number,
    bytes: Buffer,
    size: number,
  ) => number = kernel.func(
    "int __stdcall SetFileInformationByHandle(uintptr_t, int, void *, uint32_t)",
  );

  const failure = (operation: string, code = lastError()) =>
    new HostBoundaryError(
      code === 183 || code === 80 ? "CONFLICT" : "ACTION_REQUIRED",
      `${operation} failed (Win32 ${code}); no adoption, ACL repair or automatic cleanup.`,
    );
  function close(handle: Handle): void {
    if (!closeHandle(handle)) throw failure("CloseHandle");
  }
  function free(pointer: unknown): void {
    if (localFree(pointer) !== null) throw failure("LocalFree");
  }
  function preserving<T>(operation: () => T, cleanup: () => void): T {
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      try {
        cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Native operation and resource release failed.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (!failed) cleanup();
    }
  }
  function sidString(sid: unknown): string {
    if (!sid || !validSid(sid)) refuse("Invalid native SID.");
    const output: unknown[] = [null];
    if (!sidToString(sid, output)) throw failure("ConvertSidToStringSidW");
    return preserving(
      () => String(koffi.decode(output[0], "char16_t", -1)),
      () => free(output[0]),
    );
  }
  function tokenSid(handle: Handle): string {
    const size = Buffer.alloc(4);
    const initial = tokenInfo(handle, 1, null, 0, size);
    const code = initial ? 0 : lastError();
    if (initial || code !== 122)
      throw failure("GetTokenInformation(size)", code);
    const length = size.readUInt32LE();
    if (length < 16 || length > 65536)
      refuse("Invalid TOKEN_USER buffer length.");
    const buffer = Buffer.alloc(length);
    if (!tokenInfo(handle, 1, buffer, length, size))
      throw failure("GetTokenInformation");
    return sidString(koffi.decode(buffer, "void *"));
  }
  function principal(): string {
    const processToken = Buffer.alloc(8);
    if (!openProcessToken(currentProcess(), 8, processToken))
      throw failure("OpenProcessToken");
    return preserving(
      () => {
        const processSid = tokenSid(processToken.readBigUInt64LE());
        const threadToken = Buffer.alloc(8);
        if (!openThreadToken(currentThread(), 8, 1, threadToken)) {
          const code = lastError();
          if (code === 1008) return processSid; // ERROR_NO_TOKEN: effective token is the process token.
          throw failure("OpenThreadToken", code);
        }
        return preserving(
          () => {
            const effective = tokenSid(threadToken.readBigUInt64LE());
            if (effective !== processSid)
              refuse(
                "Effective thread principal differs from process principal.",
              );
            // Even matching impersonation tokens can have different restrictions.
            return refuse(
              "Thread impersonation is unsupported; no token changes were made.",
            );
          },
          () => close(threadToken.readBigUInt64LE()),
        );
      },
      () => close(processToken.readBigUInt64LE()),
    );
  }
  function withSecurity<T>(
    sid: string,
    directory: boolean,
    operation: (attributes: Buffer) => T,
  ): T {
    if (principal() !== sid) refuse("Current native principal changed.");
    const pointer: unknown[] = [null];
    const size = Buffer.alloc(4);
    const flags = directory ? "OICI" : "";
    const sddl = `O:${sid}D:P(A;${flags};FA;;;${sid})(A;${flags};FA;;;SY)`;
    if (!convertDescriptor(sddl, 1, pointer, size))
      throw failure("ConvertStringSecurityDescriptor");
    return preserving(
      () => {
        const attributes = Buffer.alloc(24);
        attributes.writeUInt32LE(24);
        koffi.encode(attributes.subarray(8, 16), "void *", pointer[0]);
        return operation(attributes);
      },
      () => free(pointer[0]),
    );
  }
  function checkAcl(
    handle: Handle,
    sid: string,
    directory: boolean,
    installation = false,
    publicBrowser = false,
  ): void {
    const owner: unknown[] = [null];
    const acl: unknown[] = [null];
    const descriptor: unknown[] = [null];
    const code = securityInfo(handle, 1, 5, owner, null, acl, null, descriptor);
    if (code !== 0) throw failure("GetSecurityInfo", code);
    preserving(
      () => {
        if (sidString(owner[0]) !== sid)
          refuse("Private fixture owner differs from native principal.");
        const control = Buffer.alloc(2);
        const revision = Buffer.alloc(4);
        if (!descriptorControl(descriptor[0], control, revision))
          throw failure("GetSecurityDescriptorControl");
        if (
          (control.readUInt16LE() & 0x1004) !== 0x1004 ||
          !acl[0] ||
          !validAcl(acl[0])
        )
          refuse("Private fixture requires a protected non-null valid DACL.");
        const header = Buffer.from(koffi.decode(acl[0], "uint8_t", 8));
        const expectedCount = publicBrowser ? 3 : 2;
        if (header.readUInt16LE(4) !== expectedCount)
          refuse(
            "Private fixture DACL must contain exactly two explicit grants.",
          );
        const seen = new Set<string>();
        for (let index = 0; index < expectedCount; index++) {
          const ace: unknown[] = [null];
          if (!getAce(acl[0], index, ace)) throw failure("GetAce");
          const bytes = Buffer.from(koffi.decode(ace[0], "uint8_t", 8));
          if (
            bytes[0] !== 0 ||
            bytes[1] !== (directory ? 3 : 0) ||
            bytes.readUInt16LE(2) < 20 ||
            bytes.readUInt16LE(2) > 76
          )
            refuse(
              "Unexpected private fixture ACE type, inheritance flags or access mask.",
            );
          const sidBytes = Buffer.from(
            koffi.decode(ace[0], 8, "uint8_t", bytes.readUInt16LE(2) - 8),
          );
          const aceSid = sidString(sidBytes);
          const expectedMask =
            installation && aceSid !== "S-1-5-18" ? 0x1200a9 : 0x1f01ff;
          if (
            bytes.readUInt32LE(4) !== expectedMask ||
            (aceSid !== sid &&
              aceSid !== "S-1-5-18" &&
              !(publicBrowser && aceSid === "S-1-5-32-545")) ||
            seen.has(aceSid)
          )
            refuse("Unexpected or duplicate private fixture trustee.");
          seen.add(aceSid);
        }
      },
      () => free(descriptor[0]),
    );
  }
  function open(
    filename: string,
    access: number,
    share: number,
    attributes: Buffer | null,
    disposition: number,
    flags: number,
  ): Handle {
    if (
      !/^[A-Za-z]:\\/.test(filename) ||
      filename.includes("\0") ||
      filename.includes(":", 2)
    )
      refuse("Only native local absolute drive paths are supported.");
    const handle = createFile(
      `\\\\?\\${filename}`,
      access,
      share,
      attributes,
      disposition,
      flags,
      0,
    );
    if (handle === -1 || handle === -1n || handle === 0xffffffffffffffffn)
      throw failure("CreateFileW");
    return handle;
  }
  function inspectHandle(
    handle: Handle,
    filename: string,
    directory: boolean,
    sid?: string,
    installation = false,
    publicBrowser = false,
  ): Identity {
    const info = Buffer.alloc(52);
    if (!getInfo(handle, info)) throw failure("GetFileInformationByHandle");
    const attributes = info.readUInt32LE();
    if (
      (attributes & 0x400) !== 0 ||
      Boolean(attributes & 0x10) !== directory ||
      (!directory && info.readUInt32LE(40) !== 1)
    )
      refuse("Reparse, wrong-kind or multiply-linked fixture path.");
    const buffer = Buffer.alloc(65536);
    const count = getPath(handle, buffer, 32768, 0);
    if (!count) throw failure("GetFinalPathNameByHandleW");
    if (count >= 32768) refuse("Native path exceeds bounded buffer.");
    const actual = buffer.subarray(0, count * 2).toString("utf16le");
    if (actual.toLowerCase() !== `\\\\?\\${filename}`.toLowerCase())
      refuse("Final native path differs from registered path.");
    if (driveType(path.win32.parse(filename).root) !== 3)
      refuse("Fixture paths require fixed local media.");
    const fs = Buffer.alloc(64);
    if (!getVolume(handle, null, 0, null, null, null, fs, 32))
      throw failure("GetVolumeInformationByHandleW");
    if (fs.toString("utf16le").split("\0")[0] !== "NTFS")
      refuse("Fixture paths require NTFS.");
    if (sid !== undefined)
      checkAcl(handle, sid, directory, installation, publicBrowser);
    return {
      path: filename,
      volume: info.readUInt32LE(28),
      file: info.subarray(44, 52).toString("hex"),
    };
  }
  function pin(
    filename: string,
    directory: boolean,
    sid?: string,
    installation = false,
    publicBrowser = false,
  ): ReadLease {
    const handle = open(
      filename,
      directory ? 0x20081 : 0x80020000,
      1,
      null,
      3,
      0x02200000,
    );
    let identity: Identity;
    try {
      identity = inspectHandle(
        handle,
        filename,
        directory,
        sid,
        installation,
        publicBrowser,
      );
    } catch (error) {
      return preserving(
        () => {
          throw error;
        },
        () => close(handle),
      );
    }
    let closed = false;
    return {
      handle,
      identity,
      read(buffer) {
        if (
          closed ||
          directory ||
          buffer.byteLength < 1 ||
          buffer.byteLength > 1024 * 1024
        )
          refuse("Invalid pinned installation read.");
        const count = Buffer.alloc(4);
        if (!read(handle, buffer, buffer.byteLength, count, null))
          throw failure("ReadFile");
        return count.readUInt32LE();
      },
      close() {
        if (!closed) {
          close(handle);
          closed = true;
        }
      },
    };
  }
  return {
    principal,
    pinRead: pin,
    pinInstallation: (filename, directory, sid, publicBrowser = false) =>
      pin(filename, directory, sid, true, publicBrowser),
    createInstallationEntry(filename, directory, sid) {
      const handle = withSecurity(sid, directory, (attributes) => {
        if (directory) {
          if (!createDirectory(`\\\\?\\${filename}`, attributes))
            throw failure("CreateDirectoryW(installation)");
          return open(filename, 0x60081, 3, null, 3, 0x02200000);
        }
        return open(filename, 0xc0060000, 1, attributes, 1, 0x80200000);
      });
      let identity: Identity;
      try {
        identity = inspectHandle(handle, filename, directory, sid);
      } catch (error) {
        return preserving(
          () => {
            throw error;
          },
          () => close(handle),
        );
      }
      let finalized = false;
      let closed = false;
      return {
        handle,
        identity,
        write(bytes) {
          if (
            closed ||
            finalized ||
            directory ||
            bytes.byteLength > 1024 * 1024
          )
            refuse(
              "Installation entry is closed/finalized or write exceeds its bound.",
            );
          if (!bytes.byteLength) return;
          const count = Buffer.alloc(4);
          if (!write(handle, bytes, bytes.byteLength, count, null))
            throw failure("WriteFile(installation)");
          if (count.readUInt32LE() !== bytes.byteLength)
            refuse("Incomplete installation write.");
        },
        finalize(publicBrowser = false) {
          if (closed || finalized || principal() !== sid)
            refuse(
              "Installation entry is closed/finalized or principal changed.",
            );
          const actual = inspectHandle(handle, filename, directory, sid);
          if (
            actual.file !== identity.file ||
            actual.volume !== identity.volume
          )
            refuse(
              "Owned installation entry identity changed before finalization.",
            );
          if (!directory && !flush(handle))
            throw failure("FlushFileBuffers(installation)");
          const descriptor: unknown[] = [null];
          const flags = directory ? "OICI" : "";
          const sddl = `O:${sid}D:P(A;${flags};FRFX;;;${sid})(A;${flags};FA;;;SY)${publicBrowser ? `(A;${flags};FRFX;;;BU)` : ""}`;
          if (!convertDescriptor(sddl, 1, descriptor, Buffer.alloc(4)))
            throw failure("Installation security descriptor");
          preserving(
            () => {
              const acl: unknown[] = [null];
              const present = Buffer.alloc(4);
              if (
                !descriptorDacl(descriptor[0], present, acl, Buffer.alloc(4)) ||
                !present.readUInt32LE() ||
                !acl[0]
              )
                throw failure("Installation descriptor DACL");
              const code = setSecurity(
                handle,
                1,
                0x80000004,
                null,
                null,
                acl[0],
                null,
              );
              if (code !== 0)
                throw failure("SetSecurityInfo(owned installation)", code);
              finalized = true;
              inspectHandle(
                handle,
                filename,
                directory,
                sid,
                true,
                publicBrowser,
              );
            },
            () => free(descriptor[0]),
          );
        },
        close() {
          if (!closed) {
            close(handle);
            closed = true;
          }
        },
      };
    },
    localAppData() {
      // FOLDERID_LocalAppData, GUID fields in native little-endian layout.
      const id = Buffer.from("8527b3f1ba6fcf4f9d557b8e7f157091", "hex");
      const result: unknown[] = [null];
      const hr = knownFolder(id, 0, 0, result);
      if (hr < 0) {
        if (result[0]) coFree(result[0]);
        refuse(`SHGetKnownFolderPath failed (HRESULT ${hr}).`);
      }
      if (!result[0]) refuse("KnownFolder returned no path.");
      return preserving(
        () => String(koffi.decode(result[0], "char16_t", -1)),
        () => coFree(result[0]),
      );
    },
    createDirectory(filename, sid) {
      withSecurity(sid, true, (attributes) => {
        if (!createDirectory(`\\\\?\\${filename}`, attributes))
          throw failure("CreateDirectoryW");
      });
    },
    createFile(filename, sid, bytes, destination) {
      withSecurity(sid, false, (attributes) => {
        const handle = open(filename, 0xc0030000, 0, attributes, 1, 0x80200000);
        preserving(
          () => {
            inspectHandle(handle, filename, false, sid);
            if (bytes.byteLength > 65536)
              refuse("Registry record exceeds 64 KiB.");
            if (bytes.byteLength) {
              const written = Buffer.alloc(4);
              if (!write(handle, bytes, bytes.byteLength, written, null))
                throw failure("WriteFile");
              if (written.readUInt32LE() !== bytes.byteLength)
                refuse("Incomplete registry write.");
            }
            if (!flush(handle))
              throw failure("FlushFileBuffers(before publication)");
            if (destination !== undefined) {
              const name = Buffer.from(destination, "utf16le");
              const record = Buffer.alloc(20 + name.byteLength + 2);
              record.writeUInt32LE(name.byteLength, 16);
              name.copy(record, 20);
              if (!setInfo(handle, 3, record, record.byteLength))
                throw failure("SetFileInformationByHandle(no replace)");
              if (!flush(handle))
                throw failure("FlushFileBuffers(after publication)");
              inspectHandle(handle, destination, false, sid);
            }
          },
          () => close(handle),
        );
      });
    },
    inspect(filename, directory, sid) {
      const handle = open(filename, 0x20080, 3, null, 3, 0x02200000);
      let identity: Identity;
      try {
        identity = inspectHandle(handle, filename, directory, sid);
      } catch (error) {
        return preserving(
          () => {
            throw error;
          },
          () => close(handle),
        );
      }
      let closed = false;
      return {
        handle,
        identity,
        close() {
          if (!closed) {
            close(handle);
            closed = true;
          }
        },
      };
    },
  };
}
