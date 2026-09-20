import { HostBoundaryError } from "./guards.js";

type Handle = number | bigint;
export interface OwnedJob {
  members(): number[];
  flags(): number;
  terminate(): void;
  close(): void;
}
export interface Jobs {
  create(name: string, profile?: "renderer" | "pat-dialog"): OwnedJob;
  joinCurrent(name: string, profile?: "renderer" | "pat-dialog"): void;
}
const FLAGS = 0x2008; // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS_LIMIT, never breakaway.
const MAX_PROCESSES = 64;
function processLimit(profile: "renderer" | "pat-dialog"): number {
  if (profile !== "renderer" && profile !== "pat-dialog")
    throw new HostBoundaryError("INVALID_INPUT", "Unknown owned Job profile.");
  return profile === "pat-dialog" ? 1 : MAX_PROCESSES;
}
let loaded: Promise<Jobs> | undefined;
export function loadJobs(): Promise<Jobs> {
  loaded ??= load().catch((cause: unknown) => {
    if (cause instanceof HostBoundaryError) throw cause;
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Pinned Job binding unavailable; no fallback.",
      true,
      { cause },
    );
  });
  return loaded;
}
async function load(): Promise<Jobs> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Renderer Jobs require verified Windows x64; arm64/macOS are unverified.",
      true,
    );
  const koffi = await import("koffi");
  const basic = koffi.struct({
    processTime: "int64_t",
    jobTime: "int64_t",
    flags: "uint32_t",
    minWorking: "uintptr_t",
    maxWorking: "uintptr_t",
    active: "uint32_t",
    affinity: "uintptr_t",
    priority: "uint32_t",
    scheduling: "uint32_t",
  });
  const extended = koffi.struct({
    basic,
    io: koffi.array("uint64_t", 6),
    processMemory: "uintptr_t",
    jobMemory: "uintptr_t",
    peakProcess: "uintptr_t",
    peakJob: "uintptr_t",
  });
  const list = koffi.struct({
    assigned: "uint32_t",
    count: "uint32_t",
    ids: koffi.array("uintptr_t", 1),
  });
  if (
    koffi.sizeof("void *") !== 8 ||
    koffi.sizeof(basic) !== 64 ||
    koffi.sizeof(extended) !== 144 ||
    koffi.alignof(extended) !== 8 ||
    basic.members?.flags?.offset !== 16 ||
    basic.members?.active?.offset !== 40 ||
    basic.members?.affinity?.offset !== 48 ||
    extended.members?.io?.offset !== 64 ||
    extended.members?.processMemory?.offset !== 112 ||
    extended.members?.peakJob?.offset !== 136 ||
    list.members?.ids?.offset !== 8
  )
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Unverified Job ABI layout.",
      true,
    );
  const library = koffi.load("kernel32.dll");
  const create: (security: null, name: string) => Handle = library.func(
    "uintptr_t __stdcall CreateJobObjectW(void *, const char16_t *)",
  );
  const open: (access: number, inherit: number, name: string) => Handle =
    library.func(
      "uintptr_t __stdcall OpenJobObjectW(uint32_t, int, const char16_t *)",
    );
  const lastError: () => number = library.func(
    "uint32_t __stdcall GetLastError()",
  );
  const set: (job: Handle, kind: number, info: Buffer, size: number) => number =
    library.func(
      "int __stdcall SetInformationJobObject(uintptr_t, int, void *, uint32_t)",
    );
  const query: (
    job: Handle,
    kind: number,
    info: Buffer,
    size: number,
    returned: null,
  ) => number = library.func(
    "int __stdcall QueryInformationJobObject(uintptr_t, int, _Out_ void *, uint32_t, void *)",
  );
  const assign: (job: Handle, process: Handle) => number = library.func(
    "int __stdcall AssignProcessToJobObject(uintptr_t, uintptr_t)",
  );
  const current: () => Handle = library.func(
    "uintptr_t __stdcall GetCurrentProcess()",
  );
  const isIn: (process: Handle, job: Handle, result: Buffer) => number =
    library.func(
      "int __stdcall IsProcessInJob(uintptr_t, uintptr_t, _Out_ void *)",
    );
  const terminate: (job: Handle, code: number) => number = library.func(
    "int __stdcall TerminateJobObject(uintptr_t, uint32_t)",
  );
  const close: (handle: Handle) => number = library.func(
    "int __stdcall CloseHandle(uintptr_t)",
  );
  const getHandle: (handle: Handle, flags: Buffer) => number = library.func(
    "int __stdcall GetHandleInformation(uintptr_t, _Out_ void *)",
  );
  const failure = (operation: string, code = lastError()) =>
    new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      `Windows Job ${operation} failed (Win32 ${code}).`,
      true,
    );
  const checkedClose = (handle: Handle) => {
    if (!close(handle)) throw failure("close");
  };
  const checkFlags = (handle: Handle, maximum: number): number => {
    const info = Buffer.alloc(144);
    if (!query(handle, 9, info, info.length, null))
      throw failure("limits query");
    if (info.readUInt32LE(16) !== FLAGS || info.readUInt32LE(40) !== maximum)
      throw new HostBoundaryError(
        "POLICY_FAILED",
        "Job containment flags do not match the fixed policy.",
      );
    return info.readUInt32LE(16);
  };
  const finish = (handle: Handle, primary: unknown): never => {
    try {
      checkedClose(handle);
    } catch (cleanup) {
      throw new HostBoundaryError(
        "INTERRUPTED",
        "Job initialization failed and its handle could not be closed.",
        false,
        { cause: new AggregateError([primary, cleanup]) },
      );
    }
    throw primary;
  };
  return {
    create(name, profile = "renderer") {
      const maximum = processLimit(profile);
      if (!/^Local\\design-studio-[0-9a-f-]{36}$/.test(name))
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid private Job name.",
        );
      const handle = create(null, name);
      const code = lastError();
      // CreateJobObject returns NULL, not INVALID_HANDLE_VALUE.
      if (handle === 0 || handle === 0n) throw failure("create", code);
      try {
        if (code === 183)
          throw new HostBoundaryError("CONFLICT", "Job name already exists.");
        const inheritance = Buffer.alloc(4);
        if (!getHandle(handle, inheritance)) throw failure("handle flags");
        if (inheritance.readUInt32LE(0) & 1)
          throw new HostBoundaryError(
            "POLICY_FAILED",
            "Controller Job handle must not be inherited.",
          );
        const info = Buffer.alloc(144);
        info.writeUInt32LE(FLAGS, 16);
        info.writeUInt32LE(maximum, 40);
        if (!set(handle, 9, info, info.length)) throw failure("configure");
        checkFlags(handle, maximum);
      } catch (error) {
        return finish(handle, error);
      }
      let closed = false;
      const ensureOpen = () => {
        if (closed)
          throw new HostBoundaryError("CONFLICT", "Job handle is closed.");
      };
      return {
        flags() {
          ensureOpen();
          return checkFlags(handle, maximum);
        },
        members() {
          ensureOpen();
          const info = Buffer.alloc(8 + maximum * 8);
          if (!query(handle, 3, info, info.length, null))
            throw failure("members query");
          const count = info.readUInt32LE(4);
          if (count > maximum || info.readUInt32LE(0) !== count)
            throw new HostBoundaryError(
              "INTERRUPTED",
              "Job member list is incomplete.",
            );
          return Array.from({ length: count }, (_, i) =>
            Number(info.readBigUInt64LE(8 + i * 8)),
          );
        },
        terminate() {
          ensureOpen();
          if (!terminate(handle, 1)) throw failure("terminate");
        },
        close() {
          if (closed) return;
          checkedClose(handle);
          closed = true;
        },
      };
    },
    joinCurrent(name, profile = "renderer") {
      const maximum = processLimit(profile);
      if (!/^Local\\design-studio-[0-9a-f-]{36}$/.test(name))
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid private Job name.",
        );
      const handle = open(0x5, 0, name); // ASSIGN_PROCESS | QUERY; no controller rights.
      if (handle === 0 || handle === 0n) throw failure("open for membership");
      try {
        checkFlags(handle, maximum);
        if (!assign(handle, current())) throw failure("self-join");
        const result = Buffer.alloc(4);
        if (!isIn(current(), handle, result))
          throw failure("verify membership");
        if (result.readUInt32LE(0) !== 1)
          throw new HostBoundaryError(
            "POLICY_FAILED",
            "Worker did not join the controller Job.",
          );
      } catch (error) {
        return finish(handle, error);
      }
      checkedClose(handle);
    },
  };
}
