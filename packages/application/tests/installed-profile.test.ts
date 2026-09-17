import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { expect, it } from "vitest";
import {
  authorityPolicy,
  INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS,
} from "../src/installed-profile.js";

it("sets only the explicit installed profile and leaves the shared default and overall budget unchanged", () => {
  expect(authorityPolicy()).toEqual({});
  expect(authorityPolicy(INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS)).toEqual({
    authorityTimeoutMs: 15000,
  });
  expect(DEFAULT_BUDGETS.maxDurationMs).toBe(30000);
});
it("rejects any other runtime override rather than allowing request-controlled timeouts", () => {
  // @ts-expect-error Deliberately invalid trusted constructor value is rejected at runtime too.
  expect(() => authorityPolicy(60000)).toThrow();
});
