import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FixtureProjectOptions,
  WindowsFixtureProjects,
} from "@design-studio/project-host";
import { vi } from "vitest";
// The approved internal KnownFolder seam, applied to the BUILT public package to preserve opaque type identity.
import { loadNative } from "../../project-host/dist/native.js";

export async function openAtTestRoot(
  options: FixtureProjectOptions,
  root: string,
) {
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
    own: <T extends { close(): Promise<void> }>(value: T) => T,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "ds-ph-"));
  const identity = await lstat(root, { bigint: true });
  const owned: { close(): Promise<void> }[] = [];
  const errors: unknown[] = [];
  try {
    await operation(root, (resource) => {
      owned.push(resource);
      return resource;
    });
  } catch (error) {
    errors.push(error);
  }
  for (const resource of owned.reverse()) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const current = await lstat(root, { bigint: true });
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (await realpath(root)).toLowerCase() !== root.toLowerCase()
    )
      throw new Error("Owned fixture root changed; refusing cleanup.");
    await rm(root, { recursive: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Owned fixture operation/cleanup failed.",
      { cause: errors[0] },
    );
}
