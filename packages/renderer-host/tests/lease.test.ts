import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OperationContext } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { SystemClock } from "@design-studio/host";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  RendererWorkerHost,
  type RendererWorkerOptions,
} from "../src/index.js";

let directory: string;
let nodeHash: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "renderer lease owned "));
  nodeHash = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function context(): OperationContext {
  const ctx = syntheticContext();
  const clock = new SystemClock();
  return {
    ...ctx,
    clock,
    deadline: new Date(clock.now() + 25000).toISOString(),
    authorization: {
      ...ctx.authorization,
      expiresAt: new Date(clock.now() + 30000).toISOString(),
    },
  };
}

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "encodes only child TEMP and TMP before implementation import while retaining ordinary owned cwd and cleanup",
  async () => {
    const config = await options(`
      const atImport = { temp: process.env.TEMP, tmp: process.env.TMP, cwd: process.cwd() };
      export async function render() { return Buffer.from(JSON.stringify(atImport)); }
    `);
    const before = await readdir(directory);
    const ctx = context();
    const opened = await new RendererWorkerHost(config).open(ctx);
    expect(opened.status, JSON.stringify(opened)).toBe("complete");
    if (opened.status !== "complete") return;
    try {
      const result = await opened.value.exchange(new Uint8Array(), ctx);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      const environment = JSON.parse(Buffer.from(result.value).toString());
      expect(environment.cwd.startsWith("\\\\")).toBe(false);
      expect(path.dirname(environment.cwd)).toBe(directory);
      expect(path.basename(environment.cwd)).toMatch(/^renderer-owned-/);
      expect(environment.temp).toBe(`\\\\?\\${environment.cwd}`);
      expect(environment.tmp).toBe(environment.temp);
    } finally {
      expect(await opened.value.close()).toMatchObject({
        status: "complete",
        value: { workerExitObserved: true, jobEmptyObserved: true },
      });
    }
    expect(await readdir(directory)).toEqual(before);
    for (const tempRoot of [
      `\\\\?\\${directory}`,
      "\\\\server\\share\\temp",
      "\\\\.\\C:\\temp",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\temp",
    ])
      expect(() => new RendererWorkerHost({ ...config, tempRoot })).toThrow();
  },
);
it.skipIf(process.platform === "win32" && process.arch === "x64")(
  "unsupported hosts return unavailable without attempting a worker",
  async () => {
    const config = await options();
    config.node.path = path.join(directory, "node.exe");
    expect(await new RendererWorkerHost(config).open(context())).toMatchObject({
      status: "unavailable",
      error: { code: "UNSUPPORTED_HOST" },
    });
  },
);
async function options(
  code = "export async function render(bytes) { return bytes; }",
): Promise<RendererWorkerOptions> {
  const filename = path.join(directory, `worker-${crypto.randomUUID()}.mjs`);
  await writeFile(filename, code);
  return {
    projectId: "project_synthetic",
    providerId: "fake-process",
    authority: () => true,
    node: { path: process.execPath, sha256: nodeHash, maxBytes: 200000000 },
    implementation: {
      path: filename,
      sha256: createHash("sha256").update(code).digest("hex"),
      maxBytes: 100000,
    },
    environment: {},
    tempRoot: directory,
    trustedExclusiveAccess: true,
    limits: {
      startMs: 4000,
      idleMs: 5000,
      lifetimeMs: 15000,
      closeMs: 300,
      maxFrameBytes: 10000,
      maxInputBytes: 20000,
      maxOutputBytes: 20000,
      maxStdoutBytes: 1000,
      maxStderrBytes: 1000,
      maxRequests: 4,
    },
  };
}
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "opens joined worker, exchanges exact binary, refuses replay and repeatedly closes with observed empty Job",
  async () => {
    const host = new RendererWorkerHost(await options());
    const ctx = context();
    const result = await host.open(ctx);
    expect(
      result.status,
      result.status === "complete" ? "" : JSON.stringify(result),
    ).toBe("complete");
    if (result.status !== "complete") return;
    const lease = result.value;
    try {
      expect(
        await lease.exchange(Uint8Array.of(0, 255, 128), ctx),
      ).toMatchObject({
        status: "complete",
        value: Uint8Array.of(0, 255, 128),
      });
      expect(await lease.exchange(Uint8Array.of(1), ctx)).toMatchObject({
        status: "failed",
        error: { code: "CONFLICT" },
      });
    } finally {
      expect(await lease.close()).toMatchObject({
        status: "complete",
        value: { workerExitObserved: true, jobEmptyObserved: true },
      });
      expect(await lease.close()).toEqual(await lease.closed);
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "rejects project/grant and foreign session before starting or exchanging",
  async () => {
    const host = new RendererWorkerHost(await options());
    const ctx = context();
    expect(await host.open({ ...ctx, projectId: "foreign" })).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(
      await host.open({
        ...ctx,
        authorization: { ...ctx.authorization, grants: [] },
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    const result = await host.open(ctx);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    try {
      expect(
        await result.value.exchange(new Uint8Array(), context()),
      ).toMatchObject({ error: { code: "FORBIDDEN" } });
    } finally {
      await result.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "cancels hung rendering, observes owned exit and never returns stale bytes",
  async () => {
    const host = new RendererWorkerHost(
      await options(
        "export async function render() { await new Promise(()=>{}); }",
      ),
    );
    const abort = new AbortController();
    const ctx = { ...context(), signal: abort.signal };
    const result = await host.open(ctx);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    const work = result.value.exchange(Uint8Array.of(1), ctx);
    await delay(30);
    abort.abort();
    expect(await work).toMatchObject({ status: "cancelled" });
    expect(await result.value.closed).toMatchObject({
      status: "complete",
      value: { workerExitObserved: true, jobEmptyObserved: true },
    });
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "bounds stdout, stderr and response frames cumulatively",
  async () => {
    for (const code of [
      "export async function render() { process.stdout.write(Buffer.alloc(2000)); await new Promise(()=>{}); }",
      "export async function render() { process.stderr.write(Buffer.alloc(2000)); await new Promise(()=>{}); }",
      "export async function render() { return Buffer.alloc(10001); }",
    ]) {
      const host = new RendererWorkerHost(await options(code));
      const ctx = context();
      const result = await host.open(ctx);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") continue;
      expect(await result.value.exchange(Uint8Array.of(1), ctx)).toMatchObject({
        status: "failed",
        error: { code: "OUTPUT_LIMIT" },
      });
      expect(await result.value.close()).toMatchObject({
        status: "complete",
        value: { jobEmptyObserved: true },
      });
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "reports import failure/hang and worker crash, never successful output",
  async () => {
    for (const code of [
      "throw new Error('private implementation detail');",
      "await new Promise(()=>{});",
      "export async function render() { process.exit(7); }",
    ]) {
      const config = await options(code);
      config.limits.startMs = 700;
      const host = new RendererWorkerHost(config);
      const ctx = context();
      const result = await host.open(ctx);
      if (result.status === "complete") {
        expect(
          await result.value.exchange(Uint8Array.of(1), ctx),
        ).toMatchObject({ error: { code: "PROCESS_FAILED" } });
        await result.value.close();
      } else expect(result.status).not.toBe("complete");
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "rejects injection environment and untrusted constructor resources",
  async () => {
    const config = await options();
    for (const environment of [
      { NODE_OPTIONS: "--inspect" },
      { node_path: "." },
      { PATH: "." },
    ])
      expect(
        () => new RendererWorkerHost({ ...config, environment }),
      ).toThrow();
    expect(
      () =>
        new RendererWorkerHost({
          ...config,
          environment: { NODE_OPTIONS: "--inspect" },
        }),
    ).toThrow();
    expect(
      () =>
        new RendererWorkerHost({ ...config, trustedExclusiveAccess: false }),
    ).toThrow();
    const wrong = new RendererWorkerHost({
      ...config,
      implementation: { ...config.implementation, sha256: "0".repeat(64) },
    });
    expect(await wrong.open(context())).toMatchObject({
      error: { code: "TOOL_VERSION_UNSUPPORTED" },
    });
  },
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "rejects wrong executable identity and changed module bytes before import",
  async () => {
    const config = await options();
    const ctx = context();
    const wrongNode = new RendererWorkerHost({
      ...config,
      node: { ...config.node, sha256: "f".repeat(64) },
    });
    expect(await wrongNode.open(ctx)).toMatchObject({
      error: { code: "TOOL_VERSION_UNSUPPORTED" },
    });
    await writeFile(config.implementation.path, "process.exit(0);");
    expect(await new RendererWorkerHost(config).open(ctx)).toMatchObject({
      error: { code: "TOOL_VERSION_UNSUPPORTED" },
    });
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "rejects simultaneous exchanges and snapshots bytes while renderer is delayed",
  async () => {
    const ctx = context();
    const opened = await new RendererWorkerHost(
      await options(
        "export async function render(bytes) {await new Promise(resolve=>setTimeout(resolve,100));return bytes;}",
      ),
    ).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    try {
      const bytes = Uint8Array.of(12);
      const first = opened.value.exchange(bytes, ctx);
      bytes[0] = 255;
      expect(
        await opened.value.exchange(bytes, {
          ...ctx,
          requestId: "request_second",
        }),
      ).toMatchObject({ error: { code: "CONFLICT" } });
      expect(await first).toMatchObject({
        status: "complete",
        value: Uint8Array.of(12),
      });
    } finally {
      await opened.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "per-request deadlines and lifetime cannot be extended by a later context",
  async () => {
    const ctx = context();
    const config = await options(
      "export async function render() {await new Promise(()=>{});}",
    );
    config.limits.lifetimeMs = 1500;
    const opened = await new RendererWorkerHost(config).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    expect(
      await opened.value.exchange(Uint8Array.of(1), {
        ...ctx,
        deadline: new Date(Date.now() + 30000).toISOString(),
      }),
    ).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
    expect(await opened.value.closed).toMatchObject({
      status: "complete",
      value: { jobEmptyObserved: true },
    });
  },
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "request count is finite and accepted-request cancellation retires the lease",
  async () => {
    const ctx = context();
    const config = await options();
    config.limits.maxRequests = 1;
    const result = await new RendererWorkerHost(config).open(ctx);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    try {
      expect(await result.value.exchange(Uint8Array.of(1), ctx)).toMatchObject({
        status: "complete",
      });
      expect(
        await result.value.exchange(Uint8Array.of(2), {
          ...ctx,
          requestId: "request_next",
        }),
      ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
    } finally {
      await result.value.close();
    }
    const controller = new AbortController();
    const second = await new RendererWorkerHost(
      await options(
        "export async function render() {await new Promise(()=>{});}",
      ),
    ).open(ctx);
    expect(second.status).toBe("complete");
    if (second.status !== "complete") return;
    const pending = second.value.exchange(Uint8Array.of(1), {
      ...ctx,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(await second.value.closed).toMatchObject({
      status: "complete",
      value: { terminalFailure: { code: "CANCELLED" } },
    });
  },
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "a CPU-blocked renderer cannot prevent request-deadline Job teardown",
  async () => {
    const ctx = context();
    const opened = await new RendererWorkerHost(
      await options("export async function render() { while (true) {} }"),
    ).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    expect(
      await opened.value.exchange(Uint8Array.of(1), {
        ...ctx,
        deadline: new Date(Date.now() + 300).toISOString(),
      }),
    ).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
    expect(await opened.value.closed).toMatchObject({
      status: "complete",
      value: { mode: "forced", jobEmptyObserved: true },
    });
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "a stalled epoch clock cannot extend the finite native cleanup allowance",
  async () => {
    const opened = await new RendererWorkerHost(
      await options(
        "export async function render(bytes) {return bytes;} export async function close() {await new Promise(()=>{});}",
      ),
    ).open(context());
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    const epoch = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
    const timeout = new AbortController();
    try {
      const result = await Promise.race([
        opened.value.close(),
        delay(1500, "cleanup-not-finite", { signal: timeout.signal }),
      ]);
      expect(result).not.toBe("cleanup-not-finite");
    } finally {
      clock.mockRestore();
      timeout.abort();
      await opened.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "deadline during watch admission does not leave a healthy lease permanently busy",
  async () => {
    const ctx = context();
    const opened = await new RendererWorkerHost(await options()).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    const now = Date.now();
    let reads = 0;
    const clock = vi
      .spyOn(ctx.clock, "now")
      .mockImplementation(() => (++reads >= 10 ? now + 1001 : now));
    try {
      expect(
        await opened.value.exchange(Uint8Array.of(1), {
          ...ctx,
          deadline: new Date(now + 1000).toISOString(),
        }),
      ).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
      clock.mockRestore();
      expect(
        await opened.value.exchange(Uint8Array.of(2), {
          ...ctx,
          requestId: "request_after_admission",
        }),
      ).toMatchObject({ status: "complete", value: Uint8Array.of(2) });
    } finally {
      clock.mockRestore();
      await opened.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "cancellation while closing the request watch cannot deliver stale output",
  async () => {
    const controller = new AbortController();
    const system = new SystemClock();
    const ctx = {
      ...context(),
      signal: controller.signal,
      clock: {
        now: () => system.now(),
        async sleep(milliseconds: number, signal: AbortSignal) {
          try {
            await system.sleep(milliseconds, signal);
          } catch (error) {
            if (signal.aborted && milliseconds > 20000) controller.abort();
            throw error;
          }
        },
      },
    };
    const opened = await new RendererWorkerHost(await options()).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    try {
      expect(await opened.value.exchange(Uint8Array.of(1), ctx)).toMatchObject({
        status: "cancelled",
      });
    } finally {
      await opened.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "cancellation while closing the startup watch cannot publish a ready lease",
  async () => {
    const controller = new AbortController();
    const system = new SystemClock();
    const ctx = {
      ...context(),
      signal: controller.signal,
      clock: {
        now: () => system.now(),
        async sleep(milliseconds: number, signal: AbortSignal) {
          try {
            await system.sleep(milliseconds, signal);
          } catch (error) {
            if (signal.aborted && milliseconds <= 4000) controller.abort();
            throw error;
          }
        },
      },
    };
    const opened = await new RendererWorkerHost(await options()).open(ctx);
    try {
      expect(opened.status).toBe("cancelled");
    } finally {
      if (opened.status === "complete") await opened.value.close();
    }
  },
);

it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "counts diagnostic bytes against each request, not only the lease",
  async () => {
    const host = new RendererWorkerHost(
      await options(
        "export async function render() { process.stdout.write(Buffer.alloc(100)); await new Promise(resolve=>setTimeout(resolve,30)); return Buffer.of(1); }",
      ),
    );
    const ctx = context();
    const result = await host.open(ctx);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    try {
      expect(
        await result.value.exchange(Uint8Array.of(1), {
          ...ctx,
          budget: { ...ctx.budget, maxOutputBytes: 50 },
        }),
      ).toMatchObject({ status: "failed", error: { code: "OUTPUT_LIMIT" } });
    } finally {
      await result.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "bounds cumulative transport, request count, idle lifetime and hung close",
  async () => {
    const config = await options(
      "export async function render(bytes) {return bytes;} export async function close() {await new Promise(()=>{});}",
    );
    config.limits.idleMs = 100;
    const result = await new RendererWorkerHost(config).open(context());
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(await result.value.closed).toMatchObject({
      status: "complete",
      value: { mode: "forced", jobEmptyObserved: true },
    });
    const ctx = context();
    const limited = await options();
    limited.limits.maxFrameBytes = 1;
    limited.limits.maxInputBytes = 125;
    const opened = await new RendererWorkerHost(limited).open(ctx);
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") return;
    try {
      expect(await opened.value.exchange(Uint8Array.of(1), ctx)).toMatchObject({
        status: "complete",
      });
      expect(
        await opened.value.exchange(Uint8Array.of(1), {
          ...ctx,
          requestId: "request_second",
        }),
      ).toMatchObject({ status: "complete" });
      expect(
        await opened.value.exchange(Uint8Array.of(1), {
          ...ctx,
          requestId: "request_third",
        }),
      ).toMatchObject({ error: { code: "INPUT_LIMIT" } });
    } finally {
      await opened.value.close();
    }
  },
);
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "revocation at the next boundary retires the lease and observes cleanup",
  async () => {
    let authorized = true;
    const config = await options();
    config.authority = () => authorized;
    const ctx = context();
    const result = await new RendererWorkerHost(config).open(ctx);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    authorized = false;
    expect(await result.value.exchange(Uint8Array.of(1), ctx)).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    const timeout = new AbortController();
    try {
      const closed = await Promise.race([
        result.value.closed,
        delay(1500, "still-open", { signal: timeout.signal }),
      ]);
      expect(closed).not.toBe("still-open");
    } finally {
      timeout.abort();
      await result.value.close();
    }
  },
);
