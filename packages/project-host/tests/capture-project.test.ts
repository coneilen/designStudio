import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import { openCaptureCredentials } from "../src/capture-credentials.js";
import {
  CAPTURE_PROFILE,
  capturePolicyBytes,
  validateCapturePolicy,
} from "../src/capture-profile.js";
import {
  captureProjectOwner,
  openCaptureProject,
} from "../src/capture-project.js";
import { verifyInstalledRoot } from "../src/installation.js";
import { loadNative } from "../src/native.js";
import { withCaptureInstallation } from "./capture-support.js";

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
        },
        recheck: async () => {},
        checkCurrent: async () => {},
        close: async () => {},
      }),
    ),
  ).rejects.toThrow(/verified capture installation/);
});
it("admits only the exact closed nonnetwork capture policy", () => {
  validateCapturePolicy(capturePolicyBytes());
  const policy = JSON.parse(capturePolicyBytes().toString());
  policy.apiOrigins.push("https://api.figma.com");
  expect(() =>
    validateCapturePolicy(Buffer.from(JSON.stringify(policy))),
  ).toThrow();
});

it.skipIf(process.platform !== "win32")(
  "provisions a fresh private capture project, enforces profile identity and reopens its journal",
  async () => {
    await withCaptureInstallation(async (installation) => {
      expect(installation.paths.cliEntry).toContain("capture-releases");
      await expect(
        verifyInstalledRoot(
          path.dirname(path.dirname(installation.paths.bootstrapEntry)),
        ),
      ).rejects.toThrow(/profile/);
      const project = await openCaptureProject(installation);
      try {
        expect(project.paths.database).toContain("capture-projects");
        expect(project.projectId).toMatch(/^capture_/);
        expect(project.reference.id).toMatch(/^figma_pat_/);
        await expect(installation.close()).rejects.toThrow(/quiescence/);
        let competing:
          | Awaited<ReturnType<typeof openCaptureProject>>
          | undefined;
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
  },
);

it.skipIf(process.platform !== "win32")(
  "denies exact 1023/full/malformed journal admission before any native credential lookup",
  async () => {
    const lookup = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
      .mockRejectedValue(new Error("Synthetic backend must not be called"));
    try {
      await withCaptureInstallation(async (installation) => {
        const project = await openCaptureProject(installation);
        const credentials = await openCaptureCredentials(project);
        try {
          const native = await loadNative();
          const sid = captureProjectOwner(project).sid;
          const root = path.join(project.paths.temp, "credential-journal");
          let previous = "";
          let last = Buffer.alloc(0);
          for (let sequence = 0; sequence < 1023; sequence++) {
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
          }
          const signal = new AbortController().signal;
          await expect(
            credentials.execute(
              "update",
              project.reference.id,
              signal,
              Buffer.from("synthetic-capacity"),
            ),
          ).rejects.toThrow(/capacity/);
          expect(lookup).not.toHaveBeenCalled();
          const final = path.join(root, "1022.json");
          await writeFile(final, Buffer.from("{"));
          await expect(
            credentials.execute("status", project.reference.id, signal),
          ).rejects.toThrow(/torn/);
          expect(lookup).not.toHaveBeenCalled();
          await writeFile(final, last);
          native.createFile(
            path.join(root, "1023.json"),
            sid,
            Buffer.from(
              JSON.stringify({
                sequence: 1023,
                previous,
                state: { reference: project.reference, state: "ready" },
              }),
            ),
          );
          await expect(
            credentials.execute("status", project.reference.id, signal),
          ).rejects.toThrow(/capacity/);
          expect(lookup).not.toHaveBeenCalled();
        } finally {
          credentials.close();
          await project.close();
        }
      });
    } finally {
      lookup.mockRestore();
    }
  },
  30_000,
);

it.skipIf(process.platform !== "win32")(
  "composes native authority with a synthetic fixed-entry adapter, never a real vault lookup",
  async () => {
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
      await withCaptureInstallation(async (installation) => {
        const project = await openCaptureProject(installation);
        const credentials = await openCaptureCredentials(project);
        try {
          await expect(openCaptureCredentials(project)).rejects.toThrow(
            /active owner/,
          );
          await expect(openCaptureCredentials({ ...project })).rejects.toThrow(
            /live native/,
          );
          await expect(project.close()).rejects.toThrow(/credential owners/);
          const signal = new AbortController().signal;
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
          credentials.close();
          await project.close();
        }
      });
    } finally {
      read.mockRestore();
      write.mockRestore();
      remove.mockRestore();
      stored.bytes?.fill(0);
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "refuses torn journal history without adopting partial records or exposing payload",
  async () => {
    await withCaptureInstallation(async (installation) => {
      const project = await openCaptureProject(installation);
      try {
        const owner = captureProjectOwner(project);
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
  },
);
