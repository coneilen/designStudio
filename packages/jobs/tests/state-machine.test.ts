import type { JobStatus } from "@design-studio/contracts";
import { describe, expect, test } from "vitest";
import { assertTransition, retryDeadline } from "../src/state-machine.js";

const edges: Record<JobStatus, JobStatus[]> = {
  queued: ["running", "cancelled", "failed", "waiting-for-user", "interrupted"],
  running: [
    "completed",
    "waiting-for-user",
    "retry-wait",
    "failed",
    "cancel-requested",
    "interrupted",
  ],
  "waiting-for-user": ["queued", "cancelled", "failed", "interrupted"],
  "retry-wait": ["running", "cancelled", "interrupted"],
  "cancel-requested": ["cancelled", "completed", "interrupted"],
  interrupted: [
    "queued",
    "cancelled",
    "failed",
    "waiting-for-user",
    "completed",
  ],
  completed: [],
  failed: [],
  cancelled: [],
};
describe("explicit durable transition graph", () => {
  for (const from of Object.keys(edges) as JobStatus[]) {
    for (const to of Object.keys(edges) as JobStatus[]) {
      test(`${from} -> ${to}`, () => {
        if (edges[from].includes(to))
          expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow();
      });
    }
  }
});
test("retry time respects upstream deadline and finite job lifetime", () => {
  expect(retryDeadline(1000, 2, 100, 5000, 10000)).toBe(5000);
  expect(retryDeadline(1000, 2, 100, undefined, 10000)).toBe(1200);
  expect(() => retryDeadline(1000, 2, 100, 10000, 10000)).toThrow();
  expect(() => retryDeadline(1000, 101, 100, undefined, 10000)).toThrow();
});
