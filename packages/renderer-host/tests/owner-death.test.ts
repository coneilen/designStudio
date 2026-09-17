import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "controller abrupt death kills descendant even after joined worker is gone; process observer holds no Job handle",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "renderer owner death "));
    const name = `Local\\design-studio-${randomUUID()}`;
    const nativeUrl = pathToFileURL(
      path.resolve("packages/renderer-host/dist/windows-job.js"),
    ).href;
    const worker = path.join(root, "worker.mjs");
    const owner = path.join(root, "owner.mjs");
    await writeFile(
      worker,
      `
    import {spawn} from 'node:child_process';
    import {loadJobs} from ${JSON.stringify(nativeUrl)};
    (await loadJobs()).joinCurrent(${JSON.stringify(name)});
    const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore',detached:true});
    descendant.unref();
    process.stdout.write(String(descendant.pid), () => process.exit(0));
  `,
    );
    await writeFile(
      owner,
      `
    import {spawn} from 'node:child_process';
    import {loadJobs} from ${JSON.stringify(nativeUrl)};
    const job = (await loadJobs()).create(${JSON.stringify(name)});
    const worker = spawn(process.execPath, [${JSON.stringify(worker)}], {stdio:['ignore','pipe','pipe'],env:{}});
    worker.stderr.on('data', chunk => process.stderr.write(chunk.subarray(0,1000)));
    let text = '';
    worker.stdout.on('data', chunk => {text+=String(chunk); if(text.length>20) process.exit(2);});
    worker.on('close', code => {
      if(code!==0 || !job.members().includes(Number(text)) || job.members().includes(worker.pid)) {
        process.stderr.write(JSON.stringify({code,text,members:job.members(),worker:worker.pid}),()=>process.exit(3));
        return;
      }
      process.stdout.write(text+'\\n');
    });
    setInterval(()=>{},1000);
  `,
    );
    const controller = spawn(process.execPath, [owner], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    const ownerExit = once(controller, "close");
    let diagnostics = "";
    controller.stderr.on("data", (chunk) => {
      diagnostics += String(chunk).slice(0, 1000);
    });
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const sentinelExit = once(sentinel, "close");
    const koffi = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const open: (
      rights: number,
      inherited: number,
      pid: number,
    ) => number | bigint = kernel.func(
      "uintptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)",
    );
    const wait: (handle: number | bigint, milliseconds: number) => number =
      kernel.func(
        "uint32_t __stdcall WaitForSingleObject(uintptr_t, uint32_t)",
      );
    const close: (handle: number | bigint) => number = kernel.func(
      "int __stdcall CloseHandle(uintptr_t)",
    );
    let observer: number | bigint = 0;
    const timeout = new AbortController();
    try {
      const data = await Promise.race([
        once(controller.stdout, "data"),
        ownerExit.then((result) => {
          throw new Error(
            `Owner exited before readiness: ${result}; ${diagnostics}`,
          );
        }),
        delay(5000, undefined, { signal: timeout.signal }).then(() => {
          throw new Error("Owner did not report its controlled descendant");
        }),
      ]);
      timeout.abort();
      const pid = Number(String(data[0]).trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      // This SYNCHRONIZE-only process handle cannot keep the Job alive or control a process.
      observer = open(0x100000, 0, pid);
      expect(observer).not.toBe(0);
      expect(observer).not.toBe(0n);
      expect(wait(observer, 0)).toBe(258);
      controller.kill("SIGKILL");
      await ownerExit;
      for (let i = 0; wait(observer, 0) === 258 && i < 300; i++)
        await delay(10);
      expect(wait(observer, 0)).toBe(0);
      expect(sentinel.exitCode).toBeNull();
    } finally {
      timeout.abort();
      if (controller.exitCode === null && controller.signalCode === null)
        controller.kill("SIGKILL");
      await ownerExit;
      if (observer !== 0 && observer !== 0n) expect(close(observer)).toBe(1);
      sentinel.kill("SIGKILL");
      await sentinelExit;
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
