import { mkdtemp, readFile, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Artifact,
  DEFAULT_BUDGETS,
  type OperationContext,
  parseContract,
  type RenderRequest,
} from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { RendererWorkerHost } from "@design-studio/renderer-host";
import { installedBuildIdentity } from "../src/profile.js";
import type { AcceptedInputs } from "../src/resources.js";

const fixtureRoot = path.resolve("tests/fixtures/foundation");
export async function fixtureInputs(name = "mixed-styled-text") {
  const designBytes = await readFile(
    path.join(fixtureRoot, `${name}.design.json`),
  );
  const resourceBytes = await readFile(
    path.join(fixtureRoot, "resources.json"),
  );
  const design = parseContract("DesignIR", designBytes.toString(), "json");
  if (!design.screen.capture)
    throw new Error("Fixture capture profile is required.");
  const resources = parseContract(
    "ResourceSnapshot",
    resourceBytes.toString(),
    "json",
  );
  const manifest: { files: Artifact[] } = JSON.parse(
    await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"),
  );
  const artifacts = await Promise.all(
    manifest.files.map(async (artifact) => ({
      artifact,
      bytes: await readFile(path.join(fixtureRoot, artifact.path)),
    })),
  );
  const revision = { id: "revision_fixture", sha256: hashBytes(designBytes) };
  const request: RenderRequest = {
    design,
    resources,
    revision,
    mode: "strict",
    profile: {
      schemaVersion: "1.0",
      id: "windows_static_v1",
      renderer: (await installedBuildIdentity()).renderer,
      browser: {
        name: "chromium-headless-shell",
        version: "153.0.8010.12",
        sha256:
          "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c",
      },
      host: {
        os: "windows",
        version: release(),
        architecture: "x64",
        evidence: "observed",
      },
      viewport: { x: 0, y: 0, ...design.screen.viewport },
      deviceScale: 1,
      locale: "en-US",
      theme: "light",
      colorSpace: "srgb",
      fontHashes: resources.fonts.flatMap((f) =>
        f.kind === "bundled"
          ? [{ id: f.artifact.id, sha256: f.artifact.sha256 }]
          : [],
      ),
      assetHashes: resources.assets.map((a) => ({
        id: a.artifact.id,
        sha256: a.artifact.sha256,
      })),
      frozenTime: "2026-09-16T00:00:00Z",
      state: {},
      capture: design.screen.capture,
      motion: "disabled",
      network: "deny",
      fontFallback: "forbidden",
    },
  };
  const accepted: AcceptedInputs = {
    revision,
    designBytes,
    resourceBytes,
    artifacts,
  };
  return { request, accepted };
}
export async function workerHarness(calibration = false) {
  const implementation = fileURLToPath(
    new URL("fixtures/render-worker.mjs", import.meta.url),
  );
  const implementationHash = hashBytes(await readFile(implementation));
  const nodeHash = hashBytes(await readFile(process.execPath));
  const root = await mkdtemp(path.join(tmpdir(), "f06 render test \u00e9 "));
  const clock = new SystemClock();
  const authenticator = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47111"],
    origins: ["http://127.0.0.1:47111"],
  });
  const session = authenticator.createSession(
    {
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      actorId: "test_actor",
      sessionId: "test_session",
      expiresAt: new Date(
        clock.now() + (calibration ? 240_000 : 120_000),
      ).toISOString(),
      egress: "deny",
      grants: [
        {
          resourceKind: "provider",
          resourceId: "renderer_static",
          operations: ["execute"],
        },
        {
          resourceKind: "artifact",
          resourceId: "render_outputs",
          operations: ["read", "write"],
        },
      ],
    },
    "cli",
  );
  const authorization = authenticator.authenticate({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:47111",
    method: "POST",
    bearer: session.credential,
  });
  const lifetime = calibration ? 180_000 : 30_000;
  const leaseBudget = {
    ...DEFAULT_BUDGETS,
    maxDurationMs: lifetime,
    maxInputBytes: calibration
      ? 250 * 1024 * 1024
      : DEFAULT_BUDGETS.maxInputBytes,
    maxOutputBytes: calibration
      ? 250 * 1024 * 1024
      : DEFAULT_BUDGETS.maxOutputBytes,
  };
  const deadline = new Date(clock.now() + lifetime).toISOString();
  const context = (id: string, opening = false): OperationContext => ({
    schemaVersion: "1.0",
    projectId: "project_synthetic",
    requestId: id,
    deadline,
    authorization,
    clock,
    signal: new AbortController().signal,
    budget: opening ? leaseBudget : { ...DEFAULT_BUDGETS },
  });
  const host = new RendererWorkerHost({
    projectId: "project_synthetic",
    providerId: "renderer_static",
    authority: authenticator.authority,
    node: {
      path: process.execPath,
      sha256: nodeHash,
      maxBytes: 200_000_000,
    },
    implementation: {
      path: implementation,
      sha256: implementationHash,
      maxBytes: 1_000_000,
    },
    tempRoot: root,
    trustedExclusiveAccess: true,
    budgetLimits: leaseBudget,
    environment: { SystemRoot: process.env.SystemRoot ?? "", TZ: "UTC" },
    limits: {
      startMs: 15_000,
      idleMs: 10_000,
      lifetimeMs: lifetime,
      closeMs: 5_000,
      maxFrameBytes: 20_000_000,
      maxInputBytes: leaseBudget.maxInputBytes,
      maxOutputBytes: leaseBudget.maxOutputBytes,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 16_384,
      maxRequests: calibration ? 32 : 16,
    },
  });
  return {
    root,
    context,
    host,
    authority: authenticator.authority,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
