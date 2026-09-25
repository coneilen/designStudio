import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { syntheticContext } from "@design-studio/contracts/testing";
import {
  HostBoundaryError,
  ProjectFileSystem,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { expect, test, vi } from "vitest";
import { loadNative, type ReadLease } from "../src/native.js";
import { pinReferenceBackupFile } from "../src/reference-backup.js";
import { pinImmutableReferenceDatabase } from "../src/reference-validation-database.js";
import { pinRetainedReferenceEntry } from "../src/reference-validation-entry.js";
import { withOwnedProbe } from "./owned-probe.js";
import { createRetainedOwnerFixture } from "./retained-owner-fixture.js";
import { retainedSecurityFixture } from "./retained-security-fixture.js";
import { ownedTest, weakenTestAcl } from "./support.js";

const historyReads = vi.hoisted(() => ({ active: false, physical: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read;
      Object.defineProperty(handle, "read", {
        value: async (...input: unknown[]) => {
          const result: unknown = await Reflect.apply(read, handle, input);
          if (
            historyReads.active &&
            result &&
            typeof result === "object" &&
            "bytesRead" in result &&
            typeof result.bytesRead === "number"
          )
            historyReads.physical += result.bytesRead;
          return result;
        },
      });
      return handle;
    },
  };
});

test.each(["valid", "successor", "blob-security", "blob-reparse"] as const)(
  "native historical coexistence requires both current owned bodies: %s",
  async (kind) => {
    await ownedTest(async (root, _own, beforeCleanup) => {
      const owner = await declaredOwnerFixture(root);
      await owner.declareTree("outputs");
      beforeCleanup(() => owner.close());
      const native = await loadNative();
      const artifacts = path.join(root, "artifacts"),
        outputs = path.join(root, "outputs");
      native.createDirectory(artifacts, owner.sid);
      native.createDirectory(outputs, owner.sid);
      const context = syntheticContext();
      context.authorization.grants.push(
        ...["artifacts", "outputs"].map((resourceId) => ({
          resourceKind: "artifact" as const,
          resourceId,
          operations: ["read", "write"] as ["read", "write"],
        })),
      );
      const roots = [
        {
          id: "artifacts",
          path: artifacts,
          access: "read-write" as const,
          trustedExclusiveAccess: true as const,
          managedBlobs: true,
        },
        {
          id: "outputs",
          path: outputs,
          access: "read-write" as const,
          trustedExclusiveAccess: true as const,
        },
      ];
      const producer = await ProjectFileSystem.create({
        projectId: context.projectId,
        authority: () => true,
        roots,
        publicationProfile: WINDOWS_PUBLICATION_PROFILE,
        captureRecoveryInspection: {
          artifactRootId: "artifacts",
          outputRootId: "outputs",
          authorize: async () => {},
        },
      });
      let inspector: ProjectFileSystem | undefined;
      let restoreSecurity: (() => Promise<void>) | undefined;
      let restoreDirectory: (() => Promise<void>) | undefined;
      const pins = new Set<ReadLease>();
      try {
        const stage = async (bytes: Buffer) => {
          const result = await producer.stage(
            {
              artifactRootId: "artifacts",
              path: `blobs/${createHash("sha256").update(bytes).digest("hex")}`,
            },
            bytes,
            context,
          );
          if (result.status !== "complete")
            throw new Error("Synthetic stage failed");
          return result.value;
        };
        const bytes = Buffer.alloc(1024, 42);
        const committed = await producer.publish(await stage(bytes), context);
        if (committed.status !== "complete")
          throw new Error("Synthetic commit failed");
        const historical = await stage(bytes);
        const targets = [
          await stage(Buffer.of(1)),
          await stage(Buffer.of(2, 3)),
        ];
        const descriptor = (staged: typeof historical, jobId: string) => ({
          stagingId: staged.stagingId,
          artifact: staged.artifact,
          jobId,
          requestId: jobId,
        });
        const input = {
          artifacts: [committed.value],
          committedHistoryArtifacts:
            kind === "successor" ? [] : [committed.value],
          successorCaptureHistoryArtifacts:
            kind === "successor" ? [committed.value] : [],
          history: [descriptor(historical, "original_failed")],
          targets: targets.map((entry) =>
            descriptor(entry, "retained_diagnostic"),
          ),
        };
        const legacy = await producer.inspectCaptureRecovery(
          [...input.history, ...input.targets],
          context,
        );
        expect(legacy.status).toBe("complete");
        if (legacy.status === "complete")
          for (const entry of legacy.value.stages) entry.bytes.fill(0);
        await producer.closePreservingStages();
        await owner.prepare();
        const before = await owner.inspect();
        if (kind === "blob-security") {
          const security = await retainedSecurityFixture(
            root,
            path.join(artifacts, ...committed.value.path.split("/")),
          );
          restoreSecurity = security.restore;
          await security.set("D:P(A;;FA;;;WD)", true);
        }
        if (kind === "blob-reparse") {
          const original = path.join(artifacts, "blobs");
          const moved = path.join(root, "outside-declared-blobs");
          await rename(original, moved);
          await symlink(moved, original, "junction");
          restoreDirectory = async () => {
            await rm(original);
            await rename(moved, original);
          };
        }
        let charged = 0;
        let eof = 0;
        inspector = await ProjectFileSystem.create({
          projectId: context.projectId,
          authority: () => true,
          roots: roots.map((entry) => ({ ...entry, access: "read" as const })),
          reserveRead: (length) => {
            charged += length;
            if (length === 1) eof++;
          },
          retainedReferenceInspection: {
            artifactRootId: "artifacts",
            outputRootId: "outputs",
            authorize: async (actual) => {
              expect(actual).toEqual(input);
            },
            pin: (id, relative, directory) =>
              pinRetainedReferenceEntry({
                root: id === "artifacts" ? artifacts : outputs,
                relative,
                directory,
                sid: owner.sid,
                retainedPins: pins,
                authorize: async () => {},
              }),
          },
        });
        historyReads.physical = 0;
        historyReads.active = true;
        const result = await inspector.inspectRetainedReference(input, context);
        if (kind !== "valid" && kind !== "successor") {
          expect(result.status).toBe("failed");
          if (result.status === "failed")
            expect(result.error.code).toBe(
              kind === "blob-security" ? "ACTION_REQUIRED" : "PATH_FORBIDDEN",
            );
          expect(charged).toBe(0);
          expect(historyReads.physical).toBe(0);
          return;
        }
        expect(result.status, JSON.stringify(result)).toBe("complete");
        if (result.status !== "complete")
          throw new Error("Synthetic native coexistence failed");
        try {
          await result.value.check();
          expect(historyReads.physical).toBe(2051);
          expect(charged).toBe(2055);
          expect(eof).toBe(5); // Four EOF probes plus one 1-byte target reservation.
          expect(charged - historyReads.physical).toBe(4);
          expect(
            result.value.targets.map((entry) => entry.publication),
          ).toEqual(["stage-only", "stage-only"]);
        } finally {
          result.value.close();
        }
        historyReads.active = false;
        expect(pins.size).toBe(0);
        expect(await owner.inspect()).toEqual(before);
      } finally {
        historyReads.active = false;
        await inspector?.closePreservingStages();
        await producer.closePreservingStages();
        for (const pin of pins) pin.close();
        await restoreSecurity?.();
        await restoreDirectory?.();
      }
    });
  },
);

