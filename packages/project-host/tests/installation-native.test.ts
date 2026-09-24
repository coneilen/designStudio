import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
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
import { pinImmutableReferenceDatabase } from "../src/reference-validation-database.js";
import { pinRetainedReferenceEntry } from "../src/reference-validation-entry.js";
import { withOwnedProbe } from "./owned-probe.js";
import { retainedSecurityFixture } from "./retained-security-fixture.js";
import { ownedTest, weakenTestAcl } from "./support.js";

test("cold-native retained-validation integration uses actual host history and production descendant pins", async ({
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
        "--reporter=verbose",
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
    expect(result.stdout).toContain(
      "retained-native-history: real native pins; strict inherited denial; private=5698604; physical=5698575; eof=29; network=0; pins=0",
    );
  });
}, 60000);

test("retained native admission reads actual host stage and publication without changing bytes, ACLs or identities", async () => {
  await ownedTest(async (root) => {
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
    await ownedTest(async (root) => {
      const native = await loadNative();
      const sid = native.principal();
      const artifacts = path.join(root, "artifacts");
      native.createDirectory(artifacts, sid);
      const parent = path.join(artifacts, "blobs");
      await mkdir(parent);
      const filename = path.join(parent, "body");
      await writeFile(filename, "synthetic");
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
  await ownedTest(async (root) => {
    const native = await loadNative();
    const sid = native.principal();
    const artifacts = path.join(root, "artifacts");
    native.createDirectory(artifacts, sid);
    await mkdir(path.join(artifacts, "blobs"));
    const filename = path.join(artifacts, "blobs", "body");
    await writeFile(filename, "synthetic");
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
    await ownedTest(async (root) => {
      const native = await loadNative();
      const sid = native.principal();
      const artifacts = path.join(root, "artifacts");
      native.createDirectory(artifacts, sid);
      await mkdir(path.join(artifacts, "blobs"));
      await writeFile(path.join(artifacts, "blobs", "body"), "synthetic");
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
