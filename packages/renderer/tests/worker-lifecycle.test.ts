import path from "node:path";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { canonicalBytes } from "@design-studio/design-ir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareInputs } from "../src/resources.js";
import { createWorker } from "../src/worker.js";
import { fixtureInputs } from "./support.js";

const fake = vi.hoisted(() => ({
  launch: vi.fn(),
  executableHash:
    "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c",
}));
const root = path.resolve("worker-lifecycle-browser");
vi.mock("playwright", () => ({ chromium: { launch: fake.launch } }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const fakeRoot = path.resolve("worker-lifecycle-browser");
  return {
    ...fs,
    realpath: vi.fn(async (filename, ...args) =>
      filename === fakeRoot ? fakeRoot : fs.realpath(filename, ...args),
    ),
    lstat: vi.fn(async (filename, ...args) =>
      typeof filename === "string" &&
      filename.startsWith(`${fakeRoot}${path.sep}`)
        ? {
            isFile: (): boolean => true,
            isSymbolicLink: (): boolean => false,
            nlink: 1,
            size: 1,
          }
        : fs.lstat(filename, ...args),
    ),
    readFile: vi.fn(async (filename, ...args) =>
      typeof filename === "string" &&
      filename.startsWith(`${fakeRoot}${path.sep}`)
        ? Buffer.from([255])
        : fs.readFile(filename, ...args),
    ),
  };
});
vi.mock("@design-studio/design-ir", async (original) => {
  const actual = await original<typeof import("@design-studio/design-ir")>();
  return {
    ...actual,
    hashBytes: (bytes: Uint8Array) =>
      bytes.length === 1 && bytes[0] === 255
        ? fake.executableHash
        : actual.hashBytes(bytes),
  };
});
beforeEach(() => fake.launch.mockReset());
afterEach(() => vi.restoreAllMocks());

function worker() {
  return createWorker({
    root,
    executable: "shell.exe",
    files: ["shell.exe", "LICENSE.headless_shell"].map((filename) => ({
      path: filename,
      byteLength: 1,
      sha256: fake.executableHash,
    })),
  });
}
async function input() {
  const fixture = await fixtureInputs();
  const prepared = prepareInputs(
    fixture.request,
    fixture.accepted,
    () => true,
    DEFAULT_BUDGETS,
  );
  return canonicalBytes({
    version: 1,
    design: prepared.expanded,
    profile: fixture.request.profile,
    fonts: prepared.fonts,
    images: prepared.images,
    mode: "strict",
    budget: DEFAULT_BUDGETS,
  });
}
function browser() {
  const detach = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({
    arguments: ["--remote-debugging-pipe"],
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const newContext = vi.fn().mockRejectedValue(new Error("Context sentinel"));
  return {
    version: vi.fn(() => "153.0.8010.12"),
    newBrowserCDPSession: vi.fn().mockResolvedValue({ send, detach }),
    newContext,
    close,
    send,
    detach,
  };
}
const windows = it.runIf(
  process.platform === "win32" && process.arch === "x64",
);
windows.each(["version", "sandbox", "transport", "session", "cdp", "detach"])(
  "does not cache a browser rejected during %s verification",
  async (failure) => {
    const rejected = browser();
    if (failure === "version") rejected.version.mockReturnValue("wrong");
    if (failure === "sandbox")
      rejected.send.mockResolvedValue({
        arguments: ["--remote-debugging-pipe", "--no-sandbox"],
      });
    if (failure === "transport")
      rejected.send.mockResolvedValue({
        arguments: ["--remote-debugging-port=0"],
      });
    if (failure === "cdp")
      rejected.send.mockRejectedValue(new Error("CDP failure"));
    if (failure === "session")
      rejected.newBrowserCDPSession.mockRejectedValue(
        new Error("Session failure"),
      );
    if (failure === "detach")
      rejected.detach.mockRejectedValue(new Error("Detach failure"));
    fake.launch.mockResolvedValue(rejected);
    const instance = worker();
    const bytes = await input();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = JSON.parse(
          Buffer.from(
            await instance.render(bytes, {
              signal: new AbortController().signal,
            }),
          ).toString(),
        );
        expect(result.ok).toBe(false);
      }
      expect(fake.launch).toHaveBeenCalledTimes(2);
      expect(rejected.close).toHaveBeenCalledTimes(2);
      expect(rejected.newContext).not.toHaveBeenCalled();
    } finally {
      await instance.close?.();
    }
  },
);

