import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Security mutations are confined to exact, newly generated native test descendants. */
export async function retainedSecurityFixture(root: string, filename: string) {
  const relative = path.relative(root, filename);
  const before = await lstat(filename);
  if (
    !path.basename(root).startsWith("ds-ph-") ||
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    before.isSymbolicLink() ||
    (await realpath(filename)).toLowerCase() !== filename.toLowerCase()
  )
    throw new Error(
      "Security fixture requires a generated ordinary descendant.",
    );
  const koffi = await import("koffi");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const get: (
    name: string,
    flags: number,
    bytes: Buffer | null,
    length: number,
    needed: Buffer,
  ) => number = advapi.func(
    "int __stdcall GetFileSecurityW(const char16_t *, uint32_t, _Out_ void *, uint32_t, _Out_ void *)",
  );
  const set: (name: string, flags: number, descriptor: unknown) => number =
    advapi.func(
      "int __stdcall SetFileSecurityW(const char16_t *, uint32_t, void *)",
    );
  const convert: (
    text: string,
    revision: number,
    result: unknown[],
    size: null,
  ) => number = advapi.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32_t, _Out_ void **, void *)",
  );
  const free: (pointer: unknown) => unknown = kernel.func(
    "void * __stdcall LocalFree(void *)",
  );
  const name = `\\\\?\\${filename}`;
  const current = async () => {
    const after = await lstat(filename);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.isSymbolicLink() ||
      (await realpath(path.dirname(filename))).toLowerCase() !==
        path.dirname(filename).toLowerCase()
    )
      throw new Error("Synthetic security target identity changed.");
  };
  const snapshot = async () => {
    await current();
    const needed = Buffer.alloc(4);
    get(name, 5, null, 0, needed);
    const length = needed.readUInt32LE();
    if (length < 20 || length > 65536)
      throw new Error("Invalid synthetic security descriptor size.");
    const bytes = Buffer.alloc(length);
    if (!get(name, 5, bytes, length, needed))
      throw new Error("Synthetic security snapshot failed.");
    return bytes;
  };
  const original = await snapshot();
  const protectedDacl = Boolean(original.readUInt16LE(2) & 0x1000);
  return {
    snapshot,
    async profile() {
      const bytes = await snapshot();
      const sidAt = (offset: number) => {
        const authority = bytes.readUIntBE(offset + 2, 6);
        const parts = [bytes[offset], authority];
        for (let n = 0; n < (bytes[offset + 1] ?? 0); n++)
          parts.push(bytes.readUInt32LE(offset + 8 + 4 * n));
        return `S-${parts.join("-")}`;
      };
      const acl = bytes.readUInt32LE(16);
      const aces: { type: number; flags: number; mask: number; sid: string }[] =
        [];
      if (acl) {
        let offset = acl + 8;
        for (let index = 0; index < bytes.readUInt16LE(acl + 4); index++) {
          aces.push({
            type: bytes.readUInt8(offset),
            flags: bytes.readUInt8(offset + 1),
            mask: bytes.readUInt32LE(offset + 4),
            sid: sidAt(offset + 8),
          });
          offset += bytes.readUInt16LE(offset + 2);
        }
      }
      return {
        owner: sidAt(bytes.readUInt32LE(4)),
        protected: Boolean(bytes.readUInt16LE(2) & 0x1000),
        nullDacl: acl === 0,
        aces,
      };
    },
    async set(sddl: string, protectedAcl = false) {
      await current();
      const descriptor: unknown[] = [null];
      if (!convert(sddl, 1, descriptor, null))
        throw new Error("Synthetic security conversion failed.");
      const errors: unknown[] = [];
      try {
        if (
          !set(
            name,
            (protectedAcl ? 0x80000000 : 0x20000000) + 4,
            descriptor[0],
          )
        )
          throw new Error("Synthetic security mutation failed.");
      } catch (error) {
        errors.push(error);
      }
      if (free(descriptor[0]) !== null)
        errors.push(new Error("Synthetic security descriptor cleanup failed."));
      if (errors.length)
        throw new AggregateError(
          errors,
          "Synthetic security mutation or cleanup failed.",
        );
    },
    async restore() {
      await current();
      if (!set(name, (protectedDacl ? 0x80000000 : 0x20000000) + 4, original))
        throw new Error("Synthetic security restoration failed.");
    },
  };
}
