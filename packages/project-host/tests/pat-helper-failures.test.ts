import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadJobs } from "../../host/dist/owned-job.js";
import { PatChannel, PatKind } from "../../host/dist/pat-channel.js";

for (const mode of [
  "early-start",
  "malformed-init",
  "wrong-membership",
  "uninstalled-role",
] as const)
  it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
    `real fixed helper rejects ${mode} without ever receiving an authorized START`,
    async () => {
      const id = randomUUID();
      const jobs = await loadJobs();
      const job = jobs.create(
        `Local\\design-studio-${id}`,
        mode === "wrong-membership" ? "renderer" : "pat-dialog",
      );
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../dist/pat-dialog-helper.js", import.meta.url),
          ),
          "--control-fd",
          "3",
        ],
        {
          shell: false,
          windowsHide: true,
          env: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
          stdio: ["ignore", "ignore", "ignore", "overlapped"],
        },
      );
      let observed = false;
      let spawnFailed = false;
      const exited = new Promise<number | null>((resolve) =>
        child.once("close", (code) => {
          observed = true;
          resolve(code);
        }),
      );
      child.once("error", () => {
        spawnFailed = true;
      });
      const pipe = child.stdio[3];
      if (!(pipe instanceof Duplex)) throw new Error("No test private pipe");
      const channel = new PatChannel(pipe, randomBytes(32));
      const watchdog = setTimeout(() => {
        if (!observed) child.kill();
      }, 5000);
      const kinds: number[] = [];
      try {
        if (mode === "early-start") {
          const duration = Buffer.alloc(4);
          duration.writeUInt32BE(1);
          await channel.send(PatKind.start, 0, duration);
        } else
          await channel.send(
            PatKind.init,
            0,
            Buffer.from(mode === "malformed-init" ? "#".repeat(36) : id),
          );
        // No follow-up START is sent, even for the valid Job-membership case.
        for (let count = 0; count < 3; count++) {
          try {
            const frame = await channel.read(5000);
            kinds.push(frame.kind);
            frame.bytes.fill(0);
            if (frame.kind === PatKind.closed) break;
          } catch {
            break;
          }
        }
        expect(kinds).not.toContain(PatKind.ready);
        expect(kinds).not.toContain(PatKind.accepted);
        expect(kinds).toEqual(
          mode === "early-start"
            ? []
            : mode === "uninstalled-role"
              ? [PatKind.joined, PatKind.error, PatKind.closed]
              : [PatKind.error, PatKind.closed],
        );
        expect(await exited).not.toBe(0);
        expect(spawnFailed).toBe(false);
        expect(job.members()).toEqual([]);
      } finally {
        clearTimeout(watchdog);
        if (!observed) child.kill();
        await exited;
        await channel.close();
        job.close();
      }
    },
    10_000,
  );