async function declaredOwnerFixture(root: string) {
  const owner = await createRetainedOwnerFixture(root);
  await owner.declareTree("artifacts");
  return owner;
}

function inheritedAcl(dacl: string, directory: boolean, sid: string) {
  const bytes = Buffer.from(dacl, "hex");
  expect(bytes.readUInt16LE(4)).toBe(2);
  const trustees: string[] = [];
  let offset = 8;
  for (let index = 0; index < 2; index++) {
    expect(bytes[offset]).toBe(0);
    expect(bytes[offset + 1]).toBe(directory ? 0x13 : 0x10);
    expect(bytes.readUInt32LE(offset + 4)).toBe(0x1f01ff);
    const start = offset + 8;
    const parts = [bytes[start], bytes.readUIntBE(start + 2, 6)];
    for (let n = 0; n < (bytes[start + 1] ?? 0); n++)
      parts.push(bytes.readUInt32LE(start + 8 + n * 4));
    trustees.push(`S-${parts.join("-")}`);
    offset += bytes.readUInt16LE(offset + 2);
  }
  expect(trustees.sort()).toEqual([sid, "S-1-5-18"].sort());
}

test("natural host descendants preserve owner through publication and admit only the actual current owner", async () => {
  await ownedTest(async (root, _own, beforeCleanup) => {
    const owner = await declaredOwnerFixture(root);
    beforeCleanup(() => owner.close());
    const native = await loadNative();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, owner.sid);
    const context = syntheticContext();
    context.authorization.grants.push({
      resourceKind: "artifact",
      resourceId: "artifacts",
      operations: ["read", "write"],
    });
    const fs = await ProjectFileSystem.create({
      projectId: context.projectId,
      authority: () => true,
      publicationProfile: WINDOWS_PUBLICATION_PROFILE,
      roots: [
        {
          id: "artifacts",
          path: artifacts,
          access: "read-write",
          trustedExclusiveAccess: true,
          managedBlobs: true,
        },
      ],
    });
    const pins = new Set<ReadLease>();
    try {
      const bytes = Buffer.from(
        "Untouched natural host owner; never owner-normalized.",
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      const staged = await fs.stage(
        { artifactRootId: "artifacts", path: `blobs/${hash}` },
        bytes,
        context,
      );
      if (staged.status !== "complete")
        throw new Error("Natural synthetic stage failed.");
      const before = await owner.inspect();
      const stage = before.find((entry) =>
        entry.relative.endsWith(`/${staged.value.stagingId}`),
      );
      if (!stage) throw new Error("Natural stage observation missing.");
      const checkAdmission = async (entries: typeof before) => {
        for (const entry of entries.filter(
          (item) => item.relative !== "artifacts",
        )) {
          expect(entry.control & 0x1004).toBe(4);
          inheritedAcl(entry.dacl, entry.directory, owner.sid);
          const relative = entry.relative.slice("artifacts/".length);
          const foreign = entries.some(
            (parent) =>
              (entry.relative === parent.relative ||
                entry.relative.startsWith(`${parent.relative}/`)) &&
              parent.owner !== owner.sid,
          );
          expect(() =>
            native.pinRead(entry.identity.path, entry.directory, owner.sid),
          ).toThrow(entry.owner === owner.sid ? /protected/ : /owner/);
          const admission = pinRetainedReferenceEntry({
            root: artifacts,
            relative,
            directory: entry.directory,
            sid: owner.sid,
            retainedPins: pins,
            authorize: async () => {},
          });
          if (foreign) await expect(admission).rejects.toThrow(/owner/);
          else {
            const pin = await admission;
            try {
              await pin.check();
            } finally {
              pin.close();
            }
          }
        }
      };
      await checkAdmission(before);
      const publication = await fs.publish(staged.value, context);
      if (publication.status !== "complete")
        throw new Error("Natural synthetic publication failed.");
      const after = await owner.inspect();
      const published = after.find(
        (entry) => entry.relative === `artifacts/${publication.value.path}`,
      );
      if (!published) throw new Error("Natural published observation missing.");
      expect([
        published.owner,
        published.control,
        published.dacl,
        published.identity.file,
        published.identity.volume,
        published.sha256,
        published.size,
      ]).toEqual([
        stage.owner,
        stage.control,
        stage.dacl,
        stage.identity.file,
        stage.identity.volume,
        stage.sha256,
        stage.size,
      ]);
      expect(after.some((entry) => entry.relative === stage.relative)).toBe(
        false,
      );
      expect(after.map((entry) => entry.relative).sort()).toEqual(
        before
          .map((entry) =>
            entry === stage ? published.relative : entry.relative,
          )
          .sort(),
      );
      await checkAdmission(after);
      expect(await owner.inspect()).toEqual(after);
      expect(pins.size).toBe(0);
      console.log(
        JSON.stringify({
          scope: "untouched natural synthetic host owner",
          currentOwner: stage.owner === owner.sid,
          administratorsOwner: stage.owner === "S-1-5-32-544",
          admission:
            stage.owner === owner.sid ? "current-owner" : "owner-denied",
          ownerMutations: 0,
        }),
      );
    } finally {
      for (const pin of pins) pin.close();
      owner.close();
      await fs.closePreservingStages();
    }
  });
});

