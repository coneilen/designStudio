import { expect, it } from "vitest";
import {
  NapiCredentialBackend,
  nativeVaultCapability,
} from "../src/native-vault.js";
import { deferred } from "./deferred.js";

it("maps only exact configured references to native byte reads without enumeration or write calls", async () => {
  const reference = {
    id: "ref_one",
    providerId: "provider_one",
    store: "windows-credential-manager",
  } as const;
  const calls: string[] = [];
  const backend = new NapiCredentialBackend({
    platform: "win32",
    entries: [
      {
        reference,
        service: "synthetic-owned-service",
        account: "synthetic-account",
      },
    ],
    load: async () => ({
      AsyncEntry: class {
        constructor(service: string, account: string) {
          calls.push(`${service}:${account}`);
        }
        async getSecret() {
          return Uint8Array.of(1, 2, 3);
        }
      },
    }),
  });
  expect(await backend.read(reference, new AbortController().signal)).toEqual(
    Uint8Array.of(1, 2, 3),
  );
  expect(calls).toEqual(["synthetic-owned-service:synthetic-account"]);
  await expect(
    backend.read({ ...reference, id: "other" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(calls).toHaveLength(1);
});

it("native absence, missing entries and unsupported host are explicit, with no fallback", async () => {
  const reference = {
    id: "ref_one",
    providerId: "provider_one",
    store: "macos-keychain",
  } as const;
  const entries = [{ reference, service: "synthetic", account: "synthetic" }];
  const missing = new NapiCredentialBackend({
    platform: "darwin",
    entries,
    load: async () => {
      throw new Error("binding missing");
    },
  });
  await expect(
    missing.read(reference, new AbortController().signal),
  ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  const empty = new NapiCredentialBackend({
    platform: "darwin",
    entries,
    load: async () => ({
      AsyncEntry: class {
        async getSecret() {
          return undefined;
        }
      },
    }),
  });
  await expect(
    empty.read(reference, new AbortController().signal),
  ).rejects.toMatchObject({ code: "RESOURCE_UNRESOLVED" });
  expect(
    () => new NapiCredentialBackend({ platform: "linux", entries }),
  ).toThrow(/unsupported/i);
  await expect(
    empty.read(reference, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

it("only loads the real installed native module for capability evidence; never constructs an entry", async () => {
  expect(await nativeVaultCapability()).toMatchObject({
    available: true,
    host: process.platform,
    evidence: "module-load-only",
  });
});

it("does not pass abort wrappers to native reads and owns late bytes until actual settlement", async () => {
  const reference = {
    id: "late_ref",
    providerId: "provider_one",
    store: "windows-credential-manager",
  } as const;
  const entered = deferred<void>();
  const native = deferred<Uint8Array>();
  const controller = new AbortController();
  const backend = new NapiCredentialBackend({
    platform: "win32",
    entries: [
      { reference, service: "synthetic-owned", account: "synthetic-only" },
    ],
    load: async () => ({
      AsyncEntry: class {
        async getSecret(...args: unknown[]) {
          expect(args).toEqual([]);
          entered.resolve();
          return native.promise;
        }
      },
    }),
  });
  const result = backend.read(reference, controller.signal);
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  const bytes = Buffer.from("synthetic-late-native");
  native.resolve(bytes);
  await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});
