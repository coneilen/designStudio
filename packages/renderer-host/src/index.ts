import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Budget,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";
import {
  type Authority,
  boundary,
  ConfiguredToolLocator,
  HostBoundaryError,
  OperationGuard,
  snapshotOperationContext,
} from "@design-studio/host";
import {
  type PinnedFile,
  realDirectory,
  validatePin,
  verifyFile,
} from "./identity.js";
import { WorkerLease } from "./lease.js";
import { loadJobs, type OwnedJob } from "./windows-job.js";

export type { PinnedFile } from "./identity.js";
export type {
  CleanupReport,
  RendererWorkerLease,
  TrustedRendererImplementation,
} from "./lease.js";
export interface WorkerLimits {
  startMs: number;
  idleMs: number;
  lifetimeMs: number;
  closeMs: number;
  maxFrameBytes: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxRequests: number;
}
export interface RendererWorkerOptions {
  projectId: string;
  providerId: string;
  authority: Authority;
  node: PinnedFile;
  implementation: PinnedFile;
  environment: Readonly<Record<string, string>>;
  tempRoot: string;
  trustedExclusiveAccess: boolean;
  limits: WorkerLimits;
  budgetLimits?: Readonly<Budget>;
}
const bootstrap = fileURLToPath(
  new URL("../src/bootstrap.mjs", import.meta.url),
);
// Pin the packaged bootstrap, not a caller-selected script. Keep in sync on reviewed changes.
const BOOTSTRAP_SHA256 =
  "4db8ff03cbfee2fc40f4151de738da2763ba5a28972ec3c2fb5f980ec712bb15";
export class RendererWorkerHost {
  private readonly options: RendererWorkerOptions;
  constructor(options: RendererWorkerOptions) {
    if (
      !validateContract("StableId", options.projectId).success ||
      !validateContract("StableId", options.providerId).success ||
      typeof options.authority !== "function" ||
      options.trustedExclusiveAccess !== true ||
      !path.isAbsolute(options.tempRoot) ||
      options.tempRoot.startsWith("\\\\") ||
      options.tempRoot.includes("\0")
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid trusted renderer configuration.",
      );
    validatePin(options.node);
    validatePin(options.implementation);
    if (
      path.basename(options.node.path).toLowerCase() !== "node.exe" ||
      !/\.(mjs|js)$/.test(options.implementation.path)
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Only pinned Node and a trusted JavaScript renderer entry are supported.",
      );
    const limits = options.limits;
    const ceilings: WorkerLimits = {
      startMs: 30000,
      idleMs: 30000,
      lifetimeMs: 300000,
      closeMs: 5000,
      maxFrameBytes: 25 * 1024 * 1024,
      maxInputBytes: 250 * 1024 * 1024,
      maxOutputBytes: 250 * 1024 * 1024,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      maxRequests: 1000,
    };
    for (const key of Object.keys(ceilings) as (keyof WorkerLimits)[])
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] <= 0 ||
        limits[key] > ceilings[key]
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          `Invalid renderer limit: ${key}.`,
        );
    if (
      limits.maxFrameBytes >
      Math.min(limits.maxInputBytes, limits.maxOutputBytes)
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Frame bound exceeds lease byte bounds.",
      );
    const names = new Set<string>();
    for (const [key, value] of Object.entries(options.environment)) {
      const upper = key.toUpperCase();
      if (
        !["SYSTEMROOT", "WINDIR", "LANG", "TZ"].includes(upper) ||
        names.has(upper) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        value.length > 1024 ||
        (upper === "TZ" && value !== "UTC") ||
        (["SYSTEMROOT", "WINDIR"].includes(upper) &&
          value.toLowerCase() !== (process.env.SystemRoot ?? "").toLowerCase())
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Renderer environment is outside the fixed allowlist.",
        );
      names.add(upper);
    }
    this.options = Object.freeze({
      ...options,
      node: Object.freeze({ ...options.node }),
      implementation: Object.freeze({ ...options.implementation }),
      environment: Object.freeze({ ...options.environment }),
      limits: Object.freeze({ ...limits }),
      ...(options.budgetLimits
        ? { budgetLimits: Object.freeze({ ...options.budgetLimits }) }
        : {}),
    });
  }
  open(
    context: OperationContext,
  ): Promise<Outcome<import("./lease.js").RendererWorkerLease>> {
    return boundary(context, async (context) => {
      context = snapshotOperationContext(context);
      const options = this.options;
      const guard = new OperationGuard(
        context,
        {
          projectId: options.projectId,
          resourceKind: "provider",
          resourceId: options.providerId,
          operation: "execute",
        },
        options.authority,
        options.limits.lifetimeMs,
        options.budgetLimits,
      );
      const native = await loadJobs();
      await realDirectory(options.tempRoot);
      await verifyFile(options.implementation, guard);
      await verifyFile(
        { path: bootstrap, sha256: BOOTSTRAP_SHA256, maxBytes: 16000 },
        guard,
      );
      const locator = new ConfiguredToolLocator({
        projectId: options.projectId,
        authority: options.authority,
        ...(options.budgetLimits ? { budgetLimits: options.budgetLimits } : {}),
        tools: [
          {
            id: options.providerId,
            executable: options.node.path,
            identity: {
              name: "node",
              version: "24.21.0",
              sha256: options.node.sha256,
            },
            platforms: ["win32"],
            maxExecutableBytes: options.node.maxBytes,
            commands: [],
            environment: options.environment,
            spawnsDescendants: false,
          },
        ],
      });
      // Reuse the host's trusted pin inspection, not its descendant-rejecting runner.
      await locator.approved(options.providerId, context, guard);
      guard.check();
      const directory = await mkdtemp(
        path.join(options.tempRoot, "renderer-owned-"),
      );
      let job: OwnedJob | undefined;
      let lease: WorkerLease | undefined;
      try {
        const name = `Local\\design-studio-${randomUUID()}`;
        job = native.create(name);
        guard.check();
        const nonce = randomBytes(32).toString("hex");
        const child = spawn(
          options.node.path,
          [
            bootstrap,
            JSON.stringify({
              job: name,
              nonce,
              implementation: options.implementation,
              maxFrameBytes: options.limits.maxFrameBytes,
            }),
          ],
          {
            cwd: directory,
            env: { ...options.environment, TEMP: directory, TMP: directory },
            stdio: ["ignore", "pipe", "pipe", "overlapped"],
            shell: false,
            windowsHide: true,
          },
        );
        lease = new WorkerLease(options, guard, job, child, directory, nonce);
        await lease.start();
        lease.assertLive();
        return lease;
      } catch (cause) {
        // A created lease owns cleanup, including failures during start.
        if (lease) {
          const cleanup = await lease.close();
          if (cleanup.status !== "complete")
            throw new HostBoundaryError(
              "INTERRUPTED",
              `Worker start failed; ${"error" in cleanup && cleanup.error ? cleanup.error.message : "Cleanup remains uncertain."}`,
              false,
              { cause },
            );
          if (cause instanceof HostBoundaryError) throw cause;
          throw new HostBoundaryError(
            "PROCESS_FAILED",
            "Renderer start failed.",
            false,
            { cause },
          );
        }
        const errors: unknown[] = [cause];
        try {
          job?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 1)
          throw new HostBoundaryError(
            "INTERRUPTED",
            "Renderer start and owned cleanup failed.",
            false,
            { cause: new AggregateError(errors) },
          );
        if (cause instanceof HostBoundaryError) throw cause;
        throw new HostBoundaryError(
          "PROCESS_FAILED",
          "Renderer worker could not start.",
          false,
          { cause },
        );
      }
    });
  }
}
