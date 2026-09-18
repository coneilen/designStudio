import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadNative } from "../src/native.js";

/** User-approved differential: only the exact verified public Chromium copy gets a reader ACE. */
export async function allowPublicBrowserRead(
  root: string,
  browser: string,
  inventory: readonly string[],
): Promise<void> {
  if (
    browser !== path.join(root, "browser") ||
    !path.basename(root).startsWith("ds-ph-")
  )
    throw new Error(
      "Browser ACL differential requires exact owned TEMP descendant.",
    );
  const expected = new Set(
    inventory.map((filename) => path.join(browser, ...filename.split("/"))),
  );
  const directories: string[] = [];
  const files: string[] = [];
  const inspect = async (directory: string): Promise<void> => {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Browser ACL probe rejects reparse directories.");
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Browser ACL probe rejects links.");
      if (entry.isDirectory()) await inspect(filename);
      else {
        const info = await lstat(filename);
        if (!info.isFile() || info.nlink !== 1 || !expected.delete(filename))
          throw new Error("Browser ACL probe contains unapproved payload.");
        files.push(filename);
      }
    }
  };
  await inspect(browser);
  if (expected.size)
    throw new Error("Browser ACL probe inventory is incomplete.");
  const native = await loadNative();
  const sid = native.principal();
  const koffi = await import("koffi");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const convert: (
    sddl: string,
    rev: number,
    result: unknown[],
    size: null,
  ) => number = advapi.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32_t, _Out_ void **, void *)",
  );
  const set: (filename: string, flags: number, descriptor: unknown) => number =
    advapi.func(
      "int __stdcall SetFileSecurityW(const char16_t *, uint32_t, void *)",
    );
  const get: (
    filename: string,
    kind: number,
    flags: number,
    owner: null,
    group: null,
    dacl: null,
    sacl: null,
    descriptor: unknown[],
  ) => number = advapi.func(
    "uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *, int, uint32_t, void *, void *, void *, void *, _Out_ void **)",
  );
  const text: (
    descriptor: unknown,
    rev: number,
    flags: number,
    value: unknown[],
    size: null,
  ) => number = advapi.func(
    "int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *, uint32_t, uint32_t, _Out_ void **, void *)",
  );
  const free: (pointer: unknown) => unknown = kernel.func(
    "void * __stdcall LocalFree(void *)",
  );
  const observe = (filename: string): string => {
    const descriptor: unknown[] = [null];
    const output: unknown[] = [null];
    if (get(filename, 1, 5, null, null, null, null, descriptor) !== 0)
      throw new Error("Browser ACL query failed.");
    try {
      if (!text(descriptor[0], 1, 5, output, null))
        throw new Error("Browser ACL conversion failed.");
      return String(koffi.decode(output[0], "char16_t", -1));
    } finally {
      if (output[0]) free(output[0]);
      free(descriptor[0]);
    }
  };
  const before = new Set<string>();
  const after = new Set<string>();
  // Explicit leaf-first ACLs: no grant is placed on root, TEMP or other ancestors.
  for (const filename of [...files, ...directories.reverse()]) {
    before.add(observe(filename));
    const directory = !files.includes(filename);
    const flags = directory ? "OICI" : "";
    const descriptor: unknown[] = [null];
    const sddl = `O:${sid}D:P(A;${flags};FA;;;${sid})(A;${flags};FA;;;SY)(A;${flags};FRFX;;;BU)`;
    if (!convert(sddl, 1, descriptor, null))
      throw new Error("Browser reader ACL construction failed.");
    try {
      if (!set(filename, 0x80000004, descriptor[0]))
        throw new Error("Browser reader ACL update failed.");
    } finally {
      free(descriptor[0]);
    }
    const actual = observe(filename);
    if (
      !actual.includes(";;;BU)") ||
      !actual.includes("D:P") ||
      !actual.startsWith(`O:${sid}`)
    )
      throw new Error("Browser reader ACL/owner verification failed.");
    after.add(actual);
  }
  console.info(
    JSON.stringify({
      probe: "public-browser-only-read-execute",
      files: files.length,
      before: [...before],
      after: [...after],
    }),
  );
}