test.each([
  "existing",
  "undeclared",
  "path",
  "hardlink",
  "junction",
  "replacement",
  "root-replacement",
  "depth",
  "closed",
] as const)(
  "explicit owner fixture refuses unowned or changed synthetic scope: %s",
  async (kind) => {
    await ownedTest(async (root, _own, beforeCleanup) => {
      const native = await loadNative();
      const sid = native.principal();
      const artifacts = path.join(root, "artifacts");
      if (kind === "existing") {
        await writeFile(
          path.join(root, "existing"),
          "not registered while empty",
        );
        await expect(createRetainedOwnerFixture(root)).rejects.toThrow(/empty/);
        return;
      }
      const owner = await createRetainedOwnerFixture(root);
      beforeCleanup(() => owner.close());
      if (kind === "undeclared") {
        native.createDirectory(artifacts, sid);
        await expect(owner.declareTree("artifacts")).rejects.toThrow(
          /absent declared/,
        );
        owner.close();
        return;
      }
      if (kind === "path") {
        for (const name of [
          "..",
          ".",
          root,
          "..\\artifacts",
          "artifacts\\blobs",
          "inputs",
        ])
          await expect(
            Reflect.apply(owner.declareTree, owner, [name]),
          ).rejects.toThrow(/absent declared/);
        owner.close();
        return;
      }
      await owner.declareTree("artifacts");
      native.createDirectory(artifacts, sid);
      await mkdir(path.join(artifacts, "blobs"));
      const filename = path.join(artifacts, "blobs", "body");
      await writeFile(filename, "owned synthetic body");
      const before = await owner.inspect();
      if (kind === "hardlink")
        await link(filename, path.join(artifacts, "blobs", "alias"));
      if (kind === "junction") {
        await rename(
          path.join(artifacts, "blobs"),
          path.join(root, "outside-declaration"),
        );
        await symlink(
          path.join(root, "outside-declaration"),
          path.join(artifacts, "blobs"),
          "junction",
        );
      }
      if (kind === "replacement") {
        await rename(filename, path.join(root, "old-body"));
        await writeFile(filename, "owned synthetic body");
      }
      if (kind === "depth") {
        await mkdir(path.join(artifacts, "blobs", "deep"));
        await writeFile(
          path.join(artifacts, "blobs", "deep", "body"),
          "too deep",
        );
      }
      if (kind === "closed") owner.close();
      const moved = `${root}-original`;
      if (kind === "root-replacement") {
        await rename(root, moved);
        await mkdir(root);
      }
      try {
        await expect(owner.prepare()).rejects.toThrow(/verification failed/);
      } finally {
        if (kind === "root-replacement") {
          await rmdir(root);
          await rename(moved, root);
        }
        if (kind === "junction") await rm(path.join(artifacts, "blobs"));
        owner.close();
      }
      expect(before.every((entry) => entry.owner.length > 0)).toBe(true);
    });
  },
);

test("explicit owner preparation preserves actual DACL/control and bytes on every declared new entry", async () => {
  await ownedTest(async (root, _own, beforeCleanup) => {
    const owner = await declaredOwnerFixture(root);
    beforeCleanup(() => owner.close());
    const native = await loadNative();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, owner.sid);
    await mkdir(path.join(artifacts, "blobs"));
    await writeFile(
      path.join(artifacts, "blobs", "body"),
      "owner-only synthetic bytes",
    );
    const natural = await owner.inspect();
    const prepared = await owner.prepare();
    expect(prepared).toEqual(natural);
    const after = await owner.inspect();
    expect(after).toEqual(
      natural.map((entry) => ({ ...entry, owner: owner.sid })),
    );
    const again = await owner.prepare();
    expect(again).toEqual(after);
    owner.close();
    console.log(
      JSON.stringify({
        scope: "explicit current-owner synthetic fixture",
        entries: natural.length,
        normalized: natural.filter((entry) => entry.owner !== owner.sid).length,
        privilegesAdjusted: false,
      }),
    );
  });
});

test("owner-fixture failed pins block reuse and root cleanup until explicit close retry", async () => {
  const native = await loadNative();
  const original = native.pinRead.bind(native);
  let owner: Awaited<ReturnType<typeof createRetainedOwnerFixture>> | undefined;
  let rootPath: string | undefined;
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  let fail = true;
  let outstanding = 0;
  const errors: unknown[] = [];
  const spy = vi.spyOn(native, "pinRead").mockImplementation((...args) => {
    const pin = original(...args);
    if (!args[0].endsWith("\\body")) return pin;
    outstanding++;
    let closed = false;
    return {
      ...pin,
      close() {
        if (fail) throw new Error("Synthetic owner fixture pin close failed.");
        pin.close();
        if (!closed) {
          closed = true;
          outstanding--;
        }
      },
    };
  });
  try {
    await expect(
      ownedTest(async (root, _own, beforeCleanup) => {
        rootPath = root;
        identity = await lstat(root);
        owner = await declaredOwnerFixture(root);
        const scope = owner;
        beforeCleanup(() => scope.close());
        native.createDirectory(
          path.join(root, "artifacts"),
          native.principal(),
        );
        await writeFile(
          path.join(root, "artifacts", "body"),
          "synthetic retained close",
        );
        await expect(scope.prepare()).rejects.toThrow(/verification failed/);
        expect(outstanding).toBeGreaterThan(0);
        await expect(scope.inspect()).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: "Synthetic owner fixture is closed or principal changed.",
          }),
        });
      }),
    ).rejects.toThrow(/fixture cleanup failed/);
    if (!rootPath || !identity || !owner)
      throw new Error("Missing synthetic close-retry owner.");
    expect((await lstat(rootPath)).ino).toBe(identity.ino);
    fail = false;
    owner.close();
    expect(outstanding).toBe(0);
  } catch (error) {
    errors.push(error);
  }
  fail = false;
  try {
    owner?.close();
  } catch (error) {
    errors.push(error);
  }
  spy.mockRestore();
  try {
    if (rootPath && identity) {
      const current = await lstat(rootPath);
      if (
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        current.isSymbolicLink()
      )
        throw new Error("Refusing changed synthetic close-retry root cleanup.");
      await rm(rootPath, { recursive: true });
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Synthetic close-retry regression failed.",
    );
});

