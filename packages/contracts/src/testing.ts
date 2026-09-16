import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateContract } from "./boundary.js";
import type {
  ContractError,
  ErrorCode,
  Operation,
  ProviderCapabilities,
  RenderRequest,
  RenderResult,
  SourceSnapshot,
} from "./generated.js";
import { DEFAULT_BUDGETS } from "./profile.js";
import type {
  Clock,
  CredentialStore,
  DeviceProvider,
  FigmaProvider,
  FileSystemBoundary,
  OperationContext,
  Outcome,
  ProcessResult,
  ProcessRunner,
  Renderer,
  StagedArtifact,
} from "./providers.js";

export const systemTestClock: Clock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};

export function syntheticContext(
  overrides: Partial<OperationContext> = {},
): OperationContext {
  const now = Date.now();
  return {
    schemaVersion: "1.0",
    projectId: "project_synthetic",
    requestId: "request_synthetic",
    deadline: new Date(now + 30_000).toISOString(),
    budget: { ...DEFAULT_BUDGETS },
    authorization: {
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      actorId: "actor_synthetic",
      sessionId: "session_synthetic",
      expiresAt: new Date(now + 60_000).toISOString(),
      grants: [
        {
          resourceKind: "provider",
          resourceId: "fake-figma",
          operations: ["read"],
        },
        {
          resourceKind: "provider",
          resourceId: "fake-renderer",
          operations: ["render"],
        },
        {
          resourceKind: "device",
          resourceId: "device_synthetic",
          operations: ["read", "capture"],
        },
        {
          resourceKind: "provider",
          resourceId: "fake-device",
          operations: ["read"],
        },
        {
          resourceKind: "provider",
          resourceId: "fake-process",
          operations: ["execute"],
        },
      ],
      egress: "deny",
    },
    signal: new AbortController().signal,
    clock: systemTestClock,
    ...overrides,
  };
}

export interface FakeOptions<T> {
  projectId?: string;
  reply?: (context: OperationContext) => Promise<Outcome<T>>;
}

export function fakeError(
  code: ErrorCode,
  message = `Synthetic ${code}.`,
): ContractError {
  return { code, message, retryable: false, diagnosticIds: [] };
}

export function fakeComplete<T>(
  context: OperationContext,
  value: T,
): Extract<Outcome<T>, { status: "complete" }> {
  return {
    schemaVersion: "1.0",
    projectId: context.projectId,
    requestId: context.requestId,
    status: "complete",
    value,
    diagnosticIds: [],
  };
}

export function fakeFailure<T>(
  context: OperationContext,
  code: ErrorCode,
  status: "failed" | "unavailable" | "cancelled" | "interrupted" = "failed",
): Outcome<T> {
  return {
    schemaVersion: "1.0",
    projectId: context.projectId,
    requestId: context.requestId,
    status,
    error: fakeError(code),
    diagnosticIds: [],
  };
}

async function invokeFake<T>(
  options: FakeOptions<T>,
  resourceId: string,
  operation: Operation,
  context: OperationContext,
  resourceKind: "provider" | "device" | "artifact" | "credential" = "provider",
): Promise<Outcome<T>> {
  const projectId = options.projectId ?? "project_synthetic";
  if (
    context.projectId !== projectId ||
    context.authorization.projectId !== projectId
  )
    return fakeFailure(context, "FORBIDDEN");
  if (
    !validateContract("Budget", context.budget).success ||
    !validateContract("AuthorizationContext", context.authorization).success
  ) {
    return fakeFailure(context, "INVALID_INPUT");
  }
  if (context.signal.aborted)
    return fakeFailure(context, "CANCELLED", "cancelled");
  const remaining = Math.min(
    Date.parse(context.deadline) - context.clock.now(),
    context.budget.maxDurationMs,
  );
  if (!Number.isFinite(remaining) || remaining <= 0)
    return fakeFailure(context, "DEADLINE_EXCEEDED");
  if (Date.parse(context.authorization.expiresAt) <= context.clock.now())
    return fakeFailure(context, "AUTH_REQUIRED");
  if (
    !context.authorization.grants.some(
      (grant) =>
        grant.resourceKind === resourceKind &&
        grant.resourceId === resourceId &&
        grant.operations.includes(operation),
    )
  )
    return fakeFailure(context, "FORBIDDEN");
  if (!options.reply)
    return fakeFailure(context, "PROVIDER_UNAVAILABLE", "unavailable");
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = new Promise<Outcome<T>>((resolve) => {
      cancel = () => {
        controller.abort();
        resolve(fakeFailure(context, "CANCELLED", "cancelled"));
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      timeout = setTimeout(() => {
        controller.abort();
        resolve(fakeFailure(context, "DEADLINE_EXCEEDED"));
      }, remaining);
    });
    const result = await Promise.race([
      options.reply({ ...context, signal: controller.signal }),
      stopped,
    ]);
    if (
      result.projectId !== projectId ||
      result.requestId !== context.requestId
    )
      return fakeFailure(context, "ARTIFACT_INTEGRITY");
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancel) context.signal.removeEventListener("abort", cancel);
  }
}

