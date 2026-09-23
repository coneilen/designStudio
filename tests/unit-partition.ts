import assert from "node:assert/strict";

// Exact files with real native ACL/NTFS, Job/process containment or platform-driver fixtures.
// Mixed files remain intact; ordinary SQLite-composition tests remain portable.
export const nativeUnitFiles = [
  "packages/application/tests/capture-orphan-recovery.test.ts",
  "packages/application/tests/capture-publication-recovery.test.ts",
  "packages/application/tests/native-capture.test.ts",
  "packages/host/tests/native-publication.test.ts",
  "packages/host/tests/owned-publication-recovery.test.ts",
  "packages/host/tests/windows-write-through.test.ts",
  "packages/project-host/tests/capture-fixture-lifecycle.test.ts",
  "packages/project-host/tests/capture-project.test.ts",
  "packages/project-host/tests/denials.test.ts",
  "packages/project-host/tests/installation-native.test.ts",
  "packages/project-host/tests/installation.test.ts",
  "packages/project-host/tests/lifetime.test.ts",
  "packages/project-host/tests/pat-dialog-controller.test.ts",
  "packages/project-host/tests/pat-dialog-process.test.ts",
  "packages/project-host/tests/pat-helper-failures.test.ts",
  "packages/project-host/tests/policy.test.ts",
  "packages/project-host/tests/process.test.ts",
  "packages/project-host/tests/projects.test.ts",
  "packages/project-host/tests/runtime-profile.test.ts",
  "packages/renderer-host/tests/bootstrap.test.ts",
  "packages/renderer-host/tests/containment.test.ts",
  "packages/renderer-host/tests/lease.test.ts",
  "packages/renderer-host/tests/native-failures.test.ts",
  "packages/renderer-host/tests/owner-death.test.ts",
  "packages/storage/tests/driver.test.ts",
  "packages/storage/tests/process-crash.test.ts",
  "packages/storage/tests/store.test.ts",
];

export function assertUnitPartition(
  discovered: readonly string[],
  portable: readonly string[],
  native: readonly string[],
  inventory: readonly string[] = nativeUnitFiles,
) {
  const original = new Set(discovered);
  assert.equal(
    original.size,
    discovered.length,
    "Duplicate original unit file",
  );
  assert.equal(
    new Set(inventory).size,
    inventory.length,
    "Duplicate native inventory entry",
  );
  for (const filename of inventory) {
    assert(
      /^packages\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.test\.ts$/.test(
        filename,
      ),
      "Native inventory must contain exact repository test paths, not globs",
    );
    assert(!filename.endsWith(".smoke.test.ts"), "Smoke must remain separate");
    assert(
      original.has(filename),
      `Native inventory file is absent: ${filename}`,
    );
  }
  assert.equal(
    new Set(portable).size,
    portable.length,
    "Duplicate portable discovery",
  );
  assert.equal(
    new Set(native).size,
    native.length,
    "Duplicate native discovery",
  );
  assert.deepEqual(
    [...native].sort(),
    [...inventory].sort(),
    "Native project does not match exact inventory",
  );
  assert.deepEqual(
    [...portable].sort(),
    discovered.filter((filename) => !inventory.includes(filename)).sort(),
    "Portable project must include every remaining original unit file",
  );
  assert.equal(
    new Set([...portable, ...native]).size,
    discovered.length,
    "Unit phases overlap or omit coverage",
  );
  return {
    original: discovered.length,
    portable: portable.length,
    native: native.length,
  };
}
