import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import {
  ProjectFileSystem,
  type RetainedReferenceInput,
} from "../src/filesystem.js";
import { HostBoundaryError } from "../src/guards.js";

const fault = vi.hoisted(() => ({ unlinkPath: "", shortReadPath: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === fault.shortReadPath) {
        fault.shortReadPath = "";
        Object.defineProperty(handle, "read", {
          value: async (buffer: Uint8Array) => ({ bytesRead: 0, buffer }),
        });
      }
      return handle;
    },
    unlink: async (target: Parameters<typeof actual.unlink>[0]) => {
      if (String(target).endsWith(fault.unlinkPath) && fault.unlinkPath) {
        fault.unlinkPath = "";
        throw Object.assign(new Error("synthetic owned unlink failure"), {
          code: "EACCES",
        });
      }
      return actual.unlink(target);
    },
  };
});

it("reports uncertain publication after a real link succeeds and stage unlink fails; retry reconciles only its owned pair", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-publish-owned-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "output",
    operations: ["read", "write"],
  });
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "output",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
  try {
    const staged = await files.stage(
      { artifactRootId: "output", path: "result.bin" },
      Uint8Array.of(42),
      context,
    );
    if (staged.status !== "complete") throw new Error(JSON.stringify(staged));
    fault.unlinkPath = staged.value.stagingId;
    const result = await files.publish(staged.value, context);
    expect(result).toMatchObject({
      status: "interrupted",
      error: { code: "OUTPUT_UNCERTAIN" },
    });
    expect(await readFile(path.join(directory, "result.bin"))).toEqual(
      Buffer.from([42]),
    );
    expect((await lstat(path.join(directory, "result.bin"))).nlink).toBe(2);
    await expect(files.close()).rejects.toMatchObject({
      code: "OUTPUT_UNCERTAIN",
    });
    expect(await files.publish(staged.value, context)).toMatchObject({
      status: "complete",
      value: staged.value.artifact,
    });
    expect((await lstat(path.join(directory, "result.bin"))).nlink).toBe(1);
    expect(
      await files.read(
        { artifactRootId: "output", path: "result.bin" },
        context,
      ),
    ).toMatchObject({ status: "complete" });
  } finally {
    fault.unlinkPath = "";
    try {
      await files.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it.each([
  "stage-only",
  "close-failure",
  "published-only",
  "pair",
  "ambiguous",
  "missing",
  "unknown",
  "duplicate",
  "corrupt",
  "hardlink",
  "grow",
  "truncate",
  "reparse",
  "descriptor",
  "missing-registered",
  "missing-history",
  "committed-size",
  "proof-native",
  "proof-stat",
  "body-read",
  "final-inventory",
  "native-recheck",
  "native-admission",
  "unknown-pin",
  "cancel-pin",
  "corrupt-close-failure",
  "diagnostic-isolation",
] as const)(
  "read-only retained inspector handles %s without adopting or unlinking history",
  async (kind) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "retained-validation-synthetic-"),
    );
    const artifacts = path.join(directory, "artifacts");
    const outputs = path.join(directory, "outputs");
    const staging = ".host-00000000-0000-4000-8000-000000000000";
    await mkdir(artifacts);
    await mkdir(outputs);
    await mkdir(path.join(artifacts, staging));
    await mkdir(path.join(artifacts, "blobs"));
    const targets = [42, 43].map((byte, index) => {
      const hash = createHash("sha256").update(Buffer.of(byte)).digest("hex");
      return {
        stagingId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        jobId: "diagnostic_synthetic",
        requestId: "diagnostic_synthetic",
        artifact: {
          id: `sha256_${hash}`,
          sha256: hash,
          path: `blobs/${hash}`,
          byteLength: 1,
          mediaType: "application/octet-stream",
        },
      };
    });
    for (const [index, descriptor] of targets.entries())
      await writeFile(
        path.join(artifacts, staging, descriptor.stagingId),
        Buffer.of(index + 42),
      );
    const first = targets[0];
    const secondTarget = targets[1];
    if (!first || !secondTarget)
      throw new Error("Missing synthetic descriptor");
    const stage = path.join(artifacts, staging, first.stagingId);
    const blob = path.join(artifacts, first.artifact.path);
    if (kind === "published-only") {
      for (const descriptor of targets)
        await rename(
          path.join(artifacts, staging, descriptor.stagingId),
          path.join(artifacts, descriptor.artifact.path),
        );
    } else if (kind === "pair") await link(stage, blob);
    else if (kind === "ambiguous") await writeFile(blob, Buffer.of(42));
    else if (kind === "missing") await rm(stage);
    else if (kind === "unknown")
      await writeFile(path.join(artifacts, staging, "unknown"), Buffer.of(1));
    else if (kind === "duplicate") {
      const second = path.join(
        artifacts,
        ".host-00000000-0000-4000-8000-000000000099",
      );
      await mkdir(second);
      await writeFile(path.join(second, first.stagingId), Buffer.of(42));
    } else if (kind === "hardlink")
      await link(stage, path.join(directory, "foreign-link"));
    else if (kind === "corrupt") await writeFile(stage, Buffer.of(44));
    else if (kind === "grow") await writeFile(stage, Buffer.of(42, 0));
    else if (kind === "truncate") await writeFile(stage, Buffer.alloc(0));
    else if (kind === "reparse") {
      const foreign = path.join(directory, "foreign");
      await rename(path.join(artifacts, staging), foreign);
      await symlink(foreign, path.join(artifacts, staging), "junction");
    }
    const context = syntheticContext();
    context.authorization.grants.push(
      ...["artifacts", "outputs"].map((resourceId) => ({
        resourceKind: "artifact" as const,
        resourceId,
        operations: ["read"] as ["read"],
      })),
    );
    const input: RetainedReferenceInput = {
      targets,
      artifacts: [],
      history: [],
    };
    const sourceBytes = Buffer.from("synthetic original proof");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const source = {
      id: `sha256_${sourceHash}`,
      sha256: sourceHash,
      path: `blobs/${sourceHash}`,
      byteLength: sourceBytes.length,
      mediaType: "application/octet-stream",
    };
    const sourcePath = path.join(artifacts, ...source.path.split("/"));
    if (
      [
        "missing-registered",
        "committed-size",
        "proof-native",
        "proof-stat",
      ].includes(kind)
    ) {
      input.artifacts = [source];
      if (kind !== "missing-registered")
        await writeFile(sourcePath, sourceBytes);
      if (kind === "committed-size")
        input.artifacts = [{ ...source, byteLength: sourceBytes.length + 1 }];
    }
    if (kind === "missing-history")
      input.history = [
        { ...first, stagingId: "00000000-0000-4000-8000-000000000077" },
      ];
    if (kind === "descriptor")
      input.targets = [{ ...first, stagingId: "invalid" }, secondTarget];
    if (kind === "corrupt-close-failure") await writeFile(stage, Buffer.of(44));
    let pins = 0;
    let sequence = 0;
    const closes = new Map<number, number>();
    let charged = 0;
    let inspectionActive = false;
    let rootChecks = 0;
    let mutated = false;
    const files = await ProjectFileSystem.create({
      projectId: context.projectId,
      authority: () => true,
      reserveRead: (bytes) => {
        charged += bytes;
      },
      roots: [
        {
          id: "artifacts",
          path: artifacts,
          access: "read",
          managedBlobs: true,
          trustedExclusiveAccess: true,
        },
        {
          id: "outputs",
          path: outputs,
          access: "read",
          trustedExclusiveAccess: true,
        },
      ],
      retainedReferenceInspection: {
        artifactRootId: "artifacts",
        outputRootId: "outputs",
        authorize: async (actual) => {
          if (kind !== "diagnostic-isolation") expect(actual).toEqual(input);
        },
        pin: async (id, relative) => {
          if (kind === "native-admission")
            throw new HostBoundaryError(
              "ACTION_REQUIRED",
              "Synthetic native owner guard",
            );
          if (kind === "unknown-pin")
            throw new Error("Synthetic unclassified pin exception");
          if (kind === "cancel-pin")
            throw new HostBoundaryError("CANCELLED", "Synthetic cancelled pin");
          const filename = path.join(
            id === "artifacts" ? artifacts : outputs,
            ...relative.split("/"),
          );
          const stat = await lstat(filename);
          expect(stat.isDirectory() || stat.nlink === 1).toBe(true);
          pins++;
          const pinId = ++sequence;
          if (kind === "final-inventory" && !mutated) {
            mutated = true;
            await writeFile(path.join(outputs, "new-output"), Buffer.of(1));
          }
          if (id === "artifacts" && relative === "") rootChecks++;
          let closed = false;
          return {
            check: async () => {
              if (kind === "body-read" && !mutated && filename === stage) {
                mutated = true;
                fault.shortReadPath = stage;
              }
            },
            identity: {
              path: filename,
              volume: stat.dev,
              file:
                kind === "proof-native" &&
                inspectionActive &&
                relative === source.path
                  ? "changed-native-identity"
                  : kind === "native-recheck" &&
                      relative === "" &&
                      id === "artifacts" &&
                      rootChecks === 2
                    ? "changed-recheck-identity"
                    : String(stat.ino),
            },
            close: () => {
              if (!closed) {
                closes.set(pinId, (closes.get(pinId) ?? 0) + 1);
                if (
                  ["close-failure", "corrupt-close-failure"].includes(kind) &&
                  pinId === 1 &&
                  closes.get(pinId) === 1
                )
                  throw new Error("Synthetic first independent closure failed");
                pins--;
                closed = true;
              }
            },
          };
        },
      },
    });
    try {
      if (kind === "proof-native" || kind === "proof-stat") {
        const proof = await files.read(
          { artifactRootId: "artifacts", path: source.path },
          context,
        );
        expect(proof.status).toBe("complete");
        if (kind === "proof-stat") await writeFile(sourcePath, sourceBytes);
      }
      inspectionActive = true;
      if (kind === "diagnostic-isolation") {
        const bad = {
          ...input,
          targets: [{ ...first, stagingId: "invalid" }, secondTarget],
        };
        const [failure, success] = await Promise.all([
          files.inspectRetainedReference(bad, context),
          files.inspectRetainedReference(input, context),
        ]);
        expect(failure.inventoryFailure).toEqual({
          check: "descriptor",
          category: "retained-target",
        });
        expect(success.status).toBe("complete");
        expect(success.inventoryFailure).toBeUndefined();
        if (success.status === "complete") success.value.close();
        const next = await files.inspectRetainedReference(input, context);
        expect(next.status).toBe("complete");
        expect(next.inventoryFailure).toBeUndefined();
        if (next.status === "complete") next.value.close();
        return;
      }
      if (kind === "unknown-pin") {
        await expect(
          files.inspectRetainedReference(input, context),
        ).rejects.toThrow(/unclassified/);
        return;
      }
      const result = await files.inspectRetainedReference(input, context);
      const expectedDiagnostics: Record<
        string,
        { check: string; category: string }
      > = {
        descriptor: { check: "descriptor", category: "retained-target" },
        "missing-registered": {
          check: "missing-recorded-entry",
          category: "committed-inventory",
        },
        "missing-history": {
          check: "missing-recorded-entry",
          category: "history-stage",
        },
        "committed-size": {
          check: "committed-size",
          category: "committed-inventory",
        },
        "proof-native": {
          check: "proof-native-identity",
          category: "original-proof",
        },
        "proof-stat": { check: "proof-stat", category: "original-proof" },
        ambiguous: { check: "publication-shape", category: "retained-target" },
        missing: { check: "publication-shape", category: "retained-target" },
        hardlink: { check: "publication-shape", category: "retained-target" },
        grow: { check: "publication-shape", category: "retained-target" },
        truncate: { check: "publication-shape", category: "retained-target" },
        corrupt: { check: "body-hash", category: "retained-target" },
        "corrupt-close-failure": {
          check: "body-hash",
          category: "retained-target",
        },
        "body-read": { check: "body-read", category: "retained-target" },
        "final-inventory": {
          check: "inventory-recheck",
          category: "namespace",
        },
        "native-recheck": {
          check: "native-identity-recheck",
          category: "namespace",
        },
        "native-admission": {
          check: "native-read-admission",
          category: "namespace",
        },
      };
      expect(result.inventoryFailure, kind).toEqual(expectedDiagnostics[kind]);
      if (kind === "corrupt-close-failure") {
        expect(result).toMatchObject({
          status: "failed",
          error: { code: "ARTIFACT_INTEGRITY" },
        });
        expect(pins).toBe(1);
        await files.closePreservingStages();
      }
      if (
        ["stage-only", "published-only", "pair", "close-failure"].includes(kind)
      ) {
        expect(result.status, JSON.stringify(result)).toBe("complete");
        if (result.status !== "complete")
          throw new Error("Expected retained observation");
        try {
          expect(result.value.targets[0]?.publication).toBe(
            kind === "pair"
              ? "known-pair-native-read-blocked"
              : kind === "close-failure"
                ? "stage-only"
                : kind,
          );
          if (kind === "pair") {
            expect(charged).toBe(0);
            expect((await lstat(stage)).nlink).toBe(2);
            expect(
              result.value.targets.every((t) => t.bytes === undefined),
            ).toBe(true);
          } else {
            expect(charged).toBe(4);
            expect(result.value.targets.map((t) => t.bytes?.[0])).toEqual([
              42, 43,
            ]);
          }
          await result.value.check();
          expect(
            await files.stage(
              { artifactRootId: "artifacts", path: "denied" },
              Buffer.of(1),
              context,
            ),
          ).toMatchObject({ error: { code: "FORBIDDEN" } });
          expect(
            await files.reconcilePublication(
              "artifacts",
              first.artifact,
              first.stagingId,
              context,
            ),
          ).toMatchObject({ error: { code: "FORBIDDEN" } });
          if (kind === "stage-only") {
            await writeFile(stage, Buffer.of(42));
            await expect(result.value.check()).rejects.toMatchObject({
              code: "ARTIFACT_INTEGRITY",
            });
            expect(result.inventoryFailure).toBeUndefined();
          }
          if (kind === "close-failure") {
            const second = await files.inspectRetainedReference(input, context);
            expect(second.status).toBe("complete");
            await expect(files.closePreservingStages()).rejects.toMatchObject({
              code: "INTERRUPTED",
            });
            expect(pins).toBe(1);
            expect(closes.size).toBe(sequence);
            expect(files.hasRetainedReadClosures).toBe(true);
            await files.closePreservingStages();
            expect(files.hasRetainedReadClosures).toBe(false);
            expect(
              [...closes].filter(([id, count]) => id !== 1 && count !== 1),
            ).toEqual([]);
            expect(closes.get(1)).toBe(2);
          }
        } finally {
          result.value.close();
        }
      } else {
        expect(result.status, kind).not.toBe("complete");
      }
      await files.closeRetainedProofReads();
      expect(pins).toBe(0);
    } finally {
      fault.shortReadPath = "";
      await files.closePreservingStages();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
it("post-crash pair recovery requires a trusted reservation and exact hash/inode pair", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-crash-owned-"));
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "artifact",
    resourceId: "output",
    operations: ["read", "write"],
  });
  const stageId = "00000000-0000-4000-8000-000000000001";
  const stageDirectory = ".host-00000000-0000-4000-8000-000000000000";
  const bytes = Uint8Array.of(42);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = {
    id: `sha256_${hash}`,
    path: `blobs/${hash}`,
    sha256: hash,
    byteLength: 1,
    mediaType: "application/octet-stream",
  };
  await mkdir(path.join(directory, "blobs"));
  await mkdir(path.join(directory, stageDirectory));
  const stagePath = path.join(directory, stageDirectory, stageId);
  await writeFile(stagePath, bytes);
  await link(stagePath, path.join(directory, artifact.path));
  let allowed = false;
  const files = await ProjectFileSystem.create({
    projectId: context.projectId,
    authority: () => true,
    roots: [
      {
        id: "output",
        path: directory,
        access: "read-write",
        trustedExclusiveAccess: true,
        managedBlobs: true,
      },
    ],
    authorizePublicationRecovery: async () => allowed,
  });
  try {
    expect(
      await files.reconcilePublication("output", artifact, stageId, context),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    allowed = true;
    expect(
      await files.reconcilePublication(
        "output",
        { ...artifact, byteLength: 2 },
        stageId,
        context,
      ),
    ).toMatchObject({ error: { code: "ARTIFACT_INTEGRITY" } });
    expect(
      await files.reconcilePublication("output", artifact, stageId, context),
    ).toMatchObject({ status: "complete", value: artifact });
    expect(
      await files.read(
        { artifactRootId: "output", path: artifact.path },
        context,
      ),
    ).toMatchObject({ status: "complete" });
  } finally {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  }
});
