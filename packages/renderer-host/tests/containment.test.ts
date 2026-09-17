import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadJobs } from "../src/windows-job.js";

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "self-joins, verifies ABI/flags, and kills only owned descendants",
  async () => {
    const native = await loadJobs();
    const name = `Local\\design-studio-${randomUUID()}`;
    const job = native.create(name);
    const directory = await mkdtemp(path.join(tmpdir(), "renderer job owned "));
    const script = path.join(directory, "join.mjs");
    const nativeUrl = pathToFileURL(
      path.resolve("packages/renderer-host/dist/windows-job.js"),
    ).href;
    await writeFile(
      script,
      `
    import {loadJobs} from ${JSON.stringify(nativeUrl)};
    const api = await loadJobs();
    api.joinCurrent(${JSON.stringify(name)});
    const {spawn} = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    process.stdout.write(String(child.pid)+'\\n');
    setInterval(()=>{},1000);
  `,
    );
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    const exited = once(child, "close");
    try {
      const data = await Promise.race([
        once(child.stdout, "data"),
        delay(4000).then(() => {
          throw new Error("No joined worker");
        }),
      ]);
      const descendant = Number(String(data[0]).trim());
      expect(job.members()).toEqual(
        expect.arrayContaining([child.pid, descendant]),
      );
      expect(job.flags()).toBe(0x2008);
      job.terminate();
      await exited;
      for (let attempt = 0; job.members().length && attempt < 100; attempt++)
        await delay(10);
      expect(job.members()).toEqual([]);
      expect(sentinel.exitCode).toBeNull();
    } finally {
      job.close();
      job.close();
      if (child.exitCode === null) child.kill();
      const sentinelExit = once(sentinel, "close");
      sentinel.kill();
      await sentinelExit;
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "denied membership never reaches descendant creation",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "renderer denied owned "),
    );
    const script = path.join(directory, "denied.mjs");
    const nativeUrl = pathToFileURL(
      path.resolve("packages/renderer-host/dist/windows-job.js"),
    ).href;
    await writeFile(
      script,
      `
    import {loadJobs} from ${JSON.stringify(nativeUrl)};
    (await loadJobs()).joinCurrent('Local\\\\missing-${randomUUID()}');
    process.stdout.write('unsafe');
  `,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      const [code] = await once(child, "close");
      expect(code).not.toBe(0);
      expect(output).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "repeated native Job open/close leaves the process handle count unchanged",
  async () => {
    const native = await loadJobs();
    const koffi = await import("koffi");
    const library = koffi.load("kernel32.dll");
    const current: () => number | bigint = library.func(
      "uintptr_t __stdcall GetCurrentProcess()",
    );
    const count: (handle: number | bigint, output: Buffer) => number =
      library.func(
        "int __stdcall GetProcessHandleCount(uintptr_t, _Out_ void *)",
      );
    const buffer = Buffer.alloc(4);
    expect(count(current(), buffer)).toBe(1);
    const before = buffer.readUInt32LE(0);
    for (let i = 0; i < 100; i++) {
      const job = native.create(`Local\\design-studio-${randomUUID()}`);
      expect(job.members()).toEqual([]);
      job.close();
      job.close();
    }
    expect(count(current(), buffer)).toBe(1);
    expect(buffer.readUInt32LE(0)).toBe(before);
  },
);
