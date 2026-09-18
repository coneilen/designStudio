import { expect, it } from "vitest";
import { logicalIdentity } from "../src/designs.js";

it("derives durable identities from actor and operation, not transport attempts or payload", () => {
  const first = logicalIdentity("owner", "write", "logical_request");
  expect(logicalIdentity("owner", "write", "logical_request")).toEqual(first);
  expect(logicalIdentity("owner", "render", "logical_request")).not.toEqual(
    first,
  );
  expect(logicalIdentity("another", "write", "logical_request")).not.toEqual(
    first,
  );
  expect(first.jobId).toMatch(/^job_[a-f0-9]{64}$/);
});
