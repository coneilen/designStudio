import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGETS,
  type OperationContext,
} from "@design-studio/contracts";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { RendererWorkerHost } from "@design-studio/renderer-host";
import { expect, it } from "vitest";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

it
  .skipIf(process.env.F06_BROWSER_GATE !== "1")
  .each(["graceful", "worker-crash"])(
  "real Windows owned Chromium preserves sandbox, pipe transport and observed %s cleanup",
  async (mode) => {
    expect(process.platform).toBe("win32");
    expect(process.arch).toBe("x64");
    expect(process.version).toBe("v24.21.0");
    const implementation = fileURLToPath(
      new URL("fixtures/browser-gate.mjs", import.meta.url),
    );
    const clock = new SystemClock();
    const auth = new LocalSessionAuthenticator({
      clock,
      hosts: ["127.0.0.1:47111"],
      origins: ["http://127.0.0.1:47111"],
    });
    const credentials = auth.createSession(
      {
        schemaVersion: "1.0",
        projectId: "renderer_gate",
        actorId: "test_actor",
        sessionId: "test_session",
        expiresAt: new Date(clock.now() + 120_000).toISOString(),
        grants: [
          {
            resourceKind: "provider",
            resourceId: "renderer_static",
            operations: ["execute"],
          },
        ],
        egress: "deny",
      },
      "cli",
    );
    const context: OperationContext = {
      schemaVersion: "1.0",
      projectId: "renderer_gate",
      requestId: "gate",
      authorization: auth.authenticate({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:47111",
        method: "POST",
        bearer: credentials.credential,
      }),
      clock,
      signal: new AbortController().signal,
      deadline: new Date(clock.now() + 30_000).toISOString(),
      budget: { ...DEFAULT_BUDGETS },
    };
    const root = await mkdtemp(path.join(tmpdir(), "f06 sandbox gate "));
    try {
      const host = new RendererWorkerHost({
        projectId: context.projectId,
        providerId: "renderer_static",
        authority: auth.authority,
        node: {
          path: process.execPath,
          sha256: hash(await readFile(process.execPath)),
          maxBytes: 200_000_000,
        },
        implementation: {
          path: implementation,
          sha256: hash(await readFile(implementation)),
          maxBytes: 1_000_000,
        },
        tempRoot: root,
        trustedExclusiveAccess: true,
        environment: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
        limits: {
          startMs: 10_000,
          idleMs: 10_000,
          lifetimeMs: 30_000,
          closeMs: 5_000,
          maxFrameBytes: 1_000_000,
          maxInputBytes: 2_000_000,
          maxOutputBytes: 2_000_000,
          maxStdoutBytes: 16_384,
          maxStderrBytes: 16_384,
          maxRequests: 2,
        },
      });
      const opened = await host.open(context);
      expect(opened.status, JSON.stringify(opened)).toBe("complete");
      if (opened.status !== "complete") return;
      const lease = opened.value;
      try {
        const reply = await lease.exchange(
          Uint8Array.of(mode === "worker-crash" ? 2 : 1),
          context,
        );
        if (mode === "worker-crash") {
          expect(reply).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_FAILED" },
          });
          return;
        }
        expect(reply.status, JSON.stringify(reply)).toBe("complete");
        if (reply.status !== "complete") return;
        const result = JSON.parse(new TextDecoder().decode(reply.value));
        expect(result).toMatchObject({
          version: "153.0.8010.12",
          sandboxDisabled: false,
          pipe: true,
          debugPort: false,
          pngSignature: "89504e470d0a1a0a",
        });
      } finally {
        expect(await lease.close()).toMatchObject({
          status: "complete",
          value: {
            workerExitObserved: true,
            jobEmptyObserved: true,
            mode: mode === "worker-crash" ? "forced" : "graceful",
          },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);
