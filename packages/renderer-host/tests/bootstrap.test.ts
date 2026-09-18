import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { encode, FrameReader, Kind, send } from "../src/protocol.js";
import { loadJobs } from "../src/windows-job.js";

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "fixed bootstrap waits for parent start before importing any implementation",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bootstrap owned "));
    const name = `Local\\design-studio-${randomUUID()}`;
    const job = (await loadJobs()).create(name);
    const nonce = randomBytes(32).toString("hex");
    const filename = path.join(root, "implementation.mjs");
    const code =
      "process.stdout.write('imported'); export async function render(bytes) {return bytes;}";
    await writeFile(filename, code);
    const child = spawn(
      process.execPath,
      [
        path.resolve("packages/renderer-host/src/bootstrap.mjs"),
        JSON.stringify({
          job: name,
          nonce,
          implementation: {
            path: filename,
            sha256: createHash("sha256").update(code).digest("hex"),
            maxBytes: 10000,
          },
          maxFrameBytes: 1000,
        }),
      ],
      { stdio: ["ignore", "pipe", "pipe", "overlapped"], env: {}, cwd: root },
    );
    const exit = once(child, "close");
    const transport = child.stdio[3] as Duplex;
    const frames: number[] = [];
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (bytes) => {
      stdout += String(bytes);
    });
    child.stderr?.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const reader = new FrameReader(nonce, 1000, (frame) => {
      frames.push(frame.kind);
    });
    transport.on("data", (bytes: Buffer) => reader.push(bytes));
    try {
      for (let i = 0; i < 200 && !frames.length; i++) await delay(10);
      expect(frames, stderr).toEqual([Kind.joined]);
      expect(stdout).toBe("");
      expect(job.members()).toContain(child.pid);
      await send(transport, encode(nonce, Kind.start, 0));
      for (let i = 0; i < 200 && frames.length < 2; i++) await delay(10);
      expect(frames, stderr).toEqual([Kind.joined, Kind.ready]);
      expect(stdout).toBe("imported");
      await send(transport, Buffer.from([255, 255, 255, 255]));
      const [code] = await exit;
      expect(code).not.toBe(0);
      expect(frames).toContain(Kind.error);
    } finally {
      job.terminate();
      await exit;
      job.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
