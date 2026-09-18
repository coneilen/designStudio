import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadNative } from "../src/native.js";
import { ownedTest, weakenTestAcl } from "./support.js";

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
