import * as fs from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  closePortablePins,
  type PortablePinOwner,
  portableRetainedPin,
} from "./portable-retained-pin.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
}));
const owners = new Set<PortablePinOwner>();
const roots: string[] = [];
afterEach(async () => {
  closePortablePins(owners);
  expect(owners.size).toBe(0);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "portable-retained-pin-"));
  roots.push(root);
  const filename = path.join(root, "source.bin");
  const bytes = Buffer.from("synthetic retained bytes");
  await writeFile(filename, bytes, { flag: "wx" });
  return { root, filename, bytes };
}

it("acquires readonly ownership before returning a proof baseline without consuming bytes", async () => {
  const { filename, bytes } = await fixture();
  const events: string[] = [];
  const open = fs.openSync,
    stat = fs.fstatSync;
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    expect(args[1]).toBe(
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const fd = open(...args);
    events.push("opened");
    return fd;
  });
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    events.push("opened-stat");
    return stat(...args);
  });
  const read = vi.spyOn(fs, "readSync");
  const close = vi.spyOn(fs, "closeSync");
  const pin = portableRetainedPin(filename, false, owners);
  events.push("returned");
  expect(events).toEqual(["opened", "opened-stat", "returned"]);
  expect(read).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(owners.size).toBe(1);
  const baseline = fs.lstatSync(filename, { bigint: true });
  expect(pin.identity.file).toBe(String(baseline.ino));
  const actual = Buffer.alloc(bytes.length);
  expect(fs.readSync(pin.handle, actual, 0, actual.length, null)).toBe(
    bytes.length,
  );
  expect(actual).toEqual(bytes);
  await pin.check();
  pin.close();
  pin.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(owners.size).toBe(0);
  expect(() => fs.fstatSync(pin.handle)).toThrow();
  expect(await readFile(filename)).toEqual(bytes);
});

it("retains ownership on close failure until the real descriptor closes exactly once", async () => {
  const { filename } = await fixture();
  const pin = portableRetainedPin(filename, false, owners);
  const close = fs.closeSync;
  let fail = true;
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (fail) {
      fail = false;
      throw new Error("Synthetic descriptor close failure.");
    }
    close(fd);
  });
  expect(() => pin.close()).toThrow("Synthetic descriptor close failure.");
  expect(owners.size).toBe(1);
  expect(fs.fstatSync(pin.handle).isFile()).toBe(true);
  closePortablePins(owners);
  pin.close();
  expect(owners.size).toBe(0);
  expect(() => fs.fstatSync(pin.handle)).toThrow();
});

it.each([false, true])(
  "closes or retains partial acquisition safely, close fails=%s",
  async (closeFails) => {
    const { filename } = await fixture();
    const open = fs.openSync,
      stat = fs.fstatSync,
      close = fs.closeSync;
    let descriptor: number | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      descriptor = open(...args);
      return descriptor;
    });
    vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
      throw new Error("Synthetic acquisition failure.");
    });
    if (closeFails)
      vi.spyOn(fs, "closeSync").mockImplementationOnce(() => {
        throw new Error("Synthetic acquisition close failure.");
      });
    expect(() => portableRetainedPin(filename, false, owners)).toThrow();
    if (descriptor === undefined)
      throw new Error("Descriptor was not acquired.");
    const acquired = descriptor;
    if (closeFails) {
      expect(owners.size).toBe(1);
      expect(stat(descriptor).isFile()).toBe(true);
      closePortablePins(owners);
    }
    expect(owners.size).toBe(0);
    expect(() => stat(acquired)).toThrow();
    expect(() => close(acquired)).toThrow();
  },
);

it("rejects linked or wrong-kind paths before open and treats directories only as observations", async () => {
  const { root, filename } = await fixture();
  await link(filename, path.join(root, "second.bin"));
  const open = vi.spyOn(fs, "openSync");
  expect(() => portableRetainedPin(filename, false, owners)).toThrow(/refused/);
  expect(() => portableRetainedPin(filename, true, owners)).toThrow(/refused/);
  const directory = path.join(root, "directory");
  await mkdir(directory);
  const pin = portableRetainedPin(directory, true, owners);
  expect(pin.handle).toBe(0);
  expect(open).not.toHaveBeenCalled();
  await pin.check();
  pin.close();
  expect(owners.size).toBe(0);
});

it("rejects a changed opened identity and releases the acquired descriptor", async () => {
  const { filename } = await fixture();
  const stat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementationOnce((...args) => {
    const value = stat(...args);
    Object.defineProperty(value, "ino", {
      value: typeof value.ino === "bigint" ? value.ino + 1n : value.ino + 1,
    });
    return value;
  });
  expect(() => portableRetainedPin(filename, false, owners)).toThrow(
    /identity changed/,
  );
  expect(owners.size).toBe(0);
});