function capabilities(
  providerId: string,
  context: OperationContext,
  operations: string[],
): ProviderCapabilities {
  return {
    schemaVersion: "1.0",
    providerId,
    projectId: context.projectId,
    implementation: "test-fake",
    host: {
      os: "synthetic",
      version: "1",
      architecture: "synthetic",
      evidence: "test-fake",
    },
    operations: operations.map((operation) => ({
      operation,
      availability: "unavailable",
      evidence: "test-fake",
      limitations: [
        "Scripted test utility only; no live platform capability is established.",
      ],
    })),
    cancellation: "cooperative",
    deadline: "required",
    limits: { ...DEFAULT_BUDGETS },
  };
}

export function createFakeFigmaProvider(
  options: FakeOptions<SourceSnapshot> = {},
): FigmaProvider {
  return {
    contractVersion: "1.0",
    getCapabilities: async (context) =>
      capabilities("fake-figma", context, [
        "readSnapshot",
        "acceptPluginSnapshot",
      ]),
    readSnapshot: (request, context) => {
      if (!validateContract("FigmaReadRequest", request).success)
        return Promise.resolve(fakeFailure(context, "NODE_SELECTION_REQUIRED"));
      return invokeFake(options, "fake-figma", "read", context);
    },
    acceptPluginSnapshot: (request, context) => {
      if (!validateContract("PluginSnapshotRequest", request).success)
        return Promise.resolve(fakeFailure(context, "INVALID_INPUT"));
      return invokeFake(options, "fake-figma", "read", context);
    },
  };
}

export function createFakeRenderer(
  options: FakeOptions<RenderResult> = {},
): Renderer {
  return {
    contractVersion: "1.0",
    getCapabilities: async (context) =>
      capabilities("fake-renderer", context, ["render"]),
    render: (request, context) => {
      if (!validateContract("RenderRequest", request).success)
        return Promise.resolve(fakeFailure(context, "INVALID_INPUT"));
      return invokeFake(options, "fake-renderer", "render", context);
    },
  };
}

export interface FakeDeviceOptions {
  projectId?: string;
  capture?: DeviceProvider["captureScreenshot"];
}

export function createFakeDeviceProvider(
  options: FakeDeviceOptions = {},
): DeviceProvider {
  return {
    contractVersion: "1.0",
    getCapabilities: async (context) =>
      capabilities("fake-device", context, [
        "android-emulator",
        "android-device",
        "ios-simulator",
        "ios-device",
      ]),
    listDevices: (context) =>
      invokeFake(options, "fake-device", "read", context),
    launchApp: (request, context) =>
      invokeFake(options, request.deviceId, "capture", context, "device"),
    openDeepLink: (request, context) =>
      invokeFake(options, request.deviceId, "capture", context, "device"),
    waitForIdle: (request, context) =>
      invokeFake(options, request.deviceId, "capture", context, "device"),
    captureScreenshot: (request, context) => {
      if (!validateContract("DeviceRequest", request).success)
        return Promise.resolve(
          fakeFailure(context, "DEVICE_SELECTION_REQUIRED"),
        );
      const capture = options.capture;
      return invokeFake(
        {
          ...options,
          ...(capture
            ? {
                reply: (current: OperationContext) => capture(request, current),
              }
            : {}),
        },
        request.deviceId,
        "capture",
        context,
        "device",
      );
    },
    getViewport: (request, context) =>
      invokeFake(options, request.deviceId, "read", context, "device"),
    getMetadata: (request, context) =>
      invokeFake(options, request.deviceId, "read", context, "device"),
  };
}

