import { lstat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  captureProjectOwner,
  openCaptureProject,
} from "../src/capture-project.js";
import { loadNative } from "../src/native.js";
import {
  captureInstallationSuite,
  withCaptureInstallation,
} from "./capture-support.js";

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor() {
      throw new Error("Fixture lifecycle tests forbid real credential access");
    }
  },
}));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.skipIf(process.platform !== "win32")(
  "joins cancelled suite startup without late fixture work or native override loss",
  async () => {
    const native = await loadNative();
    const folder = native.localAppData;
    const entries = native.createInstallationEntry;
    const fixture = captureInstallationSuite();
    const starting = expect(fixture.start()).rejects.toMatchObject({
      cause: { name: "AbortError" },
    });
    const closing = expect(fixture.close()).rejects.toThrow();
    await Promise.all([starting, closing]);
    expect(native.localAppData).toBe(folder);
    expect(native.createInstallationEntry).toBe(entries);
    await expect(fixture.prepare(async () => {})).rejects.toThrow(
      /unavailable/,
    );
  },
);

describe
  .skipIf(process.platform !== "win32")
  .each(["failed preparation", "cancelled test work"] as const)(
  "native suite ownership after %s",
  (scenario) => {
    const fixture = captureInstallationSuite();
    let native: Awaited<ReturnType<typeof loadNative>>;
    let folder: typeof native.localAppData;
    let entries: typeof native.createInstallationEntry;
    let root: string;
    beforeAll(async () => {
      native = await loadNative();
      folder = native.localAppData;
      entries = native.createInstallationEntry;
      ({ root } = await fixture.start());
    });
    afterAll(() => fixture.close());
    it("joins pending work before restoring overrides or removing its exact temporary root", async ({
      signal,
    }) => {
      const entered = gate();
      const unblock = gate();
      const abort = new AbortController();
      const release = () => {
        abort.abort();
        unblock.release();
      };
      signal.addEventListener("abort", release, { once: true });
      const failure = new Error("Synthetic beforeAll preparation failure");
      const work =
        scenario === "failed preparation"
          ? fixture.prepare(async () => {
              entered.release();
              await unblock.promise;
              expect(native.localAppData()).toBe(root);
              throw failure;
            })
          : fixture.run(async (installation) => {
              const project = await openCaptureProject(installation);
              try {
                entered.release();
                await unblock.promise;
                expect(native.localAppData()).toBe(root);
                await expect(
                  captureProjectOwner(project).journal.begin(
                    "status",
                    abort.signal,
                  ),
                ).rejects.toMatchObject({ code: "CANCELLED" });
              } finally {
                await project.close();
              }
            });
      const observed =
        scenario === "failed preparation"
          ? expect(work).rejects.toBe(failure)
          : work;
      let closing: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, work]);
        abort.abort(new Error("Synthetic runner cancellation"));
        let closed = false;
        closing = fixture.close().then(() => {
          closed = true;
        });
        await setImmediate();
        expect(closed).toBe(false);
        expect(native.localAppData()).toBe(root);
        expect(native.createInstallationEntry).not.toBe(entries);
        expect((await lstat(root)).isDirectory()).toBe(true);
        const other = vi.fn(async () => {});
        await expect(withCaptureInstallation(other)).rejects.toThrow(
          /still owns native overrides/,
        );
        expect(other).not.toHaveBeenCalled();
        await expect(fixture.prepare(other)).rejects.toThrow(/unavailable/);
      } finally {
        release();
        try {
          await observed;
        } finally {
          await closing;
          signal.removeEventListener("abort", release);
        }
      }
      expect(native.localAppData).toBe(folder);
      expect(native.createInstallationEntry).toBe(entries);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
