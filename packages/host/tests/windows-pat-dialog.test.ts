import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { PatEditBoundary } from "../src/pat-edit.js";
import {
  collectWindowsPat,
  NativePatDialogError,
} from "../src/windows-pat-dialog.js";

type H = number | bigint;
type Callback = (...args: H[]) => unknown;
interface Window {
  id: number;
  klass: string;
  text: Buffer;
  callback?: bigint;
  visible: boolean;
  selection: number;
}
const state = vi.hoisted((): { current?: FakeWin32 } => ({}));
vi.mock("koffi", () => ({
  load: vi.fn(() => ({
    func: (...args: unknown[]) => {
      const declaration =
        args.length === 1
          ? String(args[0]).match(/(\w+)\s*\(/)?.[1]
          : String(args[1]);
      return (...parameters: unknown[]) => {
        if (!state.current || !declaration)
          throw new Error("Synthetic binding absent");
        return state.current.call(declaration, parameters);
      };
    },
  })),
  struct: (fields: object) =>
    "proc" in fields
      ? {
          size: 80,
          name: "FakeWindowClass",
          members: {
            proc: { offset: 8 },
            instance: { offset: 24 },
            name: { offset: 64 },
          },
        }
      : {
          size: 48,
          name: "FakeMessage",
          members: {
            wparam: { offset: 16 },
            lparam: { offset: 24 },
            x: { offset: 36 },
          },
        },
  sizeof: (value: unknown) =>
    typeof value === "string" ? 8 : (value as { size: number }).size,
  proto: (value: string) => value,
  pointer: (value: unknown) => value,
  register: (callback: Callback) => {
    if (!state.current) throw new Error("Synthetic binding absent");
    const id = BigInt(++state.current.next);
    state.current.callbacks.set(id, callback);
    return id;
  },
  unregister: (id: bigint) => {
    if (!state.current || state.current.windows.size)
      throw new Error("Callback released before HWND destruction");
    if (state.current.failUnregisterCallback)
      throw new Error("private unregister failure");
    state.current.callbacks.delete(id);
  },
  address: (bytes: Buffer) => {
    if (!state.current) throw new Error("Synthetic binding absent");
    const id = BigInt(++state.current.next);
    state.current.pointers.set(id, bytes);
    return id;
  },
  view: (pointer: unknown, size: number) => {
    if (!Buffer.isBuffer(pointer) || size > pointer.length)
      throw new Error("Synthetic pointer bound");
    return pointer.buffer.slice(pointer.byteOffset, pointer.byteOffset + size);
  },
}));

const h = (value: unknown): bigint => {
  if (typeof value !== "number" && typeof value !== "bigint")
    throw new Error("Synthetic handle");
  return BigInt(value);
};
const b = (value: unknown): Buffer => {
  if (!Buffer.isBuffer(value)) throw new Error("Synthetic buffer");
  return value;
};
class FakeWin32 {
  next = 100;
  callbacks = new Map<bigint, Callback>();
  pointers = new Map<bigint, Buffer>();
  windows = new Map<bigint, Window>();
  calls: string[] = [];
  clipboard = Buffer.from("synthetic-native\0", "utf16le");
  rootCallback = 0n;
  root = 0n;
  queue: { target: bigint; code: number; wp: bigint; lp: bigint }[] = [];
  clipboardReads = 0;
  clipboardCloses = 0;
  failUnlock = false;
  failDestroy = false;
  failSubclass = false;
  failRemoval = false;
  failRemovalId?: number;
  failDefaultChild?: number;
  failDefaultRoot = false;
  failUnregisterClass = false;
  failUnregisterCallback = false;
  failCallback = false;
  inDestruction = false;
  reentrantClose = false;
  reentrantPaste = false;
  onClipboard?: () => void;
  accepted = false;
  script: "accept" | "reject" | "cancel" | "ctrl-v" | "shift-insert" = "accept";
  id(id: number) {
    const found = [...this.windows].find(([, value]) => value.id === id);
    if (!found) throw new Error("Synthetic control absent");
    return found[0];
  }
  invoke(hwnd: bigint, code: number, wp: bigint = 0n, lp: bigint = 0n) {
    const window = this.windows.get(hwnd);
    const callback =
      window?.callback ?? (hwnd === this.root ? this.rootCallback : undefined);
    if (callback === undefined) return 0;
    const previous = this.inDestruction;
    this.inDestruction = code === 0x82;
    try {
      return (
        this.callbacks.get(callback)?.(
          hwnd,
          code,
          wp,
          lp,
          BigInt(window?.id ?? 0),
          0n,
        ) ?? 0
      );
    } finally {
      this.inDestruction = previous;
    }
  }
  call(name: string, args: unknown[]): unknown {
    this.calls.push(name);
    const hwnd =
      typeof args[0] === "bigint" || typeof args[0] === "number"
        ? h(args[0])
        : 0n;
    const window = this.windows.get(hwnd);
    switch (name) {
      case "GetCurrentThreadId":
        if (this.inDestruction && this.failCallback)
          throw new Error("private callback failure");
        return 7;
      case "GetModuleHandleW":
        return 1n;
      case "GetLastError":
        return 0;
      case "SetLastError":
        return undefined;
      case "RegisterClassExW": {
        const value = args[0];
        if (!value || typeof value !== "object" || !("proc" in value))
          throw new Error("Synthetic class");
        this.rootCallback = h(value.proc);
        return 1;
      }
      case "CreateWindowExW": {
        const id = Number(args[9]);
        const klass = String(args[1]);
        if (klass === "EDIT") {
          expect(Number(args[3]) & 0x20).toBe(0x20);
          expect(Number(args[3]) & 0x4).toBe(0);
        }
        const handle = BigInt(++this.next);
        this.windows.set(handle, {
          id,
          klass,
          text: Buffer.from(String(args[2]), "utf16le"),
          visible: false,
          selection: 0,
        });
        if (!h(args[8])) {
          this.root = handle;
          this.invoke(handle, 0x81);
        }
        return handle;
      }
      case "SetWindowSubclass":
        if (this.failSubclass) return 0;
        if (!window) throw new Error("Synthetic control absent");
        window.callback = h(args[1]);
        return 1;
      case "RemoveWindowSubclass":
        return this.failRemoval || this.failRemovalId === window?.id ? 0 : 1;
      case "UnregisterClassW":
        return this.failUnregisterClass ? 0 : 1;
      case "DefWindowProcW":
        if (Number(args[1]) === 0x82 && this.failDefaultRoot)
          throw new Error("private default failure");
        return 1;
      case "IsWindow":
        return window ? 1 : 0;
      case "IsWindowVisible":
        return window?.visible ? 1 : 0;
      case "ShowWindow": {
        if (!window) throw new Error("Synthetic control absent");
        window.visible = true;
        if (this.script === "cancel")
          this.queue.push({ target: this.root, code: 0x10, wp: 0n, lp: 0n });
        else {
          if (this.script === "ctrl-v" || this.script === "shift-insert") {
            this.queue.push({
              target: this.id(11),
              code: 0x100,
              wp: this.script === "ctrl-v" ? 0x56n : 0x2dn,
              lp: 0n,
            });
            if (this.script === "ctrl-v")
              this.queue.push({
                target: this.id(11),
                code: 0x102,
                wp: 22n,
                lp: 0n,
              });
          } else
            this.queue.push({
              target: this.id(11),
              code: 0x302,
              wp: 0n,
              lp: 0n,
            });
          this.queue.push(
            this.script !== "reject"
              ? { target: this.root, code: 0x111, wp: 1n, lp: this.id(1) }
              : { target: this.root, code: 0x10, wp: 0n, lp: 0n },
          );
        }
        return 0;
      }
      case "EnableWindow":
        return 1;
      case "SetFocus":
        return 0n;
      case "GetKeyState":
        return (this.script === "ctrl-v" && Number(args[0]) === 0x11) ||
          (this.script === "shift-insert" && Number(args[0]) === 0x10)
          ? -32768
          : 0;
      case "GetWindowTextLengthW":
        return window?.text.length ? window.text.length / 2 : 0;
      case "GetWindowTextW": {
        if (!window) throw new Error("Synthetic control absent");
        window.text.copy(b(args[1]));
        return window.text.length / 2;
      }
      case "SetWindowTextW":
        if (!window) return 0;
        window.text.fill(0);
        window.text = Buffer.from(String(args[1]), "utf16le");
        window.selection = window.text.length / 2;
        return 1;
      case "SendMessageW": {
        if (!window) throw new Error("Synthetic control absent");
        const code = Number(args[1]);
        if (code === 0xb0) {
          this.pointers.get(h(args[2]))?.writeUInt32LE(window.selection);
          b(args[3]).writeUInt32LE(window.selection);
        } else if (code === 0xc2) {
          const input = b(args[3]);
          window.text = Buffer.from(input.subarray(0, input.length - 2));
          window.selection = window.text.length / 2;
          this.accepted = true;
        }
        return 0;
      }
      case "DefSubclassProc":
        if (Number(args[1]) === 0x82 && this.failDefaultChild === window?.id)
          throw new Error("private default failure");
        return 0;
      case "OpenClipboard":
        return 1;
      case "GetClipboardData":
        this.clipboardReads++;
        this.onClipboard?.();
        if (this.reentrantPaste) this.invoke(this.id(11), 0x302);
        return 900n;
      case "GlobalSize":
        return this.clipboard.length;
      case "GlobalLock":
        return this.clipboard;
      case "GlobalUnlock":
        if (this.failUnlock) throw new Error("Synthetic unlock fault");
        return 1;
      case "CloseClipboard":
        this.clipboardCloses++;
        return 1;
      case "PeekMessageW": {
        const next = this.queue.shift();
        if (!next) return 0;
        const bytes = b(args[0]);
        bytes.fill(0);
        bytes.writeBigUInt64LE(next.target);
        bytes.writeUInt32LE(next.code, 8);
        bytes.writeBigUInt64LE(next.wp, 16);
        bytes.writeBigInt64LE(next.lp, 24);
        return 1;
      }
      case "IsDialogMessageW":
        return 0;
      case "TranslateMessage":
        return 1;
      case "DispatchMessageW": {
        const bytes = b(args[0]);
        return this.invoke(
          bytes.readBigUInt64LE(),
          bytes.readUInt32LE(8),
          bytes.readBigUInt64LE(16),
          bytes.readBigInt64LE(24),
        );
      }
      case "DestroyWindow":
        if (this.failDestroy) return 0;
        if (this.reentrantClose) this.invoke(this.root, 0x10);
        for (const [handle, value] of [...this.windows]) {
          if (handle === this.root) continue;
          this.invoke(handle, 0x82);
          value.text.fill(0);
          this.windows.delete(handle);
        }
        this.invoke(this.root, 0x82);
        this.windows.get(this.root)?.text.fill(0);
        this.windows.delete(this.root);
        return 1;
      default:
        throw new Error(`Unimplemented synthetic native API ${name}`);
    }
  }
}
const windows = it.skipIf(
  process.platform !== "win32" || process.arch !== "x64",
);
windows(
  "synthetic subclass removal failures after acceptance never return the accepted PAT",
  async () => {
    const native = new FakeWin32();
    native.failRemoval = true;
    await expect(synthetic(native)).rejects.toMatchObject({
      cleanupComplete: false,
    });
  },
);
async function synthetic(
  script: FakeWin32,
  signal = new AbortController().signal,
) {
  state.current = script;
  const koffi = await import("koffi");
  // Safety gate: never execute these tests against a real native/UI binding.
  expect(vi.isMockFunction(koffi.load)).toBe(true);
  return collectWindowsPat(signal, performance.now() + 5000, () => {});
}
windows(
  "synthetic Win32 adapter accepts complete input only after every owned HWND and callback closes",
  async () => {
    const native = new FakeWin32();
    const originalClipboard = Buffer.from(native.clipboard);
    const bytes = await synthetic(native);
    expect(bytes.toString()).toBe("synthetic-native");
    bytes.fill(0);
    expect(native.windows.size).toBe(0);
    expect(native.callbacks.size).toBe(0);
    expect(native.clipboardReads).toBe(1);
    expect(native.clipboardCloses).toBe(1);
    expect(native.clipboard).toEqual(originalClipboard);
    native.clipboard.fill(0);
    originalClipboard.fill(0);
  },
);
windows(
  "synthetic multiline paste is rejected before edit insertion; clipboard is never read on open/cancel",
  async () => {
    const invalid = new FakeWin32();
    invalid.script = "reject";
    invalid.clipboard = Buffer.from("first\r\nsecond\0", "utf16le");
    await expect(synthetic(invalid)).rejects.toMatchObject({
      primaryCode: "CANCELLED",
      cleanupComplete: true,
    });
    expect(invalid.accepted).toBe(false);
    expect(invalid.callbacks.size).toBe(0);
    const cancelled = new FakeWin32();
    cancelled.script = "cancel";
    await expect(synthetic(cancelled)).rejects.toMatchObject({
      primaryCode: "CANCELLED",
      cleanupComplete: true,
    });
    expect(cancelled.clipboardReads).toBe(0);
  },
);
windows(
  "synthetic clipboard/window cleanup faults never claim scrub-confirmed success",
  async () => {
    for (const fault of [
      "failUnlock",
      "failDestroy",
      "failSubclass",
    ] as const) {
      const native = new FakeWin32();
      native[fault] = true;
      const result = synthetic(native);
      await expect(result).rejects.toBeInstanceOf(NativePatDialogError);
      await expect(result).rejects.toMatchObject({ cleanupComplete: false });
      expect(native.calls).not.toContain("CredUIPromptForWindowsCredentialsW");
      if (fault === "failUnlock") expect(native.clipboardCloses).toBe(1);
    }
  },
);

windows(
  "synthetic reentrant paste/cancel finishes original clipboard cleanup before window release",
  async () => {
    const reentrant = new FakeWin32();
    reentrant.reentrantPaste = true;
    await expect(synthetic(reentrant)).rejects.toMatchObject({
      primaryCode: "INTERRUPTED",
    });
    expect(reentrant.accepted).toBe(false);
    expect(reentrant.clipboardCloses).toBe(1);
    expect(reentrant.windows.size).toBe(0);
    const cancelled = new FakeWin32();
    const abort = new AbortController();
    cancelled.onClipboard = () => abort.abort();
    await expect(synthetic(cancelled, abort.signal)).rejects.toMatchObject({
      primaryCode: "CANCELLED",
      cleanupComplete: true,
    });
    expect(cancelled.accepted).toBe(false);
    expect(cancelled.clipboardCloses).toBe(1);
  },
);

windows(
  "synthetic keyboard paste gestures are validated once, not repeated by translated WM_CHAR",
  async () => {
    for (const script of ["ctrl-v", "shift-insert"] as const) {
      const native = new FakeWin32();
      native.script = script;
      const bytes = await synthetic(native);
      expect(bytes.toString()).toBe("synthetic-native");
      expect(native.clipboardReads).toBe(1);
      bytes.fill(0);
      native.clipboard.fill(0);
    }
  },
);

for (const kind of ["removal", "child-default"] as const)
  for (const id of [10, 11, 12, 1, 2])
    windows(
      `synthetic accepted bytes are zeroed when ${kind} fails on control ${id}`,
      async () => {
        const native = new FakeWin32();
        if (kind === "removal") native.failRemovalId = id;
        else native.failDefaultChild = id;
        const buffers: Buffer[] = [];
        const original = PatEditBoundary.prototype.submit;
        const submit = vi
          .spyOn(PatEditBoundary.prototype, "submit")
          .mockImplementation(function (this: PatEditBoundary) {
            const bytes = original.call(this);
            if (bytes) buffers.push(bytes);
            return bytes;
          });
        try {
          await expect(synthetic(native)).rejects.toMatchObject({
            cleanupComplete: false,
            cleanupCause:
              kind === "removal" ? "subclass-removal" : "default-procedure",
          });
          expect(buffers).toHaveLength(1);
          expect(buffers[0]?.every((byte) => byte === 0)).toBe(true);
        } finally {
          submit.mockRestore();
          for (const bytes of buffers) bytes.fill(0);
        }
      },
    );

for (const fault of [
  "failDefaultRoot",
  "failUnregisterClass",
  "failUnregisterCallback",
  "failCallback",
] as const)
  windows(
    `synthetic teardown ${fault} is sticky after acceptance`,
    async () => {
      const native = new FakeWin32();
      native[fault] = true;
      const buffers: Buffer[] = [];
      const original = PatEditBoundary.prototype.submit;
      const submit = vi
        .spyOn(PatEditBoundary.prototype, "submit")
        .mockImplementation(function (this: PatEditBoundary) {
          const bytes = original.call(this);
          if (bytes) buffers.push(bytes);
          return bytes;
        });
      try {
        const error: unknown = await synthetic(native).catch(
          (value: unknown) => value,
        );
        expect(error).toBeInstanceOf(NativePatDialogError);
        expect(error).toMatchObject({
          cleanupComplete: false,
          cleanupCause: expect.any(String),
        });
        expect(JSON.stringify(error)).not.toContain("private");
        expect(buffers).toHaveLength(1);
        expect(buffers[0]?.every((byte) => byte === 0)).toBe(true);
      } finally {
        submit.mockRestore();
        for (const bytes of buffers) bytes.fill(0);
      }
    },
  );

windows(
  "synthetic reentrant close preserves cancellation plus teardown cause after acceptance",
  async () => {
    const native = new FakeWin32();
    native.reentrantClose = true;
    native.failRemovalId = 11;
    await expect(synthetic(native)).rejects.toMatchObject({
      primaryCode: "CANCELLED",
      cleanupComplete: false,
      cleanupCause: "subclass-removal",
    });
  },
);
