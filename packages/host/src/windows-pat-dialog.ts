import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ErrorCode } from "@design-studio/contracts";
import { HostBoundaryError } from "./guards.js";
import { PatEditBoundary } from "./pat-edit.js";
import { PAT_CLIPBOARD_MAX_BYTES } from "./pat-input.js";

type Handle = number | bigint;
const nil = (value: Handle) => value === 0 || value === 0n;
const key = (value: Handle) => String(value);
const WM = {
  close: 0x10,
  command: 0x111,
  char: 0x102,
  keydown: 0x100,
  paste: 0x302,
  copy: 0x301,
  cut: 0x300,
  undo: 0x304,
  settext: 0x0c,
  nccreate: 0x81,
  ncdestroy: 0x82,
  imeStart: 0x10d,
  imeEnd: 0x10e,
  imeComposition: 0x10f,
  imeChar: 0x286,
  unichar: 0x109,
};
const EM = { getsel: 0xb0, replacesel: 0xc2, limit: 0xc5, emptyUndo: 0xcd };
const invalid = () =>
  new HostBoundaryError("INVALID_INPUT", "Native PAT input was rejected.");
const nativeFailure = () =>
  new HostBoundaryError(
    "INTERRUPTED",
    "Native PAT dialog ownership failed; sensitive details withheld.",
  );
export class NativePatDialogError extends HostBoundaryError {
  constructor(
    readonly primaryCode: ErrorCode,
    readonly cleanupComplete: boolean,
    readonly cleanupCause?:
      | "callback"
      | "subclass-removal"
      | "default-procedure"
      | "edit-clear"
      | "window-destroy"
      | "class-unregister"
      | "callback-unregister"
      | "clipboard",
  ) {
    super(
      cleanupComplete ? primaryCode : "INTERRUPTED",
      "Native PAT entry ended without an accepted credential.",
    );
  }
}