export function createFakeProcessRunner(
  options: FakeOptions<ProcessResult> = {},
): ProcessRunner {
  return {
    run: async (request, context) => {
      if (!validateContract("ProcessRequest", request).success)
        return fakeFailure(context, "INVALID_INPUT");
      const result = await invokeFake(
        options,
        "fake-process",
        "execute",
        context,
      );
      if (result.status === "complete") {
        if (result.value.exitCode !== 0 || result.value.signal !== null)
          return fakeFailure(context, "PROCESS_FAILED");
        if (
          result.value.stdout.byteLength > request.maxStdoutBytes ||
          result.value.stderr.byteLength > request.maxStderrBytes
        )
          return fakeFailure(context, "OUTPUT_LIMIT");
      }
      return result;
    },
  };
}

export function createFakeClock(
  initial = 0,
): Clock & { advance(milliseconds: number): void } {
  let now = initial;
  const sleepers = new Set<{ at: number; finish(): void }>();
  return {
    now: () => now,
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new RangeError(
          "Fake clock advance must be finite and nonnegative.",
        );
      now += milliseconds;
      for (const sleeper of sleepers) if (sleeper.at <= now) sleeper.finish();
    },
    sleep(milliseconds, signal) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        return Promise.reject(
          new RangeError("Sleep must be finite and nonnegative."),
        );
      return new Promise((resolve, reject) => {
        const abortError = () => {
          const error = new Error("Synthetic sleep cancelled.");
          error.name = "AbortError";
          return error;
        };
        if (signal.aborted) return reject(abortError());
        const cancel = () => {
          sleepers.delete(sleeper);
          reject(abortError());
        };
        const sleeper = {
          at: now + milliseconds,
          finish() {
            signal.removeEventListener("abort", cancel);
            sleepers.delete(sleeper);
            resolve();
          },
        };
        signal.addEventListener("abort", cancel, { once: true });
        sleepers.add(sleeper);
        if (milliseconds === 0) sleeper.finish();
      });
    },
  };
}

