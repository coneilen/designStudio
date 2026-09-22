import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import { openCaptureCredentials } from "../src/capture-credentials.js";
import {
  CAPTURE_PROFILE,
  capturePolicyBytes,
  validateCapturePolicy,
} from "../src/capture-profile.js";
import {
  type CaptureProject,
  captureProjectOwner,
  openCaptureProject,
} from "../src/capture-project.js";
import { verifyInstalledRoot } from "../src/installation.js";
import { loadNative } from "../src/native.js";
import {
  captureInstallationSuite,
  withCaptureInstallation,
} from "./capture-support.js";

// This module mock outlives individual test spies and late timeout cleanup.
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor() {
      throw new Error(
        "Capture project tests forbid real credential backend access",
      );
    }
  },
}));

it("requires a runtime-owned capture installation before native project access", async () => {
  await expect(
    openCaptureProject(
      Object.freeze({
        profile: CAPTURE_PROFILE,
        identity: "a".repeat(64),
        paths: {
          node: "fake",
          bootstrapEntry: "fake",
          cliEntry: "fake",
          dialogEntry: "fake",
          sqliteBinding: "fake",
        },
        recheck: async () => {},
        checkCurrent: async () => {},
        close: async () => {},
      }),
    ),
  ).rejects.toThrow(/verified capture installation/);
});
it("admits only the exact closed capture policy without learned origins", () => {
  validateCapturePolicy(capturePolicyBytes());
  const policy = JSON.parse(capturePolicyBytes().toString());
  policy.apiOrigins.push("https://unapproved.invalid");
  expect(() =>
    validateCapturePolicy(Buffer.from(JSON.stringify(policy))),
  ).toThrow();
});