/** Fixed helper-only native entry. Importing this module never loads UI libraries or shows a window. */
export async function collectWindowsPat(
  signal: AbortSignal,
  deadline: number,
  onReady: () => void,
): Promise<Buffer> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "PAT dialog requires Windows x64.",
      true,
    );
  if (
    !Number.isFinite(deadline) ||
    deadline <= performance.now() ||
    deadline > performance.now() + 300_000
  )
    throw new HostBoundaryError("INVALID_INPUT", "Invalid PAT input deadline.");
  const koffi = await import("koffi");
  if (signal.aborted)
    throw new HostBoundaryError("CANCELLED", "PAT entry cancelled.");
  const user = koffi.load("user32.dll");
  const kernel = koffi.load("kernel32.dll");
  const controls = koffi.load("comctl32.dll");
  const getThread: () => number = kernel.func(
    "uint32_t __stdcall GetCurrentThreadId()",
  );
  const getModule: (name: null) => Handle = kernel.func(
    "uintptr_t __stdcall GetModuleHandleW(const char16_t *)",
  );
  const lastError: () => number = kernel.func(
    "uint32_t __stdcall GetLastError()",
  );
  const setLastError: (value: number) => void = kernel.func(
    "void __stdcall SetLastError(uint32_t)",
  );
  const globalSize: (handle: Handle) => number | bigint = kernel.func(
    "uintptr_t __stdcall GlobalSize(uintptr_t)",
  );
  const globalLock: (handle: Handle) => unknown = kernel.func(
    "void * __stdcall GlobalLock(uintptr_t)",
  );
  const globalUnlock: (handle: Handle) => number = kernel.func(
    "int __stdcall GlobalUnlock(uintptr_t)",
  );
  const wndproc = koffi.proto(
    "intptr_t __stdcall PatWndProc(uintptr_t, uint32_t, uintptr_t, intptr_t)",
  );
  const subclass = koffi.proto(
    "intptr_t __stdcall PatSubclass(uintptr_t, uint32_t, uintptr_t, intptr_t, uintptr_t, uintptr_t)",
  );
  const wndclass = koffi.struct({
    size: "uint32_t",
    style: "uint32_t",
    proc: koffi.pointer(wndproc),
    classExtra: "int32_t",
    windowExtra: "int32_t",
    instance: "uintptr_t",
    icon: "uintptr_t",
    cursor: "uintptr_t",
    background: "uintptr_t",
    menu: "const char16_t *",
    name: "const char16_t *",
    smallIcon: "uintptr_t",
  });
  const msg = koffi.struct({
    hwnd: "uintptr_t",
    message: "uint32_t",
    wparam: "uintptr_t",
    lparam: "intptr_t",
    time: "uint32_t",
    x: "int32_t",
    y: "int32_t",
    private: "uint32_t",
  });
  if (
    koffi.sizeof("void *") !== 8 ||
    koffi.sizeof(wndclass) !== 80 ||
    wndclass.members?.proc?.offset !== 8 ||
    wndclass.members?.instance?.offset !== 24 ||
    wndclass.members?.name?.offset !== 64 ||
    koffi.sizeof(msg) !== 48 ||
    msg.members?.wparam?.offset !== 16 ||
    msg.members?.lparam?.offset !== 24 ||
    msg.members?.x?.offset !== 36
  )
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Unverified PAT dialog ABI layout.",
      true,
    );
  const register: (value: object) => number = user.func(
    "__stdcall",
    "RegisterClassExW",
    "uint16_t",
    [koffi.pointer(wndclass)],
  );
  const unregister: (name: string, instance: Handle) => number = user.func(
    "int __stdcall UnregisterClassW(const char16_t *, uintptr_t)",
  );
  const create: (
    extended: number,
    klass: string,
    title: string,
    style: number,
    x: number,
    y: number,
    width: number,
    height: number,
    parent: Handle,
    id: Handle,
    instance: Handle,
    parameter: null,
  ) => Handle = user.func(
    "uintptr_t __stdcall CreateWindowExW(uint32_t, const char16_t *, const char16_t *, uint32_t, int32_t, int32_t, int32_t, int32_t, uintptr_t, uintptr_t, uintptr_t, void *)",
  );
  const defaultProc: (
    hwnd: Handle,
    message: number,
    wp: Handle,
    lp: Handle,
  ) => Handle = user.func(
    "intptr_t __stdcall DefWindowProcW(uintptr_t, uint32_t, uintptr_t, intptr_t)",
  );
  const defaultSubclass: (
    hwnd: Handle,
    message: number,
    wp: Handle,
    lp: Handle,
  ) => Handle = controls.func(
    "intptr_t __stdcall DefSubclassProc(uintptr_t, uint32_t, uintptr_t, intptr_t)",
  );
  const setSubclass: (
    hwnd: Handle,
    callback: bigint,
    id: number,
    data: number,
  ) => number = controls.func(
    "int __stdcall SetWindowSubclass(uintptr_t, PatSubclass *, uintptr_t, uintptr_t)",
  );
  const removeSubclass: (hwnd: Handle, callback: bigint, id: number) => number =
    controls.func(
      "int __stdcall RemoveWindowSubclass(uintptr_t, PatSubclass *, uintptr_t)",
    );
  const destroy: (hwnd: Handle) => number = user.func(
    "int __stdcall DestroyWindow(uintptr_t)",
  );
  const isWindow: (hwnd: Handle) => number = user.func(
    "int __stdcall IsWindow(uintptr_t)",
  );
  const visible: (hwnd: Handle) => number = user.func(
    "int __stdcall IsWindowVisible(uintptr_t)",
  );
  const show: (hwnd: Handle, mode: number) => number = user.func(
    "int __stdcall ShowWindow(uintptr_t, int32_t)",
  );
  const enable: (hwnd: Handle, value: number) => number = user.func(
    "int __stdcall EnableWindow(uintptr_t, int)",
  );
  const focus: (hwnd: Handle) => Handle = user.func(
    "uintptr_t __stdcall SetFocus(uintptr_t)",
  );
  const getKey: (key: number) => number = user.func(
    "int16_t __stdcall GetKeyState(int32_t)",
  );
  const textLength: (hwnd: Handle) => number = user.func(
    "int32_t __stdcall GetWindowTextLengthW(uintptr_t)",
  );
  const getText: (hwnd: Handle, buffer: Buffer, length: number) => number =
    user.func(
      "int32_t __stdcall GetWindowTextW(uintptr_t, _Out_ void *, int32_t)",
    );
  const setText: (hwnd: Handle, text: string) => number = user.func(
    "int __stdcall SetWindowTextW(uintptr_t, const char16_t *)",
  );
  const send: (
    hwnd: Handle,
    message: number,
    wp: Handle,
    lp: Handle,
  ) => Handle = user.func(
    "intptr_t __stdcall SendMessageW(uintptr_t, uint32_t, uintptr_t, intptr_t)",
  );
  const sendPointer: (
    hwnd: Handle,
    message: number,
    wp: Handle,
    pointer: Uint8Array | null,
  ) => Handle = user.func(
    "intptr_t __stdcall SendMessageW(uintptr_t, uint32_t, uintptr_t, void *)",
  );
  const peek: (
    buffer: Buffer,
    hwnd: Handle,
    minimum: number,
    maximum: number,
    flags: number,
  ) => number = user.func(
    "int __stdcall PeekMessageW(_Out_ void *, uintptr_t, uint32_t, uint32_t, uint32_t)",
  );
  const translate: (buffer: Buffer) => number = user.func(
    "int __stdcall TranslateMessage(const void *)",
  );
  const dispatch: (buffer: Buffer) => Handle = user.func(
    "intptr_t __stdcall DispatchMessageW(const void *)",
  );
  const dialogMessage: (hwnd: Handle, buffer: Buffer) => number = user.func(
    "int __stdcall IsDialogMessageW(uintptr_t, void *)",
  );
  const openClipboard: (hwnd: Handle) => number = user.func(
    "int __stdcall OpenClipboard(uintptr_t)",
  );
  const clipboardData: (format: number) => Handle = user.func(
    "uintptr_t __stdcall GetClipboardData(uint32_t)",
  );
  const closeClipboard: () => number = user.func(
    "int __stdcall CloseClipboard()",
  );
  const thread = getThread();
  const instance = getModule(null);
  const className = `DesignStudioFigmaPat_${randomUUID()}`;
  if (nil(instance)) throw nativeFailure();

  return new Promise<Buffer>((resolve, reject) => {
    let root: Handle = 0;
    let edit: Handle = 0;
    let status: Handle = 0;
    let accept: Handle = 0;
    let rootCallback: bigint | undefined;
    let childCallback: bigint | undefined;
    let registered = false;
    let callbackDepth = 0;
    let internalEdit = false;
    let readingInput = false;
    let closing = false;
    let ended = false;
    let accepted: Buffer | undefined;
    let primary: HostBoundaryError | undefined;
    let resourceFailure = false;
    let callbackFailure: HostBoundaryError | undefined;
    let cleanupCause: NativePatDialogError["cleanupCause"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let boundary: PatEditBoundary | undefined;
    const windows = new Map<string, { hwnd: Handle; id: number }>();
    const destroyed = new Set<string>();
    const subclassRemoved = new Set<string>();
    const destructionDefaultCompleted = new Set<string>();
    const message = Buffer.alloc(48);
    const buffers = new Set<Uint8Array>();
    const own = <T extends Uint8Array>(bytes: T): T => {
      buffers.add(bytes);
      return bytes;
    };
    const wipe = (bytes: Uint8Array) => {
      bytes.fill(0);
      buffers.delete(bytes);
    };
    const callbackFailed = (
      error: HostBoundaryError,
      cause: NonNullable<NativePatDialogError["cleanupCause"]>,
    ) => {
      callbackFailure ??= error;
      primary ??= error;
      cleanupCause ??= cause;
      accepted?.fill(0);
    };
    const validLifetime = () => {
      if (signal.aborted)
        throw new HostBoundaryError("CANCELLED", "PAT entry cancelled.");
      if (performance.now() >= deadline)
        throw new HostBoundaryError(
          "DEADLINE_EXCEEDED",
          "PAT entry deadline exceeded.",
        );
      if (getThread() !== thread) throw nativeFailure();
    };
    const mutate = (operation: () => void) => {
      if (internalEdit) throw nativeFailure();
      internalEdit = true;
      try {
        operation();
      } finally {
        internalEdit = false;
      }
    };
    const clear = () => {
      if (nil(edit) || !isWindow(edit)) return;
      mutate(() => {
        if (!setText(edit, "")) throw nativeFailure();
      });
      send(edit, EM.emptyUndo, 0, 0);
    };
    const teardown = () => {
      if (ended) return;
      if (callbackDepth !== 0) {
        setImmediate(teardown);
        return;
      }
      ended = true;
      if (timer) clearTimeout(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", abort);
      let failed = resourceFailure || callbackFailure !== undefined;
      if (resourceFailure) cleanupCause ??= "clipboard";
      try {
        clear();
      } catch {
        failed = true;
        cleanupCause ??= "edit-clear";
      }
      try {
        if (!nil(root) && isWindow(root)) {
          if (!destroy(root)) {
            failed = true;
            cleanupCause ??= "window-destroy";
          }
        }
      } catch {
        failed = true;
        cleanupCause ??= "window-destroy";
      }
      // Destruction invokes synchronous callbacks; inspect sticky failures after they unwind.
      failed ||= callbackFailure !== undefined;
      for (const { hwnd, id } of windows.values()) {
        try {
          if (
            isWindow(hwnd) ||
            !destroyed.has(key(hwnd)) ||
            !destructionDefaultCompleted.has(key(hwnd)) ||
            (id !== 0 && !subclassRemoved.has(key(hwnd)))
          ) {
            failed = true;
            cleanupCause ??= "window-destroy";
          }
        } catch {
          failed = true;
        }
      }
      for (const bytes of buffers) bytes.fill(0);
      buffers.clear();
      message.fill(0);
      if (!failed) {
        try {
          if (registered && !unregister(className, instance)) {
            cleanupCause ??= "class-unregister";
            throw nativeFailure();
          }
          if (childCallback !== undefined) koffi.unregister(childCallback);
          if (rootCallback !== undefined) koffi.unregister(rootCallback);
        } catch {
          failed = true;
          cleanupCause ??= "callback-unregister";
        }
      }
      failed ||= callbackFailure !== undefined;
      try {
        validLifetime();
      } catch (error) {
        primary ??=
          error instanceof HostBoundaryError ? error : nativeFailure();
      }
      if (failed || primary || !accepted) {
        accepted?.fill(0);
        reject(
          new NativePatDialogError(
            primary?.code ?? "INTERNAL_ERROR",
            !failed,
            cleanupCause,
          ),
        );
      } else resolve(accepted);
    };
    const finish = (error?: HostBoundaryError, bytes?: Buffer) => {
      if (closing) {
        if (error) {
          primary ??= error;
          accepted?.fill(0);
        }
        bytes?.fill(0);
        return;
      }
      closing = true;
      primary = error;
      accepted = bytes;
      try {
        if (!nil(accept) && isWindow(accept)) enable(accept, 0);
      } catch {
        primary ??= nativeFailure();
      }
      setImmediate(teardown);
    };
    const abort = () =>
      finish(new HostBoundaryError("CANCELLED", "PAT entry cancelled."));
    const submit = () => {
      if (closing) return;
      if (readingInput) throw nativeFailure();
      validLifetime();
      readingInput = true;
      try {
        const bytes = boundary?.submit();
        if (bytes) finish(undefined, bytes);
      } finally {
        readingInput = false;
      }
    };
    const paste = () => {
      if (closing || readingInput) throw nativeFailure();
      validLifetime();
      readingInput = true;
      try {
        boundary?.paste();
      } finally {
        readingInput = false;
      }
    };
    const safeCallback = (operation: () => Handle): Handle => {
      callbackDepth++;
      try {
        if (getThread() !== thread) throw nativeFailure();
        return operation();
      } catch (error) {
        const normalized =
          error instanceof HostBoundaryError ? error : nativeFailure();
        if (
          normalized.code !== "CANCELLED" &&
          normalized.code !== "DEADLINE_EXCEEDED"
        )
          callbackFailed(normalized, "callback");
        finish(normalized);
        return 0;
      } finally {
        callbackDepth--;
      }
    };
    try {
      validLifetime();
      rootCallback = koffi.register(
        (hwnd: Handle, code: number, wp: Handle, lp: Handle) =>
          safeCallback(() => {
            if (code === WM.nccreate) {
              if (!nil(root) && key(root) !== key(hwnd)) throw nativeFailure();
              root = hwnd;
              windows.set(key(hwnd), { hwnd, id: 0 });
            }
            if (code === WM.ncdestroy) destroyed.add(key(hwnd));
            if (code === WM.close) {
              abort();
              return 0;
            }
            if (code === WM.command && !closing) {
              const id = Number(wp) & 0xffff;
              if (id === 1 && key(lp) === key(accept)) {
                submit();
                return 0;
              }
              if (id === 2) {
                abort();
                return 0;
              }
              if (
                id === 11 &&
                Number(wp) >>> 16 === 0x300 &&
                key(lp) === key(edit)
              ) {
                send(edit, EM.emptyUndo, 0, 0);
                if (!nil(accept)) enable(accept, textLength(edit) > 0 ? 1 : 0);
              }
            }
            try {
              const result = defaultProc(hwnd, code, wp, lp);
              if (code === WM.ncdestroy)
                destructionDefaultCompleted.add(key(hwnd));
              return result;
            } catch {
              callbackFailed(nativeFailure(), "default-procedure");
              finish(nativeFailure());
              return 0;
            }
          }),
        koffi.pointer(wndproc),
      );
      childCallback = koffi.register(
        (hwnd: Handle, code: number, wp: Handle, lp: Handle, id: Handle) =>
          safeCallback(() => {
            if (code === WM.ncdestroy) {
              destroyed.add(key(hwnd));
              try {
                if (
                  childCallback === undefined ||
                  !removeSubclass(hwnd, childCallback, Number(id))
                )
                  callbackFailed(nativeFailure(), "subclass-removal");
                else subclassRemoved.add(key(hwnd));
              } catch {
                callbackFailed(nativeFailure(), "subclass-removal");
              }
              try {
                const result = defaultSubclass(hwnd, code, wp, lp);
                destructionDefaultCompleted.add(key(hwnd));
                return result;
              } catch {
                callbackFailed(nativeFailure(), "default-procedure");
                return 0;
              }
            }
            if (key(hwnd) === key(edit)) {
              if (
                closing &&
                (code === WM.paste ||
                  code === WM.char ||
                  code === WM.unichar ||
                  code === WM.keydown ||
                  code === WM.imeStart ||
                  code === WM.imeEnd ||
                  code === WM.imeComposition ||
                  code === WM.imeChar ||
                  ((code === WM.settext || code === EM.replacesel) &&
                    !internalEdit))
              )
                return 0;
              if (code === WM.paste) {
                paste();
                return 0;
              }
              if (code === WM.copy || code === WM.cut || code === WM.undo)
                return 0;
              if (code === 0x7b || code === 0xc7) return 0;
              if (code === WM.keydown) {
                const pressed = Number(wp);
                const ctrl = getKey(0x11) < 0;
                const shift = getKey(0x10) < 0;
                if ((pressed === 0x56 && ctrl) || (pressed === 0x2d && shift)) {
                  paste();
                  return 0;
                }
                if (
                  (ctrl &&
                    (pressed === 0x58 ||
                      pressed === 0x5a ||
                      pressed === 0x2d)) ||
                  (shift && pressed === 0x2e)
                )
                  return 0;
              }
              if (
                (code === WM.settext || code === EM.replacesel) &&
                !internalEdit
              )
                return 0;
              if (
                code === WM.imeStart ||
                code === WM.imeEnd ||
                code === WM.imeComposition ||
                code === WM.imeChar
              ) {
                clear();
                enable(accept, 0);
                return 0;
              }
              if (code === WM.char || code === WM.unichar) {
                const value = Number(wp);
                if (code === WM.unichar && value === 0xffff) return 1;
                if (value === 3 || value === 27) {
                  abort();
                  return 0;
                }
                if (value === 13) {
                  submit();
                  return 0;
                }
                if (value === 22) return 0;
                if (value === 24 || value === 26) return 0;
                if (value === 1) {
                  send(hwnd, 0xb1, 0, -1);
                  return 0;
                }
                if (value !== 8 && !boundary?.character(value)) return 0;
                const result = defaultSubclass(hwnd, code, wp, lp);
                send(hwnd, EM.emptyUndo, 0, 0);
                enable(accept, textLength(edit) > 0 ? 1 : 0);
                return result;
              }
              if (code === WM.keydown && Number(wp) === 27) {
                abort();
                return 0;
              }
            }
            return defaultSubclass(hwnd, code, wp, lp);
          }),
        koffi.pointer(subclass),
      );
      if (
        !register({
          size: 80,
          style: 0,
          proc: rootCallback,
          classExtra: 0,
          windowExtra: 0,
          instance,
          icon: 0,
          cursor: 0,
          background: 6,
          menu: null,
          name: className,
          smallIcon: 0,
        })
      )
        throw nativeFailure();
      registered = true;
      const window = create(
        0x10000,
        className,
        "Design Studio - Figma PAT",
        0x00c80000,
        -2147483648,
        0,
        560,
        230,
        0,
        0,
        instance,
        null,
      );
      if (nil(window) || key(window) !== key(root)) throw nativeFailure();
      const child = (
        klass: string,
        title: string,
        style: number,
        x: number,
        y: number,
        width: number,
        height: number,
        id: number,
      ) => {
        const hwnd = create(
          0,
          klass,
          title,
          0x50000000 | style,
          x,
          y,
          width,
          height,
          root,
          id,
          instance,
          null,
        );
        if (nil(hwnd)) throw nativeFailure();
        windows.set(key(hwnd), { hwnd, id });
        if (
          childCallback === undefined ||
          !setSubclass(hwnd, childCallback, id, 0)
        )
          throw nativeFailure();
        return hwnd;
      };
      child(
        "STATIC",
        "Enter a Figma personal access token, not your Windows password.",
        0,
        16,
        15,
        510,
        35,
        10,
      );
      edit = child("EDIT", "", 0x008100a0, 16, 55, 510, 26, 11);
      status = child(
        "STATIC",
        "Paste with Ctrl+V or Shift+Insert. No account sign-in or network request.",
        0,
        16,
        90,
        510,
        35,
        12,
      );
      accept = child("BUTTON", "Continue", 0x00010001, 326, 135, 95, 30, 1);
      child("BUTTON", "Cancel", 0x00010000, 431, 135, 95, 30, 2);
      send(edit, EM.limit, 4096, 0);
      enable(accept, 0);
      boundary = new PatEditBoundary({
        clipboard() {
          validLifetime();
          if (!openClipboard(root))
            throw new HostBoundaryError(
              "RESOURCE_UNRESOLVED",
              "Clipboard unavailable; paste again explicitly.",
            );
          let handle: Handle = 0;
          let locked = false;
          let copy: Buffer | undefined;
          let error: HostBoundaryError | undefined;
          try {
            handle = clipboardData(13);
            if (nil(handle)) throw invalid();
            const size = Number(globalSize(handle));
            if (
              !Number.isSafeInteger(size) ||
              size < 4 ||
              size > PAT_CLIPBOARD_MAX_BYTES ||
              size % 2
            )
              throw invalid();
            const pointer = globalLock(handle);
            if (!pointer) throw nativeFailure();
            locked = true;
            copy = own(Buffer.from(new Uint8Array(koffi.view(pointer, size))));
          } catch (failure) {
            error =
              failure instanceof HostBoundaryError ? failure : nativeFailure();
          } finally {
            if (locked) {
              try {
                setLastError(0);
                if (!globalUnlock(handle) && lastError() !== 0)
                  resourceFailure = true;
              } catch {
                resourceFailure = true;
              }
            }
            try {
              if (!closeClipboard()) resourceFailure = true;
            } catch {
              resourceFailure = true;
            }
            if (resourceFailure) error = nativeFailure();
          }
          if (error || !copy) {
            if (copy) wipe(copy);
            throw error ?? nativeFailure();
          }
          try {
            validLifetime();
            if (closing) throw nativeFailure();
          } catch (error) {
            wipe(copy);
            throw error;
          }
          buffers.delete(copy);
          return copy;
        },
        length: () => textLength(edit),
        selection() {
          const start = Buffer.alloc(4);
          const end = Buffer.alloc(4);
          try {
            sendPointer(edit, EM.getsel, koffi.address(start), end);
            return { start: start.readUInt32LE(), end: end.readUInt32LE() };
          } finally {
            start.fill(0);
            end.fill(0);
          }
        },
        insert(bytes) {
          validLifetime();
          if (closing) throw nativeFailure();
          mutate(() => {
            sendPointer(edit, EM.replacesel, 0, bytes);
          });
          send(edit, EM.emptyUndo, 0, 0);
        },
        read() {
          const count = textLength(edit);
          if (count < 1 || count > 4096) throw invalid();
          const bytes = own(Buffer.alloc((count + 1) * 2));
          if (getText(edit, bytes, count + 1) !== count) {
            wipe(bytes);
            throw invalid();
          }
          try {
            validLifetime();
            if (closing) throw nativeFailure();
          } catch (error) {
            wipe(bytes);
            throw error;
          }
          buffers.delete(bytes);
          return bytes;
        },
        clear,
        changed(value) {
          enable(accept, value ? 1 : 0);
          if (
            !setText(
              status,
              "Ready when you are. No network request is made here.",
            )
          )
            throw nativeFailure();
        },
        rejected() {
          if (
            !setText(
              status,
              "Input rejected. Paste one complete PAT (1-4096 printable ASCII characters).",
            )
          )
            throw nativeFailure();
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      deadlineTimer = setTimeout(
        () =>
          finish(
            new HostBoundaryError(
              "DEADLINE_EXCEEDED",
              "PAT entry deadline exceeded.",
            ),
          ),
        Math.max(1, deadline - performance.now()),
      );
      validLifetime();
      // Consume the helper's inherited STARTF_USESHOWWINDOW/SW_HIDE first.
      // The subsequent SW_SHOWNORMAL explicitly displays only our owned root.
      show(root, 10);
      validLifetime();
      if (closing || !isWindow(root)) throw nativeFailure();
      show(root, 1);
      if (!isWindow(root) || !visible(root)) throw nativeFailure();
      focus(edit);
      onReady();
      const pump = () => {
        if (closing) return;
        try {
          validLifetime();
          for (
            let count = 0;
            count < 128 && !closing && peek(message, 0, 0, 0, 1);
            count++
          ) {
            if (message.readUInt32LE(8) === 0x12) {
              abort();
              break;
            }
            if (
              message.readUInt32LE(8) === WM.keydown &&
              Number(message.readBigUInt64LE(16)) === 0x43 &&
              getKey(0x11) < 0
            ) {
              abort();
              break;
            }
            if (!dialogMessage(root, message)) {
              translate(message);
              dispatch(message);
            }
          }
          if (!closing) timer = setTimeout(pump, 16);
        } catch (error) {
          finish(error instanceof HostBoundaryError ? error : nativeFailure());
        }
      };
      pump();
    } catch (error) {
      finish(error instanceof HostBoundaryError ? error : nativeFailure());
    }
  });
}
