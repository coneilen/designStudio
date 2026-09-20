import { expect, it } from "vitest";
import { OwnedFigmaCredentialAdapter } from "../src/credential-admin-vault.js";
import { NapiCredentialBackend } from "../src/native-vault.js";
import { deferred } from "./deferred.js";

const reference = {
  id: "figma_pat_00000000-0000-4000-8000-000000000001",
  providerId: "figma_rest",
  store: "windows-credential-manager",
} as const;
function adapters(result: () => Promise<unknown>) {
  const load = async () => ({
    AsyncEntry: class {
      getSecret(...args: unknown[]) {
        expect(args).toEqual([]);
        return result();
      }
      async setSecret(): Promise<void> {
        throw new Error("No test mutation allowed");
      }
      async deleteCredential(): Promise<boolean> {
        throw new Error("No test mutation allowed");
      }
    },
  });
  return {
    admin: new OwnedFigmaCredentialAdapter(
      { projectId: "test_project", actorId: "test_actor", reference },
      load,
    ),
    consumer: new NapiCredentialBackend({
      platform: "win32",
      entries: [
        {
          reference,
          service: "synthetic-service",
          account: "synthetic-account",
        },
      ],
      load,
    }),
  };
}
const windows = it.skipIf(process.platform !== "win32");
windows.each([null, undefined])(
  "normalizes only native absence %s; consumer absence still fails",
  async (absent) => {
    const value = adapters(async () => absent);
    expect(await value.admin.read()).toBeUndefined();
    await expect(
      value.consumer.read(reference, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESOURCE_UNRESOLVED" });
  },
);
windows.each([0, 2])(
  "preserves native byte identity, including empty bytes (%i)",
  async (size) => {
    const bytes = new Uint8Array(size);
    const value = adapters(async () => bytes);
    expect(await value.admin.read()).toBe(bytes);
    expect(
      await value.consumer.read(reference, new AbortController().signal),
    ).toBe(bytes);
  },
);
windows.each(
  [
    false,
    0,
    "",
    "synthetic-private-error-material",
    { private: "synthetic-private-error-material" },
    new Uint16Array(1),
    new Uint8Array(new SharedArrayBuffer(2)),
  ].map((result) => ({ result })),
)(
  "refuses invalid native result without treating it as absence",
  async ({ result: invalid }) => {
    const value = adapters(async () => invalid);
    for (const run of [
      () => value.admin.read(),
      () => value.consumer.read(reference, new AbortController().signal),
    ]) {
      const result: unknown = await run().catch((error: unknown) => error);
      expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(result).not.toHaveProperty("cause");
      expect(JSON.stringify(result)).not.toContain(
        "synthetic-private-error-material",
      );
    }
  },
);
windows(
  "withholds rejected native details and never turns a rejection into absence",
  async () => {
    const value = adapters(async () => {
      throw new Error("synthetic-private-error-material");
    });
    for (const run of [
      () => value.admin.read(),
      () => value.consumer.read(reference, new AbortController().signal),
    ]) {
      const result: unknown = await run().catch((error: unknown) => error);
      expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(result).not.toHaveProperty("cause");
    }
  },
);
windows.each([[], [1, 2, 255]].map((input) => ({ input })))(
  "normalizes native arrays at both byte adapters",
  async ({ input }) => {
    const native: number[][] = [];
    const value = adapters(async () => {
      const bytes = [...input];
      native.push(bytes);
      return bytes;
    });
    expect(await value.admin.read()).toEqual(Uint8Array.from(input));
    expect(
      await value.consumer.read(reference, new AbortController().signal),
    ).toEqual(Uint8Array.from(input));
    expect(native.every((bytes) => bytes.every((byte) => byte === 0))).toBe(
      true,
    );
  },
);
windows.each([
  { kind: "null", native: null },
  { kind: "array", native: [65, 66] },
])(
  "late native $kind still observes cancellation and clears mutable data",
  async ({ native }) => {
    const pending = deferred<unknown>();
    const entered = deferred<void>();
    const value = adapters(() => {
      entered.resolve();
      return pending.promise;
    });
    const abort = new AbortController();
    const result = value.consumer.read(reference, abort.signal);
    await entered.promise;
    abort.abort();
    pending.resolve(native);
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    if (Array.isArray(native))
      expect(native.every((byte) => byte === 0)).toBe(true);
  },
);