test("cold-native explicit current-owner fixture uses host history and production descendant pins", async ({
  signal,
}) => {
  await withOwnedProbe(signal, async (root, run) => {
    const result = await run(
      [
        path.resolve("node_modules\\vitest\\vitest.mjs"),
        "run",
        "--project",
        "unit",
        "packages\\application\\tests\\reference-acquisition.test.ts",
        "-t",
        "^validates stage-only realistic source and PNG under the unchanged physical read budget including closure \\[native\\]$",
        "--reporter=dot",
      ],
      {
        timeout: 60000,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: path.dirname(process.execPath),
          TEMP: root,
          TMP: root,
          DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE: "1",
        },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("including closure [native]");
    expect(result.stdout).toContain("1 passed");
    expect(result.stdout).toContain("retained-native-owner-fixture:");
    expect(result.stdout).toContain(
      "owner-only; DACL/control/names/identity/bytes unchanged",
    );
    expect(result.stdout).toContain(
      "retained-native-history: real native pins; strict inherited denial; private=5698604; physical=5698575; eof=29; network=0; pins=0",
    );
    const ownerMarker = result.stdout.match(
      /retained-native-owner-fixture: \{"entries":\d+,"naturalOwnerDenials":\d+,"normalized":\d+\}/,
    );
    expect(ownerMarker).not.toBeNull();
    console.log(ownerMarker?.[0]);
  });
}, 60000);

test("cold-native offline recovery publishes with real immutable DB pins and write-through durability", async ({
  signal,
}) => {
  await withOwnedProbe(signal, async (root, run) => {
    const result = await run(
      [
        path.resolve("node_modules\\vitest\\vitest.mjs"),
        "run",
        "--project",
        "unit",
        "packages\\application\\tests\\reference-acquisition.test.ts",
        "-t",
        "^publishes realistic offline reference within one physical budget \\[native\\]$",
        "--reporter=dot",
      ],
      {
        timeout: 60000,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: path.dirname(process.execPath),
          TEMP: root,
          TMP: root,
          DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE: "1",
        },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 passed");
    expect(result.stdout).toMatch(
      /offline-reference-budget: private=\d+; eof=\d+; network=0; pins=0/,
    );
    expect(result.stdout).toContain(
      "offline-backup-paths: source=240; pending=305; final=297; raw-preimage=equal; native-callbacks=ordinary",
    );
    console.log(result.stdout.match(/offline-backup-paths: [^\n]+/)?.[0]);
    console.log(
      result.stdout.match(
        /offline-reference-budget: private=\d+; eof=\d+; network=0; pins=0/,
      )?.[0],
    );
    const applyWall = result.stdout.match(
      /offline-reference-wall: applyMs=(\d+); fixtureClock=real-plus-expiry-offset/,
    );
    const convert = result.stdout.match(
      /offline-reference-conversion: private=(\d+); network=0; pins=0; convertMs=(\d+); eof=(\d+)/,
    );
    expect(applyWall).not.toBeNull();
    expect(convert).not.toBeNull();
    expect(Number(applyWall?.[1])).toBeLessThan(30000);
    expect(Number(convert?.[2])).toBeLessThan(30000);
    for (const operation of ["apply", "convert"]) {
      const line = result.stdout.match(
        new RegExp(`offline-${operation}-ledger: (\\{[^\\n]+\\})`),
      );
      expect(line).not.toBeNull();
      const ledger: Record<string, { bytes: number; eof: number }> = JSON.parse(
        line?.[1] ?? "{}",
      );
      for (const [phase, value] of Object.entries(ledger)) {
        expect([
          "proof",
          "history",
          "admission",
          "commit",
          "inspection",
        ]).toContain(phase);
        expect(Number.isSafeInteger(value.bytes) && value.bytes >= 0).toBe(
          true,
        );
        expect(Number.isSafeInteger(value.eof) && value.eof >= 0).toBe(true);
      }
      console.log(
        `native-offline-${operation}-ledger: ${JSON.stringify(ledger)}`,
      );
    }
    console.log(
      `native-offline-wall: applyMs=${applyWall?.[1]}; convertMs=${convert?.[2]}; real-clock-with-expiry-offset`,
    );
  });
}, 60000);

for (const point of [
  "reference-after-reserve",
  "reference-after-stage",
  "reference-before-receipt",
  "after-commit",
]) {
  test(`cold offline crash at ${point} retains sidecars and denies read-only continuation`, async ({
    signal,
  }) => {
    await withOwnedProbe(signal, async (root, run) => {
      let failure: unknown;
      try {
        await run(
          [
            path.resolve("node_modules\\vitest\\vitest.mjs"),
            "run",
            "--project",
            "unit",
            "packages\\application\\tests\\reference-acquisition.test.ts",
            "-t",
            "^cold offline recovery crash fixture$",
            "--reporter=dot",
            "--pool=forks",
            "--maxWorkers=1",
          ],
          {
            timeout: 60000,
            env: {
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              PATH: path.dirname(process.execPath),
              TEMP: root,
              TMP: root,
              DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE: "1",
              DESIGN_STUDIO_SYNTHETIC_OFFLINE_CRASH: point,
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const fixtures = (await readdir(root)).filter((name) =>
        name.startsWith("ds-ph-reference-"),
      );
      expect(
        fixtures,
        failure instanceof Error ? failure.message : "No child failure",
      ).toHaveLength(1);
      const fixture = path.join(root, fixtures[0] ?? "");
      const witness: {
        point: string;
        pid: number;
        parentPid: number;
        execution: string;
      } = JSON.parse(
        await readFile(
          path.join(fixture, "offline-crash-witness.json"),
          "utf8",
        ),
      );
      expect(witness).toMatchObject({ point, execution: "forked-process" });
      expect(witness.pid).not.toBe(process.pid);
      expect(witness.parentPid).not.toBe(process.pid);
      let ended = false;
      try {
        process.kill(witness.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          ended = true;
        else throw error;
      }
      expect(ended).toBe(true);
      const inspected = await run(
        [
          path.resolve(
            "packages\\project-host\\tests\\offline-crash-inspect.mjs",
          ),
          fixture,
        ],
        { timeout: 10000 },
      );
      expect(inspected.stderr).toBe("");
      expect(JSON.parse(inspected.stdout)).toEqual({
        denied: true,
        unchanged: true,
        pins: 0,
      });
    });
  }, 60000);
}

for (const gap of ["same-bytes-new-inode", "same-length-different-bytes"]) {
  test(`cold native migration backup rejects ${gap}`, async ({ signal }) => {
    await withOwnedProbe(signal, async (root, run) => {
      const result = await run(
        [
          path.resolve("node_modules\\vitest\\vitest.mjs"),
          "run",
          "--project",
          "unit",
          "packages\\application\\tests\\reference-acquisition.test.ts",
          "-t",
          `^native migration backup rejects ${gap}$`,
          "--reporter=dot",
        ],
        {
          timeout: 60000,
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATH: path.dirname(process.execPath),
            TEMP: root,
            TMP: root,
            DESIGN_STUDIO_SYNTHETIC_RETAINED_NATIVE: "1",
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("1 passed");
    });
  }, 60000);
}

test("retains a failed fresh backup pin close for explicit ownership cleanup", async () => {
  await ownedTest(async (root) => {
    const native = await loadNative();
    const filename = path.join(root, "backup.sqlite.pending");
    native.createFile(
      filename,
      native.principal(),
      Buffer.from("synthetic backup"),
    );
    const pins = new Set<ReadLease>();
    const original = native.pinRead.bind(native);
    let calls = 0;
    const spy = vi.spyOn(native, "pinRead").mockImplementation((...args) => {
      const lease = original(...args);
      if (++calls !== 2) return lease;
      let failed = false;
      return {
        ...lease,
        close() {
          if (!failed) {
            failed = true;
            throw new Error("Synthetic fresh backup close failure.");
          }
          lease.close();
        },
      };
    });
    try {
      await expect(
        pinReferenceBackupFile(filename, {
          owner: {},
          sid: native.principal(),
          retainedPins: pins,
          current: async () => {},
        }),
      ).rejects.toThrow("Synthetic fresh backup close failure");
      expect(pins.size).toBe(1);
    } finally {
      spy.mockRestore();
      for (const lease of [...pins]) {
        lease.close();
        pins.delete(lease);
      }
    }
    expect(pins.size).toBe(0);
  });
});

test("explicit current-owner fixture reads host stage and publication without changing DACLs, bytes or identities", async () => {
  await ownedTest(async (root, _own, beforeCleanup) => {
    const owner = await declaredOwnerFixture(root);
    beforeCleanup(() => owner.close());
    const native = await loadNative();
    const sid = native.principal();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, sid);
    const context = syntheticContext();
    context.authorization.grants.push({
      resourceKind: "artifact",
      resourceId: "artifacts",
      operations: ["read", "write"],
    });
    const fs = await ProjectFileSystem.create({
      projectId: context.projectId,
      authority: () => true,
      publicationProfile: WINDOWS_PUBLICATION_PROFILE,
      roots: [
        {
          id: "artifacts",
          path: artifacts,
          access: "read-write",
          trustedExclusiveAccess: true,
          managedBlobs: true,
        },
      ],
    });
    const retainedPins = new Set<ReadLease>();
    const pin = (relative: string, directory = false) =>
      pinRetainedReferenceEntry({
        root: artifacts,
        relative,
        directory,
        sid,
        retainedPins,
        authorize: async () => {
          const check = native.inspect(artifacts, true, sid);
          check.close();
        },
      });
    try {
      const bytes = Buffer.from(
        "Owned synthetic stage and same-inode publication.",
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      const staged = await fs.stage(
        { artifactRootId: "artifacts", path: `blobs/${hash}` },
        bytes,
        context,
      );
      expect(staged.status).toBe("complete");
      if (staged.status !== "complete")
        throw new Error("Synthetic stage failed.");
      await owner.prepare();
      const host = (await readdir(artifacts)).find((name) =>
        name.startsWith(".host-"),
      );
      expect(host).toBeDefined();
      const relative = `${host}/${staged.value.stagingId}`;
      const filename = path.join(artifacts, ...relative.split("/"));
      const before = await lstat(filename);
      const security = await retainedSecurityFixture(root, filename);
      const acl = await security.snapshot();
      for (const [relativePath, directory] of [
        [host, true],
        ["blobs", true],
        [relative, false],
      ] as const) {
        if (!relativePath) throw new Error("Missing synthetic host directory.");
        expect(() =>
          native.pinRead(
            path.join(artifacts, ...relativePath.split("/")),
            directory,
            sid,
          ),
        ).toThrow(/protected/);
        expect(() =>
          native.inspect(
            path.join(artifacts, ...relativePath.split("/")),
            directory,
            sid,
          ),
        ).toThrow(/protected/);
        expect(() =>
          Reflect.apply(native.pinRead, native, [
            path.join(artifacts, ...relativePath.split("/")),
            directory,
            sid,
            false,
            false,
            () => {
              throw new Error("Caller validator must never run.");
            },
          ]),
        ).toThrow(/protected/);
        const admitted = await pin(relativePath, directory);
        try {
          await admitted.check();
          if (!directory) {
            const buffer = Buffer.alloc(bytes.length);
            expect(admitted.read(buffer)).toBe(bytes.length);
            expect(buffer).toEqual(bytes);
            await expect(writeFile(filename, bytes)).rejects.toThrow();
            await expect(rm(filename)).rejects.toThrow();
            await expect(
              rename(filename, `${filename}.moved`),
            ).rejects.toThrow();
            await expect(
              rename(path.dirname(filename), `${path.dirname(filename)}.moved`),
            ).rejects.toThrow();
            await expect(
              rename(artifacts, `${artifacts}.moved`),
            ).rejects.toThrow();
            const replacement = `${filename}.replacement`;
            native.createFile(replacement, sid, bytes);
            try {
              await expect(rename(replacement, filename)).rejects.toThrow();
              expect((await lstat(filename)).ino).toBe(before.ino);
            } finally {
              await rm(replacement);
            }
          }
        } finally {
          admitted.close();
        }
      }
      expect(await security.snapshot()).toEqual(acl);
      const published = await fs.publish(staged.value, context);
      expect(published.status).toBe("complete");
      if (published.status !== "complete")
        throw new Error("Synthetic publication failed.");
      const target = path.join(artifacts, ...published.value.path.split("/"));
      const after = await lstat(target);
      expect([after.dev, after.ino, after.nlink]).toEqual([
        before.dev,
        before.ino,
        1,
      ]);
      expect(
        await (await retainedSecurityFixture(root, target)).snapshot(),
      ).toEqual(acl);
      const names = await readdir(path.dirname(target));
      const admitted = await pin(published.value.path);
      try {
        await admitted.check();
        expect(await readFile(target)).toEqual(bytes);
      } finally {
        admitted.close();
      }
      expect(await readdir(path.dirname(target))).toEqual(names);
      expect(await readFile(target)).toEqual(bytes);
      const control = path.join(artifacts, "control");
      native.createFile(control, sid, bytes);
      const strict = native.pinRead(control, false, sid);
      strict.close();
      const protectedLeaf = await pin("control");
      protectedLeaf.close();
      expect(retainedPins.size).toBe(0);
    } finally {
      for (const pin of retainedPins) pin.close();
      await fs.closePreservingStages();
    }
  });
});

test.each([
  "extra-allow",
  "inherited-untrusted",
  "deny",
  "mask",
  "extended-mask-input",
  "inherit-only",
  "no-propagate",
  "creator-owner",
  "null",
  "protected-parent",
  "parent-flags",
  "parent-security",
  "root-security",
  "hardlink",
  "junction",
] as const)(
  "retained native chain enforces exact synthetic security profiles: %s",
  async (kind) => {
    await ownedTest(async (root, _own, beforeCleanup) => {
      const owner = await declaredOwnerFixture(root);
      beforeCleanup(() => owner.close());
      const native = await loadNative();
      const sid = native.principal();
      const artifacts = path.join(root, "artifacts");
      native.createDirectory(artifacts, sid);
      const parent = path.join(artifacts, "blobs");
      await mkdir(parent);
      const filename = path.join(parent, "body");
      await writeFile(filename, "synthetic");
      await owner.prepare();
      const retainedPins = new Set<ReadLease>();
      const parentCase = [
        "protected-parent",
        "parent-flags",
        "parent-security",
      ].includes(kind);
      const security = await retainedSecurityFixture(
        root,
        kind === "root-security" ? artifacts : parentCase ? parent : filename,
      );
      let changed = false;
      let normalizedExtendedMask = false;
      try {
        const normal = `(A;ID;FA;;;${sid})(A;ID;FA;;;SY)`;
        const profiles: Partial<Record<typeof kind, string>> = {
          "extra-allow": `D:${normal}(A;;FR;;;${sid})`,
          "inherited-untrusted": `D:${normal}(A;ID;FA;;;WD)`,
          deny: `D:(D;;FW;;;WD)${normal}`,
          mask: `D:(A;ID;0x1f01fe;;;${sid})(A;ID;FA;;;SY)`,
          "extended-mask-input": `D:P(A;;0x021f01ff;;;${sid})(A;;FA;;;SY)`,
          "inherit-only": `D:(A;IDIO;FA;;;${sid})(A;ID;FA;;;SY)`,
          "no-propagate": `D:(A;IDNP;FA;;;${sid})(A;ID;FA;;;SY)`,
          "creator-owner": "D:(A;ID;FA;;;CO)(A;ID;FA;;;SY)",
          null: "D:NO_ACCESS_CONTROL",
          "protected-parent": `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,
          "parent-flags": `D:(A;IDCI;FA;;;${sid})(A;IDCI;FA;;;SY)`,
          "parent-security": `D:(A;OICIID;FA;;;${sid})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;WD)`,
          "root-security": "D:P(A;OICI;FA;;;WD)",
        };
        const profile = profiles[kind];
        if (profile) {
          await security.set(
            profile,
            [
              "protected-parent",
              "root-security",
              "extended-mask-input",
            ].includes(kind),
          );
          changed = true;
          const actual = await security.profile();
          expect(actual.owner).toBe(sid);
          if (
            ["extra-allow", "inherited-untrusted", "parent-security"].includes(
              kind,
            )
          )
            expect(actual.aces.length).toBeGreaterThan(2);
          if (
            [
              "inherited-untrusted",
              "parent-security",
              "root-security",
            ].includes(kind)
          )
            expect(
              actual.aces.some(
                (ace) => ace.sid === "S-1-1-0" && ace.mask === 0x1f01ff,
              ),
            ).toBe(true);
          if (kind === "deny")
            expect(actual.aces.some((ace) => ace.type === 1)).toBe(true);
          if (kind === "mask")
            expect(actual.aces.some((ace) => ace.mask === 0x1f01fe)).toBe(true);
          if (kind === "inherit-only")
            expect(actual.aces.some((ace) => (ace.flags & 8) !== 0)).toBe(true);
          if (kind === "no-propagate")
            expect(actual.aces.some((ace) => (ace.flags & 4) !== 0)).toBe(true);
          if (kind === "creator-owner")
            expect(actual.aces.some((ace) => ace.sid === "S-1-3-0")).toBe(true);
          if (kind === "null") expect(actual.nullDacl).toBe(true);
          if (kind === "parent-flags")
            expect(actual.aces.some((ace) => ace.flags !== 0x13)).toBe(true);
          if (kind === "protected-parent") {
            expect(actual.protected).toBe(true);
            expect(actual.aces).toHaveLength(2);
            expect(
              actual.aces.every(
                (ace) =>
                  ace.type === 0 && ace.flags === 3 && ace.mask === 0x1f01ff,
              ),
            ).toBe(true);
          }
          if (kind === "extended-mask-input") {
            expect(actual.protected).toBe(true);
            expect(actual.aces).toHaveLength(2);
            expect(actual.aces.map((ace) => ace.sid).sort()).toEqual(
              [sid, "S-1-5-18"].sort(),
            );
            expect(
              actual.aces.every((ace) => ace.type === 0 && ace.flags === 0),
            ).toBe(true);
            // Windows may normalize unsupported rights beyond FullControl.
            // Only the exact effective profile may be admitted, not arbitrary SDDL.
            normalizedExtendedMask = actual.aces.every(
              (ace) => ace.mask === 0x1f01ff,
            );
          }
        }
        if (kind === "hardlink")
          await link(filename, path.join(parent, "second"));
        if (kind === "junction") {
          await rename(parent, path.join(artifacts, "real"));
          await symlink(path.join(artifacts, "real"), parent, "junction");
        }
        const admission = pinRetainedReferenceEntry({
          root: artifacts,
          relative: "blobs/body",
          directory: false,
          sid,
          retainedPins,
          authorize: async () => {},
        });
        if (normalizedExtendedMask) {
          const admitted = await admission;
          try {
            await admitted.check();
          } finally {
            admitted.close();
          }
        } else await expect(admission).rejects.toThrow();
        expect(retainedPins.size).toBe(0);
      } finally {
        for (const pin of retainedPins) pin.close();
        if (changed) await security.restore();
        if (kind === "junction") await rm(parent);
      }
    });
  },
);

test("retained native brands reject forged, closed, cross-root and caller-path inputs and recheck current security", async () => {
  await ownedTest(async (root, _own, beforeCleanup) => {
    const owner = await declaredOwnerFixture(root);
    beforeCleanup(() => owner.close());
    const native = await loadNative();
    const sid = native.principal();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, sid);
    await mkdir(path.join(artifacts, "blobs"));
    const filename = path.join(artifacts, "blobs", "body");
    await writeFile(filename, "synthetic");
    await owner.prepare();
    const first = native.pinRetainedRoot(artifacts, sid);
    try {
      expect(() => native.pinRetainedRoot(artifacts, "S-1-5-18")).toThrow(
        /principal/,
      );
      expect(() =>
        native.pinRetainedChild({ ...first }, "blobs", true),
      ).toThrow(/branded/);
      for (const name of [
        "..",
        ".",
        "blobs/body",
        "..\\other",
        "body:stream",
        "body.",
        artifacts,
      ])
        expect(() => native.pinRetainedChild(first, name, true)).toThrow();
      const directory = native.pinRetainedChild(first, "blobs", true);
      const leaf = native.pinRetainedChild(directory, "body", false);
      try {
        const security = await retainedSecurityFixture(root, filename);
        try {
          await security.set("D:P(A;;FA;;;WD)", true);
          expect(() => leaf.check()).toThrow();
          expect(() => leaf.read(Buffer.alloc(16))).toThrow();
        } finally {
          await security.restore();
        }
        leaf.check();
        directory.close();
        expect(() => leaf.check()).toThrow(/closed/);
      } finally {
        leaf.close();
        directory.close();
      }
    } finally {
      first.close();
    }
    expect(() => native.pinRetainedChild(first, "blobs", true)).toThrow(
      /closed/,
    );
  });
});

test.each([
  "authority",
  "parent-security",
  "admission-close",
  "close",
] as const)(
  "retained read ownership survives cancellation, revocation and failed cleanup: %s",
  async (kind) => {
    await ownedTest(async (root, _own, beforeCleanup) => {
      const owner = await declaredOwnerFixture(root);
      beforeCleanup(() => owner.close());
      const native = await loadNative();
      const sid = native.principal();
      const artifacts = path.join(root, "artifacts");
      native.createDirectory(artifacts, sid);
      await mkdir(path.join(artifacts, "blobs"));
      await writeFile(path.join(artifacts, "blobs", "body"), "synthetic");
      await owner.prepare();
      const retainedPins = new Set<ReadLease>();
      let allowed = true;
      let failClose = kind === "close" || kind === "admission-close";
      const original = native.pinRetainedChild.bind(native);
      const spy = vi
        .spyOn(native, "pinRetainedChild")
        .mockImplementation((...args) => {
          const pin = original(...args);
          if (args[2]) return pin;
          if (kind === "admission-close") allowed = false;
          return {
            ...pin,
            close() {
              if (failClose) {
                failClose = false;
                throw new Error("Synthetic owned native close failed.");
              }
              pin.close();
            },
          };
        });
      const admit = () =>
        pinRetainedReferenceEntry({
          root: artifacts,
          relative: "blobs/body",
          directory: false,
          sid,
          retainedPins,
          authorize: async () => {
            if (!allowed)
              throw new HostBoundaryError(
                "ACTION_REQUIRED",
                "Synthetic current authority cancelled.",
              );
          },
        });
      try {
        if (kind === "admission-close") {
          await expect(admit()).rejects.toMatchObject({
            code: "ACTION_REQUIRED",
            message: "Retained descendant admission and cleanup failed.",
            cause: expect.any(AggregateError),
          });
          expect(retainedPins.size).toBe(1);
        } else {
          const lease = await admit();
          try {
            if (kind === "authority") {
              allowed = false;
              await expect(lease.check()).rejects.toThrow(/cancelled/);
            } else if (kind === "parent-security") {
              const security = await retainedSecurityFixture(
                root,
                path.join(artifacts, "blobs"),
              );
              try {
                await security.set("D:P(A;OICI;FA;;;WD)", true);
                await expect(lease.check()).rejects.toThrow();
              } finally {
                await security.restore();
              }
            } else {
              expect(() => lease.close()).toThrow(/did not close/);
              expect(retainedPins.size).toBe(1);
              await expect(lease.check()).rejects.toThrow(/closed/);
            }
          } finally {
            lease.close();
          }
        }
      } finally {
        spy.mockRestore();
        for (const pin of [...retainedPins]) {
          pin.close();
          retainedPins.delete(pin);
        }
      }
      expect(retainedPins.size).toBe(0);
    });
  },
);

test("retained admission binds current registered root identity rather than an identical replacement tree", async () => {
  await ownedTest(async (root) => {
    const native = await loadNative();
    const sid = native.principal();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, sid);
    const registered = native.inspect(artifacts, true, sid);
    const identity = { ...registered.identity };
    registered.close();
    await rename(artifacts, path.join(root, "prior"));
    native.createDirectory(artifacts, sid);
    await mkdir(path.join(artifacts, "blobs"));
    await writeFile(
      path.join(artifacts, "blobs", "body"),
      "same synthetic bytes",
    );
    const retainedPins = new Set<ReadLease>();
    await expect(
      pinRetainedReferenceEntry({
        root: artifacts,
        relative: "blobs/body",
        directory: false,
        sid,
        retainedPins,
        authorize: async () => {
          const current = native.inspect(artifacts, true, sid);
          try {
            if (
              current.identity.file !== identity.file ||
              current.identity.volume !== identity.volume
            )
              throw new HostBoundaryError(
                "ACTION_REQUIRED",
                "Synthetic registered root identity changed.",
              );
          } finally {
            current.close();
          }
        },
      }),
    ).rejects.toThrow(/registered root identity/);
    expect(retainedPins.size).toBe(0);
  });
});

test
  .skipIf(process.platform !== "win32")
  .each(["authority", "security", "fresh-close"] as const)(
  "immutable native database pins recheck current authority and retain cleanup ownership: %s",
  async (kind) => {
    await ownedTest(async (root) => {
      const native = await loadNative();
      const sid = native.principal();
      const owned = path.join(root, "immutable");
      native.createDirectory(owned, sid);
      const filename = path.join(owned, "main.sqlite");
      const bytes = Buffer.from(
        "synthetic native pin identity; SQLite tested separately",
      );
      native.createFile(filename, sid, bytes);
      const retainedPins = new Set<ReadLease>();
      let allowed = true;
      const snapshot = await pinImmutableReferenceDatabase({
        filename,
        sid,
        authoritySha256: "a".repeat(64),
        retainedPins,
        authorize: async () => {
          if (!allowed) throw new Error("Synthetic current authority revoked");
          const parent = native.inspect(owned, true, sid);
          parent.close();
        },
      });
      let restoreSecurity = false;
      try {
        if (kind === "authority") {
          allowed = false;
          await expect(snapshot.check()).rejects.toThrow(/authority revoked/);
          allowed = true;
        } else if (kind === "security") {
          await weakenTestAcl(root, filename);
          restoreSecurity = true;
          await expect(snapshot.check()).rejects.toThrow();
        } else {
          const original = native.pinRead.bind(native);
          let failed = false;
          const spy = vi
            .spyOn(native, "pinRead")
            .mockImplementation((...args) => {
              const pin = original(...args);
              return {
                ...pin,
                close: () => {
                  if (!failed) {
                    failed = true;
                    throw new Error("Synthetic fresh native pin close failed");
                  }
                  pin.close();
                },
              };
            });
          try {
            await expect(snapshot.check()).rejects.toThrow(
              /fresh native pin close failed/,
            );
            expect(retainedPins.size).toBe(3);
            snapshot.close();
            expect(retainedPins.size).toBe(1);
          } finally {
            spy.mockRestore();
          }
        }
      } finally {
        if (restoreSecurity) await weakenTestAcl(root, filename, false, true);
        snapshot.close();
        for (const pin of [...retainedPins]) {
          pin.close();
          retainedPins.delete(pin);
        }
      }
      expect(retainedPins.size).toBe(0);
      expect(await readFile(filename)).toEqual(bytes);
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "owned native installation entries seal readonly and never adopt existing entries",
  async () => {
    await ownedTest(async (root) => {
      const native = await loadNative();
      const sid = native.principal();
      const directory = native.createInstallationEntry(
        path.join(root, "candidate"),
        true,
        sid,
      );
      const filename = path.join(directory.identity.path, "module.js");
      const file = native.createInstallationEntry(filename, false, sid);
      try {
        try {
          file.write(Buffer.from("export default 42;"));
          file.finalize();
          expect(() => file.write(Buffer.of(0))).toThrow(/finalized/);
          expect(() =>
            native.createInstallationEntry(filename, false, sid),
          ).toThrow();
        } finally {
          file.close();
        }
        try {
          directory.finalize();
        } finally {
          directory.close();
        }
        const read = native.pinInstallation(filename, false, sid);
        try {
          const buffer = Buffer.alloc(100);
          expect(buffer.subarray(0, read.read(buffer)).toString()).toBe(
            "export default 42;",
          );
          await expect(writeFile(filename, "tampered")).rejects.toThrow();
          await expect(
            mkdir(path.join(directory.identity.path, "extra")),
          ).rejects.toThrow();
        } finally {
          read.close();
        }
      } finally {
        file.close();
        directory.close();
        const check = native.inspect(filename, false);
        try {
          expect(check.identity).toEqual(file.identity);
          const parentCheck = native.inspect(directory.identity.path, true);
          try {
            expect(parentCheck.identity).toEqual(directory.identity);
          } finally {
            parentCheck.close();
          }
          await weakenTestAcl(root, filename, false, true);
          await weakenTestAcl(root, directory.identity.path, false, true);
        } finally {
          check.close();
        }
      }
    });
  },
);
