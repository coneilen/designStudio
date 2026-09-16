import { describe, expect, it } from "vitest";
import type { DeviceProvider, FigmaProvider, Renderer } from "../src/index.js";
import {
  createFakeClock,
  createFakeCredentialStore,
  createFakeDeviceProvider,
  createFakeFigmaProvider,
  createFakeFileSystem,
  createFakeProcessRunner,
  createFakeRenderer,
  fakeComplete,
  fakeError,
  runProviderContractSuite,
  syntheticContext,
} from "../src/testing.js";

describe("reusable provider boundary contracts", () => {
  it.each(["figma", "renderer", "device"] as const)(
    "enforces project, cancellation, deadlines and honest outcomes for %s",
    async (kind) => {
      await runProviderContractSuite(kind);
    },
  );

  it("requires explicit device identity and defaults fakes to unavailable, not successful captures", async () => {
    const context = syntheticContext();
    const device: DeviceProvider = createFakeDeviceProvider();
    const result = await device.captureScreenshot(
      { deviceId: "device_synthetic", scenarioId: "scenario_synthetic" },
      context,
    );
    expect(result.status).toBe("unavailable");
    expect(result).not.toHaveProperty("value");
    const figma: FigmaProvider = createFakeFigmaProvider();
    expect((await figma.getCapabilities(context)).implementation).toBe(
      "test-fake",
    );
    const renderer: Renderer = createFakeRenderer();
    expect((await renderer.getCapabilities(context)).implementation).toBe(
      "test-fake",
    );
  });

  it("keeps complete/partial/unavailable and foreign replies distinct", async () => {
    const context = syntheticContext();
    const request = { fileKey: "synthetic", nodeId: "1:2", version: "1" };
    const source = {
      schemaVersion: "1.0",
      id: "source_synthetic",
      projectId: context.projectId,
      identity: {
        transport: "synthetic",
        fixtureId: "fixture_synthetic",
        contentDigest: "a".repeat(64),
      },
      capturedAt: "2026-09-16T00:00:00Z",
      captureEndedAt: "2026-09-16T00:00:00Z",
      consistency: { guarantee: "synthetic-immutable", limitations: [] },
      completeness: "partial",
      requests: [],
      artifacts: [],
      missing: ["reference"],
      diagnosticIds: [],
    } as const;
    const snapshot = structuredClone({
      ...source,
      consistency: { ...source.consistency, limitations: [] },
      requests: [],
      artifacts: [],
      missing: ["reference"],
      diagnosticIds: [],
    });
    const partial = await createFakeFigmaProvider({
      reply: async (current) => ({
        schemaVersion: "1.0",
        projectId: current.projectId,
        requestId: current.requestId,
        status: "partial",
        value: snapshot,
        missing: ["reference"],
        error: fakeError("SOURCE_INCOMPLETE"),
        diagnosticIds: [],
      }),
    }).readSnapshot(request, context);
    expect(partial.status).toBe("partial");
    const foreign = await createFakeFigmaProvider({
      reply: async (current) => ({
        ...fakeComplete(current, snapshot),
        projectId: "project_foreign",
      }),
    }).readSnapshot(request, context);
    expect(foreign).toMatchObject({
      status: "failed",
      error: { code: "ARTIFACT_INTEGRITY" },
    });
  });

  it("preserves binary process output and literal argument arrays without launching a process", async () => {
    const bytes = Uint8Array.of(0, 255, 13, 10, 26);
    const runner = createFakeProcessRunner({
      reply: async (context) =>
        fakeComplete(context, {
          exitCode: 0,
          signal: null,
          stdout: bytes,
          stderr: new Uint8Array(),
          durationMs: 0,
        }),
    });

    const request = {
      toolId: "tool_synthetic",
      executable: "C:\\Synthetic Tools\\tool.exe",
      args: ["", "a&b", "line\r\nbreak", "é"],
      cwd: "C:\\Synthetic Work",
      timeoutMs: 100,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
      shell: false,
    } as const;
    const result = await runner.run(
      { ...request, args: [...request.args] },
      syntheticContext(),
    );
    expect(result).toMatchObject({
      status: "complete",
      value: { stdout: bytes },
    });
  });

  it("does not turn nonzero process exit or overflowing binary stdout into success", async () => {
    const context = syntheticContext();
    const request = {
      toolId: "tool_synthetic",
      executable: "C:\\synthetic.exe",
      args: [],
      cwd: "C:\\synthetic",
      timeoutMs: 100,
      maxStdoutBytes: 1,
      maxStderrBytes: 1,
      shell: false,
    } as const;
    for (const [exitCode, stdout, code] of [
      [7, Uint8Array.of(137), "PROCESS_FAILED"],
      [0, Uint8Array.of(0, 255), "OUTPUT_LIMIT"],
    ] as const) {
      const runner = createFakeProcessRunner({
        reply: async (current) =>
          fakeComplete(current, {
            exitCode,
            signal: null,
            stdout,
            stderr: new Uint8Array(),
            durationMs: 0,
          }),
      });
      expect(await runner.run({ ...request, args: [] }, context)).toMatchObject(
        { status: "failed", error: { code } },
      );
    }
  });

  it("provides isolated in-memory filesystem bytes and a scoped credential callback", async () => {
    const context = syntheticContext();
    context.authorization.grants.push(
      {
        resourceKind: "artifact",
        resourceId: "root_synthetic",
        operations: ["read", "write"],
      },
      {
        resourceKind: "credential",
        resourceId: "credential_synthetic",
        operations: ["credential-use"],
      },
    );
    const filesystem = createFakeFileSystem();
    const staged = await filesystem.stage(
      { artifactRootId: "root_synthetic", path: "assets/name with spaces.bin" },
      Uint8Array.of(0, 255, 13, 10),
      context,
    );
    expect(staged.status).toBe("complete");
    if (staged.status !== "complete")
      throw new Error("Stage did not complete.");
    expect(
      (
        await filesystem.read(
          {
            artifactRootId: "root_synthetic",
            path: staged.value.artifact.path,
          },
          context,
        )
      ).status,
    ).not.toBe("complete");
    expect((await filesystem.publish(staged.value, context)).status).toBe(
      "complete",
    );
    const read = await filesystem.read(
      { artifactRootId: "root_synthetic", path: staged.value.artifact.path },
      context,
    );
    expect(read).toMatchObject({
      status: "complete",
      value: Uint8Array.of(0, 255, 13, 10),
    });
    const credentials = createFakeCredentialStore({
      credential_synthetic: Uint8Array.of(1, 2, 3),
    });
    let borrowed: Uint8Array | undefined;
    const used = await credentials.use(
      {
        id: "credential_synthetic",
        providerId: "provider_synthetic",
        store: "test-fake",
      },
      context,
      async (secret) => {
        borrowed = secret;
        return secret.byteLength;
      },
    );
    expect(used).toMatchObject({ status: "complete", value: 3 });
    expect(borrowed).toEqual(Uint8Array.of(0, 0, 0));
  });

  it("advances a deterministic fake clock and cancels pending sleeps", async () => {
    const clock = createFakeClock(1000);
    const controller = new AbortController();
    const asleep = clock.sleep(5, controller.signal);
    clock.advance(5);
    await asleep;
    expect(clock.now()).toBe(1005);
    const cancelled = clock.sleep(5, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});
