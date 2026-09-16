import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OperationContext, Outcome } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProjectFileSystem, portableRelativePath } from "../src/filesystem.js";

let temporary: string;
let files: ProjectFileSystem;
let context: OperationContext;
const value = <T>(outcome: Outcome<T>): T => {
  if (outcome.status !== "complete") throw new Error(JSON.stringify(outcome));
  return outcome.value;
};
beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "studio-host-owned-"));
  await mkdir(path.join(temporary, "input"));
  await mkdir(path.join(temporary, "output"));
  context = syntheticContext();
  context.authorization.grants.push(
    { resourceKind: "artifact", resourceId: "input", operations: ["read"] },
    {
      resourceKind: "artifact",
      resourceId: "output",
      operations: ["read", "write"],
    },
  );
  files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "input",
        path: path.join(temporary, "input"),
        access: "read",
        trustedExclusiveAccess: true,
      },
      {
        id: "output",
        path: path.join(temporary, "output"),
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
});
afterEach(async () => {
  await files?.close();
  await rm(temporary, { recursive: true, force: true });
});

it.each([
  "../a",
  "/absolute",
  "C:\\escape",
  "C:escape",
  "\\\\server\\share",
  "a\\..\\b",
  "a/../b",
  "./a",
  "a//b",
  "CON",
  "aux.txt",
  "a. ",
  "foo:bar",
  "a\u0000b",
  "a/%2e%2e/b",
  "a/COM1.txt",
  "a/.host-stage",
])("rejects nonportable path %s", (candidate) => {
  expect(() => portableRelativePath(candidate)).toThrow();
});
it("accepts portable spaces and preserves nested path identity", () => {
  expect(portableRelativePath("assets/my image.bin")).toBe(
    "assets/my image.bin",
  );
});
it("reads bounded binary and publishes atomically under a distinct output root", async () => {
  const bytes = Uint8Array.from([0, 255, 13, 10, 128]);
  await writeFile(path.join(temporary, "input", "source.bin"), bytes);
  expect(
    value(
      await files.read(
        { artifactRootId: "input", path: "source.bin" },
        context,
      ),
    ),
  ).toEqual(bytes);
  const staged = value(
    await files.stage(
      { artifactRootId: "output", path: "assets/result.bin" },
      bytes,
      context,
    ),
  );
  expect(staged.artifact.mediaType).toBe("application/octet-stream");
  expect(
    await files.read(
      { artifactRootId: "output", path: staged.artifact.path },
      context,
    ),
  ).toMatchObject({ error: { code: "RESOURCE_UNRESOLVED" } });
  const artifact = value(await files.publish(staged, context));
  expect(
    value(
      await files.read(
        { artifactRootId: "output", path: artifact.path },
        context,
      ),
    ),
  ).toEqual(bytes);
  expect(await files.discard(staged.stagingId, context)).toMatchObject({
    error: { code: "RESOURCE_UNRESOLVED" },
  });
});
it("rejects cross-project/wrong-kind/read-only writes and finite byte bounds", async () => {
  const request = { artifactRootId: "output", path: "a.bin" };
  expect(
    await files.stage(request, new Uint8Array(1), {
      ...context,
      projectId: "other",
    }),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(
    await files.stage(request, new Uint8Array(1), {
      ...context,
      authorization: {
        ...context.authorization,
        grants: [
          {
            resourceKind: "provider",
            resourceId: "output",
            operations: ["write"],
          },
        ],
      },
    }),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(
    await files.stage(
      { ...request, artifactRootId: "input" },
      new Uint8Array(1),
      context,
    ),
  ).toMatchObject({ status: "failed" });
  expect(
    await files.stage(request, new Uint8Array(2), {
      ...context,
      budget: { ...context.budget, maxInputBytes: 1 },
    }),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
  await writeFile(
    path.join(temporary, "input", "large.bin"),
    new Uint8Array(2),
  );
  expect(
    await files.read(
      { artifactRootId: "input", path: "large.bin" },
      { ...context, budget: { ...context.budget, maxInputBytes: 1 } },
    ),
  ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
});
it("denies case aliases and links/junctions to outside roots", async () => {
  await writeFile(path.join(temporary, "input", "Case.bin"), "safe");
  expect(
    await files.read({ artifactRootId: "input", path: "case.bin" }, context),
  ).toMatchObject({ error: { code: "PATH_FORBIDDEN" } });
  await symlink(
    path.join(temporary, "input"),
    path.join(temporary, "output", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    await files.read(
      { artifactRootId: "output", path: "escape/Case.bin" },
      context,
    ),
  ).toMatchObject({ error: { code: "PATH_FORBIDDEN" } });
  expect(
    await files.stage(
      { artifactRootId: "output", path: "escape/new.bin" },
      new Uint8Array(1),
      context,
    ),
  ).toMatchObject({ error: { code: "PATH_FORBIDDEN" } });
});
it("binds staged metadata and discard to project, actor, request and original bytes", async () => {
  const staged = value(
    await files.stage(
      { artifactRootId: "output", path: "x.bin" },
      Uint8Array.of(42),
      context,
    ),
  );
  expect(
    await files.publish(
      { ...staged, artifact: { ...staged.artifact, mediaType: "image/png" } },
      context,
    ),
  ).toMatchObject({ error: { code: "ARTIFACT_INTEGRITY" } });
  expect(
    await files.discard(staged.stagingId, { ...context, requestId: "other" }),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(await files.discard(staged.stagingId, context)).toMatchObject({
    status: "complete",
  });
  expect(await files.publish(staged, context)).toMatchObject({
    status: "failed",
  });
});
it("detects staged corruption and never overwrites a published path in concurrent publishes", async () => {
  const request = { artifactRootId: "output", path: "race.bin" };
  const first = value(await files.stage(request, Uint8Array.of(1), context));
  const second = value(await files.stage(request, Uint8Array.of(2), context));
  const results = await Promise.all([
    files.publish(first, context),
    files.publish(second, context),
  ]);
  expect(results.filter((result) => result.status === "complete")).toHaveLength(
    1,
  );
  expect(
    results.filter(
      (result) => "error" in result && result.error.code === "CONFLICT",
    ),
  ).toHaveLength(1);
  const disk = await readFile(path.join(temporary, "output", "race.bin"));
  expect([1, 2]).toContain(disk[0]);
  const corrupt = value(
    await files.stage(
      { ...request, path: "corrupt.bin" },
      Uint8Array.of(3),
      context,
    ),
  );
  const privateDirs = (await readdir(path.join(temporary, "output"))).filter(
    (entry) => entry.startsWith(".host-"),
  );
  const stageDir = privateDirs[0];
  expect(stageDir).toBeDefined();
  await writeFile(
    path.join(temporary, "output", stageDir ?? "", corrupt.stagingId),
    Uint8Array.of(4),
  );
  expect(await files.publish(corrupt, context)).toMatchObject({
    error: { code: "ARTIFACT_INTEGRITY" },
  });
});
it("serializes concurrent first stages and cleans only its single owned staging directory", async () => {
  const outcomes = await Promise.all(
    ["a", "b", "c"].map((name) =>
      files.stage(
        { artifactRootId: "output", path: `nested/${name}.bin` },
        Uint8Array.of(1),
        context,
      ),
    ),
  );
  expect(outcomes.every((outcome) => outcome.status === "complete")).toBe(true);
  await files.close();
  expect(
    (await readdir(path.join(temporary, "output"))).filter((name) =>
      name.startsWith(".host-"),
    ),
  ).toEqual([]);
});
