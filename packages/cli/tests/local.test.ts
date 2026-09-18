import { success } from "@design-studio/application";
import { afterEach, expect, it, vi } from "vitest";
import { parseArguments } from "../src/arguments.js";
import { callLocal } from "../src/local.js";

afterEach(() => vi.useRealTimers());

it.each(["doctor", "openapi"])(
  "rejects a late local %s result even when the application ignores cancellation",
  async (command) => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = callLocal(
      parseArguments([command, "--timeout-ms", "100"]),
      {
        async call(_invocation, signal) {
          observed = signal;
          await gate;
          return {
            kind: "json" as const,
            envelope: success("late", {
              kind: "service",
              state: "stopped",
              projectId: "project_synthetic",
              warnings: [],
            }),
          };
        },
      },
    );
    const result = pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(observed?.aborted).toBe(true);
    if (!release) throw new Error("Application gate was not initialized.");
    release();
    expect(await result).toMatchObject(
      command === "doctor"
        ? { success: false, error: { code: "DEADLINE_EXCEEDED" } }
        : { code: "DEADLINE_EXCEEDED" },
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("maps local commands through the same authoritative route and application request", async () => {
  const result = await callLocal(
    parseArguments([
      "fixtures",
      "accept",
      "settings-screen",
      "--new",
      "--request-id",
      "logical",
      "--json",
    ]),
    {
      async call(invocation) {
        expect(invocation).toMatchObject({
          operation: "acceptFixture",
          projectId: "project_synthetic",
          requestId: "logical",
          id: "design_settings-screen",
          ifNoneMatch: "*",
          body: { fixtureId: "settings-screen", base: null, branch: "main" },
        });
        return {
          kind: "json",
          envelope: success("logical", {
            kind: "service",
            state: "stopped",
            projectId: "project_synthetic",
            warnings: [],
          }),
        };
      },
    },
  );
  expect(result.success).toBe(true);
});
it("refuses cold async before any application work", async () => {
  let called = false;
  await expect(
    callLocal(
      parseArguments([
        "render",
        "design_settings-screen",
        "--async",
        "--request-id",
        "r",
      ]),
      {
        async call() {
          called = true;
          throw new Error("Must not run.");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  expect(called).toBe(false);
});