export function createFakeFileSystem(
  projectId = "project_synthetic",
): FileSystemBoundary {
  const files = new Map<string, Uint8Array>();
  const staging = new Map<
    string,
    { rootId: string; staged: StagedArtifact; bytes: Uint8Array }
  >();
  let sequence = 0;
  return {
    read(request, context) {
      if (!validateContract("FileRequest", request).success)
        return Promise.resolve(fakeFailure(context, "PATH_FORBIDDEN"));
      return invokeFake(
        {
          projectId,
          reply: async (current) => {
            const bytes = files.get(
              `${request.artifactRootId}/${request.path}`,
            );
            return bytes
              ? fakeComplete(current, bytes.slice())
              : fakeFailure(current, "RESOURCE_UNRESOLVED");
          },
        },
        request.artifactRootId,
        "read",
        context,
        "artifact",
      );
    },
    stage(request, bytes, context) {
      if (!validateContract("FileRequest", request).success)
        return Promise.resolve(fakeFailure(context, "PATH_FORBIDDEN"));
      if (bytes.byteLength > context.budget.maxOutputBytes)
        return Promise.resolve(fakeFailure(context, "OUTPUT_LIMIT"));
      return invokeFake(
        {
          projectId,
          reply: async (current) => {
            const id = `staging_${++sequence}`;
            const staged: StagedArtifact = {
              stagingId: id,
              artifact: {
                id,
                path: request.path,
                mediaType: "application/octet-stream",
                byteLength: bytes.byteLength,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              },
            };
            staging.set(id, {
              rootId: request.artifactRootId,
              staged,
              bytes: bytes.slice(),
            });
            return fakeComplete(current, structuredClone(staged));
          },
        },
        request.artifactRootId,
        "write",
        context,
        "artifact",
      );
    },
    publish(staged, context) {
      const pending = staging.get(staged.stagingId);
      if (!pending)
        return Promise.resolve(fakeFailure(context, "RESOURCE_UNRESOLVED"));
      return invokeFake(
        {
          projectId,
          reply: async (current) => {
            if (JSON.stringify(pending.staged) !== JSON.stringify(staged))
              return fakeFailure(current, "ARTIFACT_INTEGRITY");
            const key = `${pending.rootId}/${pending.staged.artifact.path}`;
            if (files.has(key)) return fakeFailure(current, "CONFLICT");
            files.set(key, pending.bytes);
            staging.delete(staged.stagingId);
            return fakeComplete(
              current,
              structuredClone(pending.staged.artifact),
            );
          },
        },
        pending.rootId,
        "write",
        context,
        "artifact",
      );
    },
    discard(stagingId, context) {
      const pending = staging.get(stagingId);
      if (!pending)
        return Promise.resolve(fakeFailure(context, "RESOURCE_UNRESOLVED"));
      return invokeFake(
        {
          projectId,
          reply: async (current) => {
            staging.delete(stagingId);
            return fakeComplete(current, { discarded: true as const });
          },
        },
        pending.rootId,
        "write",
        context,
        "artifact",
      );
    },
  };
}

export function createFakeCredentialStore(
  secrets: Readonly<Record<string, Uint8Array>>,
  projectId = "project_synthetic",
): CredentialStore {
  const stored = new Map(
    Object.entries(secrets).map(([id, bytes]) => [id, bytes.slice()]),
  );
  return {
    use(reference, context, consumer) {
      if (reference.store !== "test-fake")
        return Promise.resolve(fakeFailure(context, "FORBIDDEN"));
      return invokeFake(
        {
          projectId,
          reply: async (current) => {
            const secret = stored.get(reference.id);
            if (!secret) return fakeFailure(current, "RESOURCE_UNRESOLVED");
            const borrowed = secret.slice();
            try {
              return fakeComplete(current, await consumer(borrowed));
            } finally {
              borrowed.fill(0);
            }
          },
        },
        reference.id,
        "credential-use",
        context,
        "credential",
      );
    },
  };
}

export interface ProviderContractDriver {
  unavailable(context: OperationContext): Promise<Outcome<unknown>>;
  pending(context: OperationContext): Promise<Outcome<unknown>>;
}

export async function assertProviderContract(
  driver: ProviderContractDriver,
): Promise<void> {
  const context = syntheticContext();
  const unavailable = await driver.unavailable(context);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.projectId, context.projectId);
  assert.equal(unavailable.requestId, context.requestId);
  assert.ok(!("value" in unavailable));
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await driver.unavailable(
    syntheticContext({ signal: aborted.signal }),
  );
  assert.equal(cancelled.status, "cancelled");
  const expired = await driver.unavailable(
    syntheticContext({ deadline: "2000-01-01T00:00:00Z" }),
  );
  assert.ok("error" in expired);
  assert.equal(expired.error.code, "DEADLINE_EXCEEDED");
  const foreign = await driver.unavailable(
    syntheticContext({ projectId: "project_foreign" }),
  );
  assert.ok("error" in foreign);
  assert.equal(foreign.error.code, "FORBIDDEN");
  const ungranted = await driver.unavailable(
    syntheticContext({
      authorization: { ...context.authorization, grants: [] },
    }),
  );
  assert.ok("error" in ungranted);
  assert.equal(ungranted.error.code, "FORBIDDEN");
  const wrongKind = await driver.unavailable(
    syntheticContext({
      authorization: {
        ...context.authorization,
        grants: context.authorization.grants.map((grant) => ({
          ...grant,
          resourceKind: "repository",
        })),
      },
    }),
  );
  assert.ok("error" in wrongKind);
  assert.equal(wrongKind.error.code, "FORBIDDEN");
  const controller = new AbortController();
  const pending = driver.pending(
    syntheticContext({ signal: controller.signal }),
  );
  controller.abort();
  assert.equal((await pending).status, "cancelled");
  const timedOut = await driver.pending(
    syntheticContext({ budget: { ...DEFAULT_BUDGETS, maxDurationMs: 5 } }),
  );
  assert.ok("error" in timedOut);
  assert.equal(timedOut.error.code, "DEADLINE_EXCEEDED");
}

