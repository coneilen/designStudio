import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type Handle,
  type Identity,
  loadNative,
  type ReadLease,
} from "../src/native.js";

// Test-only owner preparation, not an admission/repair API. Registration requires
// an empty generated root; only declared, initially absent artifact/output trees
// can be prepared. No caller SID, privileges, token changes or DACL writes.
export async function createRetainedOwnerFixture(root: string) {
  const initial = await lstat(root);
  if (
    !path.basename(root).startsWith("ds-ph-") ||
    !initial.isDirectory() ||
    initial.isSymbolicLink() ||
    (await realpath(root)).toLowerCase() !== root.toLowerCase() ||
    (await readdir(root)).length
  )
    throw new Error("Owner fixture requires an empty generated ordinary root.");
  const native = await loadNative();
  const sid = native.principal();
  const registration = native.pinRead(root, true);
  let rootIdentity: Identity;
  try {
    const current = await lstat(root);
    if (
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      (await readdir(root)).length
    )
      throw new Error(
        "Synthetic owner fixture root changed during registration.",
      );
    rootIdentity = { ...registration.identity };
  } finally {
    registration.close();
  }
  const koffi = await import("koffi");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const getSecurity: (
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
  const control: (
    descriptor: unknown,
    bits: Buffer,
    revision: Buffer,
  ) => number = advapi.func(
    "int __stdcall GetSecurityDescriptorControl(void *, _Out_ void *, _Out_ void *)",
  );
  const sidString: (sid: unknown, text: unknown[]) => number = advapi.func(
    "int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)",
  );
  const sidPointer: (sid: string, pointer: unknown[]) => number = advapi.func(
    "int __stdcall ConvertStringSidToSidW(const char16_t *, _Out_ void **)",
  );
  const setOwner: (
    handle: Handle,
    kind: number,
    flags: number,
    owner: unknown,
    group: null,
    dacl: null,
    sacl: null,
  ) => number = advapi.func(
    "uint32_t __stdcall SetSecurityInfo(uintptr_t, int, uint32_t, void *, void *, void *, void *)",
  );
  const open: (
    filename: string,
    access: number,
    share: number,
    attributes: null,
    disposition: number,
    flags: number,
    template: number,
  ) => Handle = kernel.func(
    "uintptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, uintptr_t)",
  );
  const info: (handle: Handle, bytes: Buffer) => number = kernel.func(
    "int __stdcall GetFileInformationByHandle(uintptr_t, _Out_ void *)",
  );
  const closeHandle: (handle: Handle) => number = kernel.func(
    "int __stdcall CloseHandle(uintptr_t)",
  );
  const free: (pointer: unknown) => unknown = kernel.func(
    "void * __stdcall LocalFree(void *)",
  );
  const release = (pointer: unknown) => {
    if (free(pointer) !== null)
      throw new Error("Synthetic native descriptor release failed.");
  };
  const security = (handle: Handle) => {
    const owner: unknown[] = [null];
    const dacl: unknown[] = [null];
    const descriptor: unknown[] = [null];
    const code = getSecurity(handle, 1, 5, owner, null, dacl, null, descriptor);
    if (code) throw new Error(`Synthetic GetSecurityInfo failed (${code}).`);
    try {
      const bits = Buffer.alloc(2);
      if (!control(descriptor[0], bits, Buffer.alloc(4)) || !dacl[0])
        throw new Error(
          "Synthetic owner fixture requires a valid non-null DACL.",
        );
      const text: unknown[] = [null];
      if (!sidString(owner[0], text))
        throw new Error("Synthetic owner query failed.");
      let actualOwner: string;
      try {
        actualOwner = String(koffi.decode(text[0], "char16_t", -1));
      } finally {
        release(text[0]);
      }
      const header = Buffer.from(koffi.decode(dacl[0], "uint8_t", 8));
      const size = header.readUInt16LE(2);
      if (size < 8 || size > 65535)
        throw new Error("Synthetic DACL exceeds bound.");
      return {
        owner: actualOwner,
        control: bits.readUInt16LE(),
        dacl: Buffer.from(koffi.decode(dacl[0], "uint8_t", size)).toString(
          "hex",
        ),
      };
    } finally {
      release(descriptor[0]);
    }
  };
  type Observation = ReturnType<typeof security> & {
    relative: string;
    directory: boolean;
    identity: Identity;
    size: number;
    sha256?: string;
  };
  const trees = new Set<string>();
  const observed = new Map<string, Identity>();
  let closed = false;
  let active = false;
  let poisoned = false;
  const retainedPins = new Set<ReadLease>();
  const retainedHandles = new Set<Handle>();
  const checkRoot = async () => {
    if (closed || poisoned || native.principal() !== sid)
      throw new Error(
        "Synthetic owner fixture is closed or principal changed.",
      );
    const current = await lstat(root);
    if (
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (await realpath(root)).toLowerCase() !== root.toLowerCase()
    )
      throw new Error("Synthetic owner fixture root identity changed.");
  };
  const digest = (pin: ReadLease) => {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const count = pin.read(buffer);
      if (!count) break;
      total += count;
      if (total > 26214400)
        throw new Error("Synthetic owner fixture file exceeds bound.");
      hash.update(buffer.subarray(0, count));
    }
    if (total !== pin.byteLength)
      throw new Error("Synthetic owner fixture content length changed.");
    return hash.digest("hex");
  };
  const prepareOwner = (entry: Observation, pin: ReadLease) => {
    const handle = open(
      `\\\\?\\${pin.identity.path}`,
      0xa0080,
      1,
      null,
      3,
      0x02200000,
      0,
    );
    if (handle === -1 || handle === -1n || handle === 0xffffffffffffffffn)
      throw new Error(
        "Synthetic owner-only handle admission failed; no privilege adjustment.",
      );
    retainedHandles.add(handle);
    const errors: unknown[] = [];
    try {
      const bytes = Buffer.alloc(52);
      if (
        !info(handle, bytes) ||
        bytes.readUInt32LE() & 0x400 ||
        Boolean(bytes.readUInt32LE() & 0x10) !== entry.directory ||
        (!entry.directory && bytes.readUInt32LE(40) !== 1) ||
        bytes.readUInt32LE(28) !== entry.identity.volume ||
        bytes.subarray(44, 52).toString("hex") !== entry.identity.file
      )
        throw new Error("Synthetic owner-only handle identity changed.");
      const pointer: unknown[] = [null];
      if (!sidPointer(sid, pointer))
        throw new Error("Synthetic current-owner SID conversion failed.");
      try {
        const code = setOwner(handle, 1, 1, pointer[0], null, null, null);
        if (code)
          throw new Error(
            `Synthetic owner-only assignment failed (${code}); no privilege adjustment.`,
          );
      } finally {
        release(pointer[0]);
      }
      const after = security(handle);
      if (
        after.owner !== sid ||
        after.control !== entry.control ||
        after.dacl !== entry.dacl
      )
        throw new Error(
          "Synthetic owner preparation changed DACL/control or failed owner assignment.",
        );
    } catch (error) {
      errors.push(error);
    }
    if (!closeHandle(handle))
      errors.push(new Error("Synthetic owner-only handle release failed."));
    else retainedHandles.delete(handle);
    if (errors.length)
      throw new AggregateError(
        errors,
        "Synthetic owner preparation or cleanup failed.",
      );
  };
  const scan = async (prepare: boolean) => {
    if (active)
      throw new Error("Synthetic owner fixture already has active work.");
    active = true;
    const pins: ReadLease[] = [];
    const result: Observation[] = [];
    const inventory = new Map<string, string[]>();
    let count = 0;
    const visit = async (relative: string, depth: number) => {
      if (++count > 2000 || depth > 3)
        throw new Error("Synthetic owner fixture inventory exceeds bound.");
      const filename = path.join(root, ...relative.split("/"));
      const stat = await lstat(filename);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      )
        throw new Error(
          "Synthetic owner fixture rejects reparse or linked entries.",
        );
      const pin = native.pinRead(filename, stat.isDirectory());
      pins.push(pin);
      retainedPins.add(pin);
      const prior = observed.get(relative);
      if (
        prior &&
        (prior.file !== pin.identity.file ||
          prior.volume !== pin.identity.volume)
      )
        throw new Error("Synthetic owner fixture entry identity changed.");
      observed.set(relative, { ...pin.identity });
      result.push({
        relative,
        directory: stat.isDirectory(),
        identity: { ...pin.identity },
        size: pin.byteLength,
        ...security(pin.handle),
        ...(!stat.isDirectory() ? { sha256: digest(pin) } : {}),
      });
      if (stat.isDirectory()) {
        const names = (await readdir(filename)).sort();
        inventory.set(filename, names);
        for (const name of names) {
          if (
            !/^[A-Za-z0-9_.-]{1,120}$/.test(name) ||
            name === "." ||
            name === ".." ||
            /[. ]$/.test(name)
          )
            throw new Error("Synthetic owner fixture rejects aliased names.");
          await visit(`${relative}/${name}`, depth + 1);
        }
      }
    };
    let failure: unknown;
    try {
      await checkRoot();
      const rootPin = native.pinRead(root, true);
      pins.push(rootPin);
      retainedPins.add(rootPin);
      if (
        rootPin.identity.file !== rootIdentity.file ||
        rootPin.identity.volume !== rootIdentity.volume
      )
        throw new Error(
          "Synthetic owner fixture native root identity changed.",
        );
      for (const tree of trees) await visit(tree, 1);
      if (prepare) {
        for (const [index, entry] of result.entries()) {
          const pin = pins[index + 1];
          if (!pin) throw new Error("Synthetic owner fixture lost entry pin.");
          if (entry.owner !== sid) prepareOwner(entry, pin);
        }
      }
      await checkRoot();
      for (const [filename, names] of inventory)
        if (
          JSON.stringify(
            await readdir(filename).then((items) => items.sort()),
          ) !== JSON.stringify(names)
        )
          throw new Error("Synthetic owner fixture names changed.");
      for (const entry of result) {
        const fresh = native.pinRead(entry.identity.path, entry.directory);
        pins.push(fresh);
        retainedPins.add(fresh);
        const after = security(fresh.handle);
        if (
          fresh.identity.file !== entry.identity.file ||
          fresh.identity.volume !== entry.identity.volume ||
          fresh.byteLength !== entry.size ||
          after.control !== entry.control ||
          after.dacl !== entry.dacl ||
          after.owner !== (prepare ? sid : entry.owner) ||
          (!entry.directory && digest(fresh) !== entry.sha256)
        )
          throw new Error(
            "Synthetic owner fixture changed beyond declared owner preparation.",
          );
      }
    } catch (error) {
      failure = error;
    }
    const errors: unknown[] = [];
    for (const pin of pins.reverse()) {
      try {
        pin.close();
        retainedPins.delete(pin);
      } catch (error) {
        errors.push(error);
      }
    }
    active = false;
    if (retainedPins.size || retainedHandles.size) poisoned = true;
    if (failure || errors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        "Synthetic owner fixture verification failed.",
        { cause: failure },
      );
    return result;
  };
  return Object.freeze({
    sid,
    async declareTree(name: "artifacts" | "outputs") {
      await checkRoot();
      if (
        active ||
        !["artifacts", "outputs"].includes(name) ||
        trees.has(name) ||
        (await readdir(root)).includes(name)
      )
        throw new Error(
          "Synthetic owner fixture requires an absent declared tree.",
        );
      trees.add(name);
    },
    inspect: () => scan(false),
    prepare: () => scan(true),
    close() {
      if (active) throw new Error("Synthetic owner fixture work is active.");
      closed = true;
      const errors: unknown[] = [];
      for (const pin of [...retainedPins].reverse()) {
        try {
          pin.close();
          retainedPins.delete(pin);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const handle of retainedHandles) {
        if (closeHandle(handle)) retainedHandles.delete(handle);
        else
          errors.push(
            new Error("Synthetic owner-only handle retry release failed."),
          );
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Synthetic owner fixture cleanup requires retry.",
        );
    },
  });
}
