import type { OperationContext } from "@design-studio/contracts";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  fetchRemote,
  publicAddress,
  type RemoteDependencies,
} from "../src/index.js";

function context(): OperationContext {
  return {
    schemaVersion: "1.0",
    projectId: "p",
    requestId: "r",
    deadline: new Date(Date.now() + 10_000).toISOString(),
    budget: { ...DEFAULT_BUDGETS, maxExternalCalls: 3 },
    authorization: {
      schemaVersion: "1.0",
      projectId: "p",
      actorId: "a",
      sessionId: "s",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grants: [],
      egress: "explicit-grant-required",
    },
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: async () => {} },
  };
}
function dependencies(): RemoteDependencies {
  return {
    allowedOrigins: ["https://assets.example"],
    authorize: vi.fn(async () => {}),
    resolve: vi.fn(async () => ["93.184.216.34"]),
    transport: vi.fn(async () => ({
      status: 200,
      peerAddress: "93.184.216.34",
      contentEncoding: "identity",
      body: (async function* () {
        yield Buffer.from("bytes");
      })(),
      close: vi.fn(),
    })),
  };
}
describe("remote boundary with fake pinned transport only", () => {
  it.each([
    ["authorization", "expiry", "AUTH_EXPIRED"],
    ["authorization", "cancellation", "CANCELLED"],
    ["authorization", "duration", "DURATION"],
    ["DNS", "expiry", "AUTH_EXPIRED"],
    ["DNS", "cancellation", "CANCELLED"],
    ["DNS", "duration", "DURATION"],
  ] as const)(
    "stops after %s changes %s before the next external action",
    async (phase, change, code) => {
      const dep = dependencies();
      const ctx = context();
      let now = Date.now();
      ctx.clock.now = () => now;
      ctx.authorization.expiresAt = new Date(now + 1000).toISOString();
      ctx.budget.maxDurationMs = change === "duration" ? 100 : 5000;
      const controller = new AbortController();
      ctx.signal = controller.signal;
      const changeState = () => {
        if (change === "cancellation") controller.abort();
        else now += change === "expiry" ? 1001 : 101;
      };
      if (phase === "authorization")
        dep.authorize = vi.fn(async () => {
          changeState();
        });
      else
        dep.resolve = vi.fn(async () => {
          changeState();
          return ["93.184.216.34"];
        });
      await expect(
        fetchRemote("https://assets.example/a", ctx, dep),
      ).rejects.toThrow(new RegExp(code));
      expect(dep.resolve).toHaveBeenCalledTimes(
        phase === "authorization" ? 0 : 1,
      );
      expect(dep.transport).not.toHaveBeenCalled();
    },
  );
  it("enforces elapsed budgets during immediately-ready streams, not only timer callbacks", async () => {
    const dep = dependencies();
    const ctx = context();
    let now = Date.now();
    ctx.clock.now = () => now;
    ctx.budget.maxDurationMs = 10;
    dep.transport = async () => ({
      status: 200,
      peerAddress: "93.184.216.34",
      close() {},
      body: (async function* () {
        for (let i = 0; i < 5; i++) {
          now += 5;
          yield Buffer.from("x");
        }
      })(),
    });
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/DURATION/);
  });
  it("re-resolves every redirect and rejects a destination becoming private", async () => {
    const dep = dependencies();
    dep.resolve = vi
      .fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["10.0.0.1"]);
    dep.transport = vi.fn(async () => ({
      status: 302,
      location: "/redirect",
      peerAddress: "93.184.216.34",
      body: (async function* () {})(),
      close() {},
    }));
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_DNS/);
    expect(dep.transport).toHaveBeenCalledTimes(1);
  });
  it.each(["transport", "body"] as const)(
    "times out stalled %s and closes an acquired response",
    async (part) => {
      const dep = dependencies();
      const close = vi.fn();
      dep.transport =
        part === "transport"
          ? () => new Promise(() => {})
          : async () => ({
              status: 200,
              peerAddress: "93.184.216.34",
              close,
              body: {
                [Symbol.asyncIterator]() {
                  return { next: () => new Promise(() => {}) };
                },
              },
            });
      const ctx = context();
      ctx.budget.maxDurationMs = 10;
      await expect(
        fetchRemote("https://assets.example/a", ctx, dep),
      ).rejects.toThrow(/DEADLINE/);
      if (part === "body") expect(close).toHaveBeenCalledOnce();
    },
  );
  it("fails auth response and short content length without refresh or cache fallback", async () => {
    const dep = dependencies();
    dep.transport = async () => ({
      status: 403,
      peerAddress: "93.184.216.34",
      body: (async function* () {})(),
      close() {},
    });
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_AUTH/);
    dep.transport = async () => ({
      status: 200,
      peerAddress: "93.184.216.34",
      contentLength: 2,
      body: (async function* () {
        yield Buffer.from("a");
      })(),
      close() {},
    });
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_TRUNCATED/);
  });
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
    "224.1.2.3",
  ])("rejects nonglobal address %s", (ip) => {
    expect(publicAddress(ip)).toBe(false);
  });
  it("pins resolved destination without treating URL as durable identity", async () => {
    const dep = dependencies();
    const result = await fetchRemote(
      "https://assets.example/image?token=secret",
      context(),
      dep,
    );
    expect(result.bytes.toString()).toBe("bytes");
    expect(result).not.toHaveProperty("url");
    expect(dep.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "93.184.216.34",
        serverName: "assets.example",
      }),
      expect.any(AbortSignal),
    );
  });
  it.each([
    "http://assets.example/a",
    "https://evil.example/a",
    "https://u:p@assets.example/a",
    "https://assets.example:444/a",
    "https://127.1/a",
    "file:///etc/passwd",
  ])("denies malicious URL %s", async (url) => {
    const dep = dependencies();
    await expect(fetchRemote(url, context(), dep)).rejects.toThrow(
      /REMOTE_URL/,
    );
    expect(dep.transport).not.toHaveBeenCalled();
  });
  it("defaults to zero external calls and denies expired authorization", async () => {
    const dep = dependencies();
    const ctx = context();
    ctx.budget.maxExternalCalls = 0;
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/EXTERNAL_CALLS/);
    ctx.authorization.expiresAt = "2020-01-01T00:00:00Z";
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/AUTH_EXPIRED/);
    expect(dep.resolve).not.toHaveBeenCalled();
  });
  it("rejects mixed public/private DNS answers and rebinding peer", async () => {
    const dep = dependencies();
    dep.resolve = async () => ["93.184.216.34", "10.0.0.1"];
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_DNS/);
    dep.resolve = async () => ["93.184.216.34"];
    dep.transport = async () => ({
      status: 200,
      peerAddress: "127.0.0.1",
      body: (async function* () {})(),
      close() {},
    });
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_PEER/);
  });
  it("checks every redirect origin and DNS before a second call", async () => {
    const dep = dependencies();
    dep.transport = vi.fn(async () => ({
      status: 302,
      peerAddress: "93.184.216.34",
      location: "https://evil.example/a",
      body: (async function* () {})(),
      close() {},
    }));
    await expect(
      fetchRemote("https://assets.example/a", context(), dep),
    ).rejects.toThrow(/REMOTE_URL/);
    expect(dep.transport).toHaveBeenCalledTimes(1);
  });
  it("bounds redirects, body bytes and compressed HTTP responses", async () => {
    const dep = dependencies();
    const ctx = context();
    ctx.budget.maxInputBytes = 4;
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/INPUT_BYTES/);
    dep.transport = async () => ({
      status: 302,
      location: "/again",
      peerAddress: "93.184.216.34",
      body: (async function* () {})(),
      close() {},
    });
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/EXTERNAL_CALLS/);
    dep.transport = async () => ({
      status: 200,
      contentEncoding: "gzip",
      peerAddress: "93.184.216.34",
      body: (async function* () {})(),
      close() {},
    });
    await expect(
      fetchRemote("https://assets.example/a", ctx, dep),
    ).rejects.toThrow(/REMOTE_ENCODING/);
  });
  it("cancels and times out stalled DNS/transport/body without fallback", async () => {
    const dep = dependencies();
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    dep.resolve = () => new Promise(() => {});
    const pending = fetchRemote("https://assets.example/a", ctx, dep);
    controller.abort();
    await expect(pending).rejects.toThrow(/CANCELLED/);
    const timeout = context();
    timeout.budget.maxDurationMs = 10;
    await expect(
      fetchRemote("https://assets.example/a", timeout, dep),
    ).rejects.toThrow(/DEADLINE/);
  });
  it("does not expose signed URLs or transport exception contents", async () => {
    const dep = dependencies();
    dep.transport = async () => {
      throw new Error("token=secret");
    };
    await expect(
      fetchRemote("https://assets.example/a?token=secret", context(), dep),
    ).rejects.toThrow("REMOTE_IO: Remote transport failed");
  });
});
