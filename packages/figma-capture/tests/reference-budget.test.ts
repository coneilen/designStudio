import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import {
  REFERENCE_LIMITS,
  REFERENCE_ORIGIN,
  ReferenceBudget,
  referenceUrl,
} from "../src/reference.js";

it("requires explicit current reference authority and enforces independent DNS/byte/deadline bounds", async () => {
  const context = syntheticContext({ budget: { ...REFERENCE_LIMITS } });
  context.authorization.grants.push(
    {
      resourceKind: "source",
      resourceId: "reference_one",
      operations: ["reference-download"],
    },
    {
      resourceKind: "artifact",
      resourceId: "artifact_root",
      operations: ["write"],
    },
  );
  expect(
    () =>
      new ReferenceBudget(
        context,
        "reference_one",
        "artifact_root",
        () => true,
        0,
      ),
  ).toThrow();
  context.authorization.egress = "explicit-grant-required";
  let active = true;
  const budget = new ReferenceBudget(
    context,
    "reference_one",
    "artifact_root",
    () => active,
    100,
  );
  try {
    budget.dnsQuery();
    expect(() => budget.dnsQuery()).toThrow();
    expect(() => budget.receive(REFERENCE_LIMITS.maxInputBytes - 99)).toThrow();
    expect(() => budget.decoded(REFERENCE_LIMITS.maxInputBytes - 99)).toThrow();
    expect(() => budget.output(REFERENCE_LIMITS.maxOutputBytes + 1)).toThrow();
    active = false;
    expect(() => budget.check()).toThrow();
  } finally {
    await budget.close();
  }
});
it("accepts only the fixed host and rejects malformed/duplicate expiry without exposing private queries", () => {
  expect(
    referenceUrl(
      `${REFERENCE_ORIGIN}/synthetic.png?X-Amz-Date=20260101T000000Z&X-Amz-Expires=60`,
    ),
  ).toMatchObject({ expiresAt: "2026-01-01T00:01:00.000Z" });
  for (const value of [
    "http://figma-alpha-api.s3.us-west-2.amazonaws.com/x",
    "https://127.0.0.1/x",
    "https://foreign.invalid/x",
    `${REFERENCE_ORIGIN}/x#fragment`,
    `https://user:secret@${new URL(REFERENCE_ORIGIN).hostname}/x`,
    `${REFERENCE_ORIGIN}/x?X-Amz-Date=bad&X-Amz-Expires=60`,
    `${REFERENCE_ORIGIN}/x?X-Amz-Date=20260230T000000Z&X-Amz-Expires=60`,
    `${REFERENCE_ORIGIN}/x?X-Amz-Date=20260101T000000Z&X-Amz-Expires=60&X-Amz-Expires=90`,
  ])
    expect(() => referenceUrl(value)).toThrow();
});
