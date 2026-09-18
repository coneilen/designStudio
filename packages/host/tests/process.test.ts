import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  OperationContext,
  ProcessRequest,
} from "@design-studio/contracts";
import {
  assertProviderContract,
  createFakeClock,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BoundedProcessRunner, ConfiguredToolLocator } from "../src/process.js";

let cwd: string;
let hash: string;
const scripts = [
  [
    "-e",
    "process.stdout.write(Buffer.from([0,255,13,10]));process.stderr.write(Buffer.from([128]));",
  ],
  ["-e", "process.exit(7)"],
  ["-e", "setTimeout(()=>{},30000)"],
  ["-e", "process.stderr.write(Buffer.alloc(100000));"],
  [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "space here",
    "C:\\Program Files\\sample\\",
    '"quoted"',
    "&|<>",
  ],
];
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "studio process owned "));
  hash = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});
function setup() {
  const locator = new ConfiguredToolLocator({
    projectId: "project_synthetic",
    authority: () => true,
    tools: [
      {
        id: "fake-process",
        executable: process.execPath,
        identity: { name: "node", version: process.version, sha256: hash },
        platforms: [process.platform],
        maxExecutableBytes: 200_000_000,
        commands: scripts.map((args) => ({ args, cwd })),
        environment: {},
        spawnsDescendants: false,
      },
    ],
  });
  return { locator, runner: new BoundedProcessRunner(locator) };
}
function request(index: number): ProcessRequest {
  return {
    toolId: "fake-process",
    executable: process.execPath,
    args: scripts[index] ?? [],
    cwd,
    timeoutMs: 5000,
    maxStdoutBytes: 10000,
    maxStderrBytes: 10000,
    shell: false,
  };
}
it("snapshots process requests before asynchronous executable validation", async () => {
  const { runner } = setup();
  const input = request(0);
  const running = runner.run(input, syntheticContext());
  input.args = scripts[1] ?? [];
  expect(await running).toMatchObject({
    status: "complete",
    value: { exitCode: 0 },
  });
});
it("returns binary stdout/stderr and preserves Windows-style arguments without a shell", async () => {
  const { runner } = setup();
  const result = await runner.run(request(0), syntheticContext());
  expect(result).toMatchObject({
    status: "complete",
    value: {
      stdout: Uint8Array.from([0, 255, 13, 10]),
      stderr: Uint8Array.of(128),
      exitCode: 0,
    },
  });
  const argumentsResult = await runner.run(request(4), syntheticContext());
  expect(argumentsResult.status).toBe("complete");
  if (argumentsResult.status === "complete") {
    expect(
      JSON.parse(new TextDecoder().decode(argumentsResult.value.stdout)),
    ).toEqual(scripts[4]?.slice(2));
  }
});
it("reports nonzero, missing, mismatched executable and unapproved args explicitly", async () => {
  const { runner, locator } = setup();
  expect(await runner.run(request(1), syntheticContext())).toMatchObject({
    status: "partial",
    value: { exitCode: 7 },
    error: { code: "PROCESS_FAILED" },
  });
  expect(
    await locator.locate("not-configured", syntheticContext()),
  ).toMatchObject({ status: "failed" });
  expect(
    await runner.run(
      { ...request(0), args: ["-e", "untrusted()"] },
      syntheticContext(),
    ),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(
    await runner.run(
      { ...request(0), executable: "cmd.exe" },
      syntheticContext(),
    ),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
});
it("bounds combined binary output, stderr, deadline and cancellation, cleaning owned children", async () => {
  const { runner } = setup();
  expect(
    await runner.run({ ...request(3), maxStderrBytes: 10 }, syntheticContext()),
  ).toMatchObject({ error: { code: "OUTPUT_LIMIT" } });
  expect(
    await runner.run(
      request(0),
      syntheticContext({
        budget: { ...syntheticContext().budget, maxOutputBytes: 4 },
      }),
    ),
  ).toMatchObject({ error: { code: "OUTPUT_LIMIT" } });
  expect(
    await runner.run({ ...request(2), timeoutMs: 30 }, syntheticContext()),
  ).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
  const controller = new AbortController();
  const running = runner.run(
    request(2),
    syntheticContext({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 30);
  expect(await running).toMatchObject({ status: "cancelled" });
  expect(runner.activeProcessCount).toBe(0);
});
it("runs the shared provider contract driver against real controlled children", async () => {
  const { runner } = setup();
  const unavailableLocator = new ConfiguredToolLocator({
    projectId: "project_synthetic",
    authority: () => true,
    tools: [
      {
        id: "fake-process",
        executable: path.join(cwd, "missing-node.exe"),
        identity: { name: "node", version: "1", sha256: hash },
        platforms: [process.platform],
        commands: [],
        environment: {},
        spawnsDescendants: false,
        maxExecutableBytes: 200_000_000,
      },
    ],
  });
  const pending = (context: OperationContext) =>
    runner.run(request(2), context);
  await assertProviderContract({
    unavailable: (context) =>
      unavailableLocator.locate("fake-process", context),
    pending,
  });
});
it("applies a virtual deadline to an already running owned child without changing fake-clock semantics", async () => {
  const { runner } = setup();
  const clock = createFakeClock(Date.now());
  const running = runner.run(
    { ...request(2), timeoutMs: 1000 },
    syntheticContext({ clock }),
  );
  await expect
    .poll(() => runner.activeProcessCount, { timeout: 4000, interval: 10 })
    .toBe(1);
  clock.advance(999);
  expect(runner.activeProcessCount).toBe(1);
  clock.advance(1);
  expect(await running).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
  expect(runner.activeProcessCount).toBe(0);
});
it("terminates an already running child on real deadline and cancellation, not just preflight expiry", async () => {
  const { runner } = setup();
  const timed = runner.run(
    { ...request(2), timeoutMs: 2000 },
    syntheticContext(),
  );
  await expect
    .poll(() => runner.activeProcessCount, { timeout: 1800, interval: 10 })
    .toBe(1);
  expect(await timed).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
  expect(runner.activeProcessCount).toBe(0);
  const controller = new AbortController();
  const cancelled = runner.run(
    request(2),
    syntheticContext({ signal: controller.signal }),
  );
  await expect
    .poll(() => runner.activeProcessCount, { timeout: 4000, interval: 10 })
    .toBe(1);
  controller.abort();
  expect(await cancelled).toMatchObject({ status: "cancelled" });
  expect(runner.activeProcessCount).toBe(0);
}, 10_000);
