import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import {
  type FixtureProjectOptions,
  type FixtureProjectRegistry,
  WindowsFixtureProjects,
} from "../src/index.js";
import { loadNative } from "../src/native.js";

export async function openAtTestRoot(
  options: FixtureProjectOptions,
  root: string,
): Promise<FixtureProjectRegistry> {
  const native = await loadNative();
  const seam = vi.spyOn(native, "localAppData").mockReturnValue(root);
  try {
    return await WindowsFixtureProjects.open(options);
  } finally {
    seam.mockRestore();
  }
}

export async function ownedTest(
  operation: (
    root: string,
    own: (registry: FixtureProjectRegistry) => FixtureProjectRegistry,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ds-ph-"));
  const identity = await lstat(root, { bigint: true });
  const registries: FixtureProjectRegistry[] = [];
  const errors: unknown[] = [];
  try {
    await operation(root, (registry) => {
      registries.push(registry);
      return registry;
    });
  } catch (error) {
    errors.push(error);
  }
  for (const registry of registries.reverse()) {
    try {
      await registry.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const current = await lstat(root, { bigint: true });
    if (
      identity.dev !== current.dev ||
      identity.ino !== current.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (await realpath(root)).toLowerCase() !== root.toLowerCase()
    )
      throw new Error(
        "Refusing cleanup: exact generated test-root identity changed.",
      );
    await rm(root, { recursive: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Test operation or fixture cleanup failed.",
      { cause: errors[0] },
    );
}

/** Native tampering is restricted to a verified newly generated test descendant. */
export async function weakenTestAcl(
  root: string,
  filename: string,
  nullDacl = false,
  restoreOwner = false,
  readonlyOwner = false,
): Promise<void> {
  const relative = path.relative(root, filename);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(root).startsWith("ds-ph-")
  )
    throw new Error("ACL test requires an exact generated fixture descendant.");
  const koffi = await import("koffi");
  const advapi = koffi.load("advapi32.dll");
  const kernel = koffi.load("kernel32.dll");
  const convert: (
    text: string,
    revision: number,
    result: unknown[],
    size: null,
  ) => number = advapi.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32_t, _Out_ void **, void *)",
  );
  const set: (name: string, flags: number, descriptor: unknown) => number =
    advapi.func(
      "int __stdcall SetFileSecurityW(const char16_t *, uint32_t, void *)",
    );
  const free: (pointer: unknown) => unknown = kernel.func(
    "void * __stdcall LocalFree(void *)",
  );
  const descriptor: unknown[] = [null];
  const sid = restoreOwner ? (await loadNative()).principal() : undefined;
  if (
    !convert(
      restoreOwner
        ? `D:P(A;OICI;${readonlyOwner ? "FRFX" : "FA"};;;${sid})(A;OICI;FA;;;SY)`
        : nullDacl
          ? "D:NO_ACCESS_CONTROL"
          : "D:P(A;OICI;FA;;;WD)",
      1,
      descriptor,
      null,
    )
  )
    throw new Error("Test descriptor conversion failed.");
  const errors: unknown[] = [];
  try {
    if (!set(`\\\\?\\${filename}`, 0x80000004, descriptor[0]))
      throw new Error("Test-only ACL mutation failed.");
  } catch (error) {
    errors.push(error);
  }
  if (free(descriptor[0]) !== null)
    errors.push(new Error("Test descriptor free failed."));
  if (errors.length)
    throw new AggregateError(
      errors,
      "Test ACL operation or descriptor cleanup failed.",
      { cause: errors[0] },
    );
}
