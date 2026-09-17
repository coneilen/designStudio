import { expect, it } from "vitest";
import { stopApplication } from "../src/lifecycle.js";

it("retains store and host when jobs report pending callbacks despite active zero", async () => {
  const calls: string[] = [];
  const stopped = await stopApplication({
    stopAdmissions: () => {
      calls.push("admissions");
    },
    stopJobs: async () => ({
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      requestId: "stop",
      status: "interrupted",
      error: {
        code: "INTERRUPTED",
        message: "pending authority",
        retryable: false,
        diagnosticIds: [],
      },
      diagnosticIds: [],
    }),
    drainRequests: async () => {
      calls.push("drain");
    },
    closeStore: () => {
      calls.push("store");
    },
    closeHost: async () => {
      calls.push("host");
    },
    closeBinding: async () => {
      calls.push("binding");
    },
  });
  expect(stopped).toBe(false);
  expect(calls).toEqual(["admissions"]);
});
it("closes in ownership order only after real quiescence", async () => {
  const calls: string[] = [];
  expect(
    await stopApplication({
      stopAdmissions: () => {
        calls.push("admissions");
      },
      stopJobs: async () => ({
        schemaVersion: "1.0",
        projectId: "project_synthetic",
        requestId: "stop",
        status: "complete",
        value: { active: 0 },
        diagnosticIds: [],
      }),
      drainRequests: async () => {
        calls.push("drain");
      },
      closeStore: () => {
        calls.push("store");
      },
      closeHost: async () => {
        calls.push("host");
      },
      closeBinding: async () => {
        calls.push("binding");
      },
    }),
  ).toBe(true);
  expect(calls).toEqual(["admissions", "drain", "store", "host", "binding"]);
});