describe.skipIf(process.platform !== "win32")(
  "suite-owned native capture installation",
  () => {
    const fixture = captureInstallationSuite();
    const projectIds = new Set<string>();
    beforeAll(() => fixture.start());
    afterAll(() => fixture.close());
    const freshProject = async (
      installation: Parameters<typeof openCaptureProject>[0],
    ) => {
      const project = await openCaptureProject(installation);
      expect(projectIds.has(project.projectId)).toBe(false);
      projectIds.add(project.projectId);
      return project;
    };

    it("provisions a fresh private capture project, enforces profile identity and reopens its journal", async () => {
      await fixture.run(async (installation) => {
        expect(installation.paths.cliEntry).toContain("capture-releases");
        await expect(
          verifyInstalledRoot(
            path.dirname(path.dirname(installation.paths.bootstrapEntry)),
          ),
        ).rejects.toThrow(/profile/);
        const project = await freshProject(installation);
        try {
          expect(project.paths.database).toContain("capture-projects");
          expect(project.projectId).toMatch(/^capture_/);
          expect(project.reference.id).toMatch(/^figma_pat_/);
          await expect(installation.close()).rejects.toThrow(/quiescence/);
          let competing: CaptureProject | undefined;
          try {
            await expect(
              openCaptureProject(installation, project.projectId).then(
                (value) => {
                  competing = value;
                  return value;
                },
              ),
            ).rejects.toThrow();
          } finally {
            await competing?.close();
          }
          const owned = captureProjectOwner(project);
          expect(await owned.journal.read()).toBeUndefined();
          await owned.journal.record({
            reference: project.reference,
            state: "pending-setup",
          });
          await owned.journal.record({
            reference: project.reference,
            state: "uncertain",
          });
          expect(await owned.journal.read()).toMatchObject({
            state: "uncertain",
          });
          await expect(
            owned.journal.record({
              reference: { ...project.reference, id: "foreign" },
              state: "ready",
            }),
          ).rejects.toThrow();
          const id = project.projectId;
          await project.close();
          const reopened = await openCaptureProject(installation, id);
          try {
            expect(
              await captureProjectOwner(reopened).journal.read(),
            ).toMatchObject({ state: "uncertain" });
          } finally {
            await reopened.close();
          }
        } finally {
          await project.close();
        }
      });
    });

    describe("real 1023-record journal admission", () => {
      const preparation = new AbortController();
      let project: CaptureProject | undefined;
      let root: string;
      let final: string;
      let last: Buffer;
      let next: Buffer;
      let identity: { ino: bigint; dev: bigint };
      const names = Array.from(
        { length: 1023 },
        (_, index) => `${String(index).padStart(4, "0")}.json`,
      );
      beforeAll(() =>
        fixture.prepare(async (installation) => {
          project = await freshProject(installation);
          const native = await loadNative();
          const sid = captureProjectOwner(project).sid;
          root = path.join(project.paths.temp, "credential-journal");
          let previous = "";
          for (let sequence = 0; sequence < 1023; sequence++) {
            preparation.signal.throwIfAborted();
            last = Buffer.from(
              JSON.stringify({
                sequence,
                previous,
                state: { reference: project.reference, state: "ready" },
              }),
            );
            native.createFile(
              path.join(root, `${String(sequence).padStart(4, "0")}.json`),
              sid,
              last,
            );
            previous = createHash("sha256").update(last).digest("hex");
            // Permit the original hook deadline to cancel setup between bounded native batches.
            if (sequence % 32 === 31) await setImmediate();
          }
          final = path.join(root, "1022.json");
          next = Buffer.from(
            JSON.stringify({
              sequence: 1023,
              previous,
              state: { reference: project.reference, state: "ready" },
            }),
          );
          identity = await lstat(final, { bigint: true });
        }),
      );
      afterAll(async () => {
        preparation.abort();
        await fixture.join();
        await project?.close();
      });
      beforeEach(() =>
        fixture.prepare(async () => {
          expect((await readdir(root)).sort()).toEqual(names);
          expect((await readFile(final)).equals(last)).toBe(true);
          const current = await lstat(final, { bigint: true });
          expect(current.ino).toBe(identity.ino);
          expect(current.dev).toBe(identity.dev);
          expect(current.nlink).toBe(1n);
        }),
      );
      const admission = async (
        signal: AbortSignal,
        operation: (
          credentials: Awaited<ReturnType<typeof openCaptureCredentials>>,
          inspections: () => number,
          reference: string,
        ) => Promise<void>,
      ) =>
        fixture.run(async () => {
          if (!project)
            throw new Error("Journal fixture did not finish preparation");
          const lookup = vi
            .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
            .mockRejectedValue(
              new Error("Synthetic backend must not be called"),
            );
          const native = await loadNative();
          const inspect = vi.spyOn(native, "inspect");
          let credentials:
            | Awaited<ReturnType<typeof openCaptureCredentials>>
            | undefined;
          try {
            signal.throwIfAborted();
            credentials = await openCaptureCredentials(project);
            const inspections = () =>
              inspect.mock.calls.filter(
                ([filename, directory]) =>
                  !directory &&
                  path.dirname(filename) === root &&
                  filename.endsWith(".json"),
              ).length;
            await operation(credentials, inspections, project.reference.id);
            expect(lookup).not.toHaveBeenCalled();
          } finally {
            credentials?.close();
            lookup.mockRestore();
            inspect.mockRestore();
          }
        });
      it("denies impossible update at exactly 1023 records without reading bodies or looking up credentials", async ({
        signal,
      }) => {
        await admission(signal, async (credentials, inspections, reference) => {
          const before = inspections();
          await expect(
            credentials.execute(
              "update",
              reference,
              signal,
              Buffer.from("synthetic-capacity"),
            ),
          ).rejects.toThrow(/capacity/);
          expect(inspections()).toBe(before);
        });
      }, 30_000);
      it("inspects the complete 1023-record chain and refuses its torn final body before credential lookup", async ({
        signal,
      }) => {
        await admission(signal, async (credentials, inspections, reference) => {
          const before = inspections();
          try {
            await writeFile(final, Buffer.from("{"));
            await expect(
              credentials.execute("status", reference, signal),
            ).rejects.toThrow(/torn/);
            expect(inspections() - before).toBe(1023);
          } finally {
            await writeFile(final, last);
          }
        });
      }, 30_000);
      it("denies exactly 1024 records without body inspection or credential lookup", async ({
        signal,
      }) => {
        await admission(signal, async (credentials, inspections, reference) => {
          if (!project) throw new Error("Journal fixture was closed");
          const extra = path.join(root, "1023.json");
          const native = await loadNative();
          native.createFile(extra, captureProjectOwner(project).sid, next);
          try {
            expect(await readdir(root)).toHaveLength(1024);
            const before = inspections();
            await expect(
              credentials.execute("status", reference, signal),
            ).rejects.toThrow(/capacity/);
            expect(inspections()).toBe(before);
          } finally {
            await unlink(extra);
          }
        });
      }, 30_000);
    });

    it("composes native authority with a synthetic fixed-entry adapter, never a real vault lookup", async ({
      signal,
    }) => {
      const stored: { bytes?: Uint8Array } = {};
      const read = vi
        .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
        .mockImplementation(async () =>
          stored.bytes ? Uint8Array.from(stored.bytes) : undefined,
        );
      const write = vi
        .spyOn(OwnedFigmaCredentialAdapter.prototype, "write")
        .mockImplementation(async (bytes) => {
          stored.bytes = Uint8Array.from(bytes);
        });
      const remove = vi
        .spyOn(OwnedFigmaCredentialAdapter.prototype, "remove")
        .mockImplementation(async () => {
          stored.bytes?.fill(0);
          delete stored.bytes;
          return true;
        });
      try {
        await fixture.run(async (installation) => {
          const project = await freshProject(installation);
          let credentials:
            | Awaited<ReturnType<typeof openCaptureCredentials>>
            | undefined;
          try {
            credentials = await openCaptureCredentials(project);
            expect(
              await captureProjectOwner(project).journal.read(),
            ).toBeUndefined();
            await expect(openCaptureCredentials(project)).rejects.toThrow(
              /active owner/,
            );
            await expect(
              openCaptureCredentials({ ...project }),
            ).rejects.toThrow(/live native/);
            await expect(project.close()).rejects.toThrow(/credential owners/);
            await expect(
              credentials.execute("status", "wrong", signal),
            ).rejects.toThrow();
            expect(read).not.toHaveBeenCalled();
            expect(
              await credentials.execute(
                "setup",
                project.reference.id,
                signal,
                Buffer.from("synthetic-no-user-secret"),
              ),
            ).toMatchObject({ status: "complete" });
            expect(
              await credentials.execute(
                "setup",
                project.reference.id,
                signal,
                Buffer.from("synthetic-collision"),
              ),
            ).toMatchObject({ error: { code: "CONFLICT" } });
            expect(
              await credentials.execute("status", project.reference.id, signal),
            ).toMatchObject({ value: { presence: "present" } });
            expect(
              await credentials.execute("remove", project.reference.id, signal),
            ).toMatchObject({ value: { presence: "absent" } });
          } finally {
            credentials?.close();
            await project.close();
          }
        });
      } finally {
        read.mockRestore();
        write.mockRestore();
        remove.mockRestore();
        stored.bytes?.fill(0);
      }
    });

    it("refuses torn journal history without adopting partial records or exposing payload", async () => {
      await fixture.run(async (installation) => {
        const project = await freshProject(installation);
        try {
          const owner = captureProjectOwner(project);
          expect(await owner.journal.read()).toBeUndefined();
          await owner.journal.record({
            reference: project.reference,
            state: "ready",
          });
          const filename = path.join(
            project.paths.temp,
            "credential-journal",
            "0000.json",
          );
          const original = await readFile(filename);
          await writeFile(filename, original.subarray(0, 12));
          await expect(owner.journal.read()).rejects.toThrow();
        } finally {
          await project.close();
        }
      });
    });
    it("refuses overlapping fixture admission and cancelled journal reads without losing owned scope", async () => {
      await fixture.run(async (installation, root) => {
        const native = await loadNative();
        const entry = native.createInstallationEntry;
        const work = vi.fn(async () => {});
        await expect(withCaptureInstallation(work)).rejects.toThrow(
          /still owns native overrides/,
        );
        expect(work).not.toHaveBeenCalled();
        expect(native.createInstallationEntry).toBe(entry);
        expect(native.localAppData()).toBe(root);
        const project = await freshProject(installation);
        try {
          const abort = new AbortController();
          abort.abort();
          await expect(
            captureProjectOwner(project).journal.begin("status", abort.signal),
          ).rejects.toMatchObject({ code: "CANCELLED" });
        } finally {
          await project.close();
        }
      });
    });
  },
);