export function syntheticRenderRequest(): RenderRequest {
  const resources = {
    snapshotId: "resources_synthetic",
    sha256: "a".repeat(64),
    componentRegistryRevision: "1",
    tokenRegistryRevision: "1",
    selectedModes: { core: "light" },
  };
  const bounds = {
    x: 0,
    y: 0,
    width: 393,
    height: 852,
    unit: "design-unit",
  } as const;
  return {
    design: {
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      designId: "design_synthetic",
      screen: {
        id: "screen_synthetic",
        name: "Synthetic",
        viewport: { width: 393, height: 852, unit: "design-unit" },
      },
      resources,
      root: {
        id: "node_root",
        type: "column",
        layout: { width: "fill", height: "fill" },
        children: [],
      },
    },
    resources: {
      schemaVersion: "1.0",
      id: resources.snapshotId,
      projectId: "project_synthetic",
      components: {
        schemaVersion: "1.0",
        projectId: "project_synthetic",
        revision: "1",
        definitions: [],
        mappings: [],
      },
      tokens: {
        schemaVersion: "1.0",
        projectId: "project_synthetic",
        revision: "1",
        collections: [{ id: "core", modes: ["light"] }],
        selectedModes: { core: "light" },
        definitions: [],
        resolved: [],
        adapters: [],
      },
      assets: [],
      fonts: [],
    },
    revision: { id: "revision_synthetic", sha256: "a".repeat(64) },
    profile: {
      schemaVersion: "1.0",
      id: "profile_synthetic",
      renderer: { name: "test-fake", version: "1" },
      browser: { name: "not-executed", version: "1" },
      host: {
        os: "synthetic",
        version: "1",
        architecture: "synthetic",
        evidence: "test-fake",
      },
      viewport: bounds,
      deviceScale: 1,
      locale: "en-US",
      theme: "light",
      colorSpace: "srgb",
      fontHashes: [],
      assetHashes: [],
      frozenTime: "2026-09-16T00:00:00Z",
      state: {},
      capture: {
        bounds,
        scrollOffset: { x: 0, y: 0 },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        systemBars: "excluded",
      },
      motion: "disabled",
      network: "deny",
      fontFallback: "forbidden",
    },
    mode: "strict",
  };
}

export async function runProviderContractSuite(
  kind: "figma" | "renderer" | "device",
): Promise<void> {
  const pending = async <T>(): Promise<Outcome<T>> => new Promise(() => {});
  const request = { fileKey: "synthetic", nodeId: "1:2", version: "1" };
  if (kind === "figma") {
    await assertProviderContract({
      unavailable: (context) =>
        createFakeFigmaProvider().readSnapshot(request, context),
      pending: (context) =>
        createFakeFigmaProvider({ reply: pending }).readSnapshot(
          request,
          context,
        ),
    });
  } else if (kind === "renderer") {
    await assertProviderContract({
      unavailable: (context) =>
        createFakeRenderer().render(syntheticRenderRequest(), context),
      pending: (context) =>
        createFakeRenderer({ reply: pending }).render(
          syntheticRenderRequest(),
          context,
        ),
    });
  } else {
    const capture = {
      deviceId: "device_synthetic",
      scenarioId: "scenario_synthetic",
    };
    await assertProviderContract({
      unavailable: (context) =>
        createFakeDeviceProvider().captureScreenshot(capture, context),
      pending: (context) =>
        createFakeDeviceProvider({ capture: pending }).captureScreenshot(
          capture,
          context,
        ),
    });
  }
}
