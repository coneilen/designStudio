import { createJobService, JobService } from "@design-studio/jobs";
import { expect, test } from "vitest";

test("built jobs package exposes inert library construction", () => {
  expect(typeof createJobService).toBe("function");
  expect(typeof JobService).toBe("function");
});
