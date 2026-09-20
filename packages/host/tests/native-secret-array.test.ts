import { expect, it } from "vitest";
import { normalizeNativeSecret } from "../src/native-secret.js";
import { PAT_MAX_BYTES } from "../src/pat-input.js";

it("copies the measured dense native byte-array form and wipes its original slots", () => {
  const native = [0, 65, 255];
  const bytes = normalizeNativeSecret(native);
  expect(bytes).toEqual(Uint8Array.of(0, 65, 255));
  expect(native).toEqual([0, 0, 0]);
  bytes?.fill(0);
});
it.each(["Buffer", "Uint8Array"] as const)(
  "caps and intrinsically scrubs an oversized %s view, not adjacent bytes",
  (kind) => {
    const backing = new Uint8Array(PAT_MAX_BYTES + 3).fill(65);
    const bytes =
      kind === "Buffer"
        ? Buffer.from(backing.buffer, 1, PAT_MAX_BYTES + 1)
        : new Uint8Array(backing.buffer, 1, PAT_MAX_BYTES + 1);
    let calls = 0;
    for (const name of ["byteLength", "length", "buffer", "fill"])
      Object.defineProperty(bytes, name, {
        get() {
          calls++;
          throw new Error("Do not call shadow property");
        },
      });
    expect(() => normalizeNativeSecret(bytes)).toThrow();
    expect(
      backing.subarray(1, PAT_MAX_BYTES + 2).every((byte) => byte === 0),
    ).toBe(true);
    expect(backing[0]).toBe(65);
    expect(backing[PAT_MAX_BYTES + 2]).toBe(65);
    expect(calls).toBe(0);
  },
);
it.each([0, PAT_MAX_BYTES])(
  "preserves valid typed-byte identity at size %i",
  (size) => {
    for (const bytes of [Buffer.alloc(size), new Uint8Array(size)])
      expect(normalizeNativeSecret(bytes)).toBe(bytes);
  },
);
it("refuses oversized shared views without claiming or performing owned zeroing", () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(PAT_MAX_BYTES + 1)).fill(
    65,
  );
  expect(() => normalizeNativeSecret(bytes)).toThrow();
  expect(bytes.every((byte) => byte === 65)).toBe(true);
});
it("preserves Buffer/Uint8Array identity without invoking a shadowed buffer getter", () => {
  let calls = 0;
  const bytes = Buffer.from("synthetic-only");
  Object.defineProperty(bytes, "buffer", {
    get() {
      calls++;
      throw new Error("Do not invoke");
    },
  });
  expect(normalizeNativeSecret(bytes)).toBe(bytes);
  bytes.fill(0);
  const shared = new Uint8Array(new SharedArrayBuffer(2));
  Object.defineProperty(shared, "buffer", {
    get() {
      calls++;
      return new ArrayBuffer(2);
    },
  });
  expect(() => normalizeNativeSecret(shared)).toThrow();
  expect(calls).toBe(0);
});
it("keeps an empty native array present and enforces the existing array-copy byte cap", () => {
  expect(normalizeNativeSecret([])).toEqual(new Uint8Array());
  const maximum = Array.from({ length: PAT_MAX_BYTES }, () => 65);
  const bytes = normalizeNativeSecret(maximum);
  expect(bytes?.byteLength).toBe(PAT_MAX_BYTES);
  expect(maximum.every((value) => value === 0)).toBe(true);
  bytes?.fill(0);
  const huge: unknown[] = [];
  huge.length = 0xffffffff;
  expect(() => normalizeNativeSecret(huge)).toThrow();
});
it.each([-1, 256, 1.5, Infinity, NaN, "65", false, {}, undefined])(
  "rejects malformed indexed native data and scrubs bounded mutable slots",
  (invalid) => {
    const native = [65, invalid, 66];
    expect(() => normalizeNativeSecret(native)).toThrow();
    expect(native).toEqual([0, 0, 0]);
  },
);
it("never invokes indexed accessors, inherited values or a custom iterator", () => {
  let calls = 0;
  const accessor = [65, 66];
  Object.defineProperty(accessor, "1", {
    get() {
      calls++;
      return 66;
    },
    configurable: true,
  });
  expect(() => normalizeNativeSecret(accessor)).toThrow();
  expect(accessor[0]).toBe(0);
  const inherited = new Array(2);
  inherited[1] = 66;
  Object.setPrototypeOf(
    inherited,
    Object.create(Array.prototype, {
      "0": {
        get() {
          calls++;
          return 65;
        },
      },
    }),
  );
  expect(() => normalizeNativeSecret(inherited)).toThrow();
  expect(Object.hasOwn(inherited, "0")).toBe(false);
  expect(inherited[1]).toBe(0);
  const iterator = [65];
  Object.defineProperty(iterator, Symbol.iterator, {
    get() {
      calls++;
      throw new Error("Do not invoke");
    },
  });
  expect(() => normalizeNativeSecret(iterator)).toThrow();
  expect(iterator[0]).toBe(0);
  expect(calls).toBe(0);
});
it("rejects holes, nonwritable slots, extras and array-like objects without coercion", () => {
  const sparse: unknown[] = new Array(3);
  sparse[0] = 65;
  sparse[2] = 66;
  expect(() => normalizeNativeSecret(sparse)).toThrow();
  expect(sparse[0]).toBe(0);
  expect(sparse[2]).toBe(0);
  expect(Object.hasOwn(sparse, "1")).toBe(false);
  const fixed = [65, 66];
  Object.defineProperty(fixed, "1", { writable: false, configurable: false });
  expect(() => normalizeNativeSecret(fixed)).toThrow();
  expect(fixed[0]).toBe(0);
  const extra = [65];
  Object.defineProperty(extra, "extra", { value: "synthetic-private-value" });
  expect(() => normalizeNativeSecret(extra)).toThrow();
  expect(extra[0]).toBe(0);
  expect(() => normalizeNativeSecret({ 0: 65, length: 1 })).toThrow();
});
it("refuses proxies before inspecting their traps", () => {
  let calls = 0;
  const proxy = new Proxy([65], {
    get() {
      calls++;
      throw new Error("Do not inspect");
    },
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error("Do not inspect");
    },
    getPrototypeOf() {
      calls++;
      throw new Error("Do not inspect");
    },
    ownKeys() {
      calls++;
      throw new Error("Do not inspect");
    },
  });
  expect(() => normalizeNativeSecret(proxy)).toThrow();
  expect(calls).toBe(0);
  const revoked = Proxy.revocable([65], {});
  revoked.revoke();
  expect(() => normalizeNativeSecret(revoked.proxy)).toThrow();
});
