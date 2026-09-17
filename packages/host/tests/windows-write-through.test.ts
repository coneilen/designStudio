import { expect, it } from "vitest";
import { OwnedWriteThroughProbe } from "./windows-write-through.probe.js";

const nativeTest =
  process.platform === "win32" && ["x64", "arm64"].includes(process.arch)
    ? it
    : it.skip;

nativeTest(
  "loads the shipped prebuild and issues same-handle NTFS write-through/no-replace rename plus flush",
  async () => {
    const probe = await OwnedWriteThroughProbe.create();
    try {
      await probe.write("source \u03bb.bin", Uint8Array.from([0, 255, 13, 10]));
      const evidence = await probe.rename(
        "source \u03bb.bin",
        "published \u96ea.bin",
      );
      expect(evidence).toMatchObject({
        filesystem: "NTFS",
        openFlags: 0x80200000,
        shareMode: 0,
        renameClass: 3,
        replaceIfExists: false,
        preflush: true,
        rename: true,
        postflush: true,
        handleClosed: true,
        guarantee: "documented-ntfs-write-through-request-not-power-cut-tested",
      });
      expect(await probe.read("published \u96ea.bin")).toEqual(
        Uint8Array.from([0, 255, 13, 10]),
      );
      expect(await probe.exists("source \u03bb.bin")).toBe(false);
      expect(probe.openHandleCount).toBe(0);
    } finally {
      await probe.close();
    }
  },
);

nativeTest(
  "native no-replace failure preserves both owned files and closes the handle",
  async () => {
    const probe = await OwnedWriteThroughProbe.create();
    try {
      await probe.write("first.bin", Uint8Array.of(1));
      await probe.write("existing.bin", Uint8Array.of(2));
      await expect(
        probe.rename("first.bin", "existing.bin"),
      ).rejects.toMatchObject({ operation: "rename", win32Code: 183 });
      expect(await probe.read("first.bin")).toEqual(Uint8Array.of(1));
      expect(await probe.read("existing.bin")).toEqual(Uint8Array.of(2));
      expect(probe.openHandleCount).toBe(0);
      await expect(probe.rename("../outside", "no.bin")).rejects.toThrow(
        /path|owned/i,
      );
      await expect(probe.rename("unknown.bin", "no.bin")).rejects.toThrow(
        /owned/i,
      );
    } finally {
      await probe.close();
    }
  },
);
