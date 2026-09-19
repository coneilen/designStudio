import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { loadJobs } from "../../host/dist/owned-job.js";
import { openCaptureProject } from "../src/capture-project.js";
import { startCapturePatDialog } from "../src/pat-dialog-controller.js";
import { withCaptureInstallation } from "./capture-support.js";

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "owned process no-UI probe uses pinned Node, real Job membership, private binary bytes and observed exit",
  async () => {
    const node = await readFile(process.execPath);
    expect(createHash("sha256").update(node).digest("hex")).toBe(
      "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    );
    const moduleUrl = (relative: string) =>
      pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href;
    const helper = Buffer.from(`
      // Synthetic lifecycle peer only: no UI, clipboard, vault, or application operation.
      import { Socket } from "node:net";
      import { setTimeout as delay } from "node:timers/promises";
      import { PatChannel, PatKind } from ${JSON.stringify(moduleUrl("../../host/dist/pat-channel.js"))};
      import { loadJobs } from ${JSON.stringify(moduleUrl("../../host/dist/owned-job.js"))};
      const channel = new PatChannel(new Socket({ fd: 3, readable: true, writable: true }));
      let bytes;
      try {
        const init = await channel.read(5000);
        const id = init.bytes.toString("ascii"); init.bytes.fill(0);
        (await loadJobs()).joinCurrent("Local\\\\design-studio-" + id, "pat-dialog");
        await channel.send(PatKind.joined, 0);
        const start = await channel.read(5000); start.bytes.fill(0);
        await channel.send(PatKind.ready, 0);
        bytes = Buffer.from("synthetic-owned-process");
        await channel.send(PatKind.accepted, 1, bytes); bytes.fill(0);
        await channel.send(PatKind.closed, 1, Buffer.of(3));
        await delay(100);
        await channel.close();
        process.exit(0);
      } catch { bytes?.fill(0); await channel.close(); process.exit(1); }
    `);
    const jobs = await loadJobs();
    const create = jobs.create.bind(jobs);
    let emptyAtRelease = false;
    const tracking = vi
      .spyOn(jobs, "create")
      .mockImplementation((name, profile) => {
        const owned = create(name, profile);
        return {
          flags: () => owned.flags(),
          members: () => owned.members(),
          terminate: () => owned.terminate(),
          close() {
            expect(owned.members()).toEqual([]);
            emptyAtRelease = true;
            owned.close();
          },
        };
      });
    try {
      await withCaptureInstallation(
        async (installation) => {
          const project = await openCaptureProject(installation);
          const run = startCapturePatDialog(
            project,
            new AbortController().signal,
          );
          try {
            await expect(project.close()).rejects.toThrow(/dialog helpers/);
            const result = await run.result;
            expect(result.toString()).toBe("synthetic-owned-process");
            result.fill(0);
            expect(await run.close()).toMatchObject({
              closed: true,
              scrub: "confirmed",
            });
            expect(emptyAtRelease).toBe(true);
          } finally {
            await run.result.then(
              (bytes) => bytes.fill(0),
              () => undefined,
            );
            expect((await run.close()).closed).toBe(true);
            await project.close();
          }
        },
        { node, helper },
      );
    } finally {
      tracking.mockRestore();
      node.fill(0);
      helper.fill(0);
    }
  },
  30_000,
);