windows.each(["route", "websocket", "page"])(
  "closes an acquired context when %s setup fails before page assignment",
  async (failure) => {
    const context = {
      route: vi.fn().mockResolvedValue(undefined),
      routeWebSocket: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockRejectedValue(new Error("Page failure")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    if (failure === "route")
      context.route.mockRejectedValue(new Error("Route failure"));
    if (failure === "websocket")
      context.routeWebSocket.mockRejectedValue(new Error("WebSocket failure"));
    const verified = browser();
    verified.newContext.mockResolvedValue(context);
    fake.launch.mockResolvedValue(verified);
    const instance = worker();
    try {
      const result = JSON.parse(
        Buffer.from(
          await instance.render(await input(), {
            signal: new AbortController().signal,
          }),
        ).toString(),
      );
      expect(result.ok).toBe(false);
      expect(context.close).toHaveBeenCalledOnce();
    } finally {
      await instance.close?.();
    }
  },
);

windows(
  "retains rejected-browser cleanup ownership without permitting reuse",
  async () => {
    const rejected = browser();
    rejected.version.mockReturnValue("wrong");
    rejected.close.mockRejectedValueOnce(new Error("Close failed"));
    fake.launch.mockResolvedValue(rejected);
    const instance = worker();
    const bytes = await input();
    const options = { signal: new AbortController().signal };
    expect(
      JSON.parse(Buffer.from(await instance.render(bytes, options)).toString()),
    ).toMatchObject({
      ok: false,
    });
    expect(
      JSON.parse(Buffer.from(await instance.render(bytes, options)).toString()),
    ).toMatchObject({
      ok: false,
      code: "OUTPUT_UNCERTAIN",
    });
    expect(fake.launch).toHaveBeenCalledOnce();
    expect(rejected.newContext).not.toHaveBeenCalled();
    await instance.close?.();
    expect(rejected.close).toHaveBeenCalledTimes(2);
  },
);

windows(
  "only a verified browser is reused after context setup failures",
  async () => {
    const verified = browser();
    fake.launch.mockResolvedValue(verified);
    const instance = worker();
    const bytes = await input();
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        await instance.render(bytes, { signal: new AbortController().signal });
      expect(fake.launch).toHaveBeenCalledOnce();
      expect(verified.newBrowserCDPSession).toHaveBeenCalledOnce();
      expect(verified.detach).toHaveBeenCalledOnce();
      expect(verified.newContext).toHaveBeenCalledTimes(2);
    } finally {
      await instance.close?.();
    }
  },
);

windows(
  "retains a failed context cleanup for close and preserves its primary error",
  async () => {
    const primary = new Error("Route failed");
    const cleanup = new Error("Context close failed");
    const context = {
      route: vi.fn().mockRejectedValue(primary),
      close: vi
        .fn()
        .mockRejectedValueOnce(cleanup)
        .mockResolvedValue(undefined),
    };
    const verified = browser();
    verified.newContext.mockResolvedValue(context);
    fake.launch.mockResolvedValue(verified);
    const instance = worker();
    const bytes = await input();
    const options = { signal: new AbortController().signal };
    await expect(instance.render(bytes, options)).rejects.toMatchObject({
      cause: primary,
      errors: [primary, cleanup],
    });
    expect(
      JSON.parse(Buffer.from(await instance.render(bytes, options)).toString()),
    ).toMatchObject({
      ok: false,
      code: "OUTPUT_UNCERTAIN",
    });
    expect(verified.newContext).toHaveBeenCalledOnce();
    await instance.close?.();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(verified.close).toHaveBeenCalledOnce();
  },
);
