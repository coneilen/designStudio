import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadNative, type ReadLease } from "../src/native.js";
import { pinImmutableReferenceDatabase } from "../src/reference-validation-database.js";
import { ownedTest, weakenTestAcl } from "./support.js";

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
