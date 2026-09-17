import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import { fixture, makeService, value } from "./support.js";

test("telemetry observer failure is exposed without losing durable completion", async () => {
  const f = await fixture();
  const s = makeService(
    f,
    async () => ({ kind: "wait", error: detail("ACTION_REQUIRED") }),
    {
      onEvent() {
        throw new Error("Bearer secret-fixture-value");
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  const first = await s.runOnce().catch((error: unknown) => error);
  const settled = await s.waitForAttempt("job-work", f.context());
  expect(first).toMatchObject({ status: "complete" });
  expect(settled).toMatchObject({
    status: "complete",
    value: { status: "waiting-for-user" },
  });
  expect(s.lastError).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(JSON.stringify(s.lastError)).not.toContain("secret-fixture-value");
});

test("handler failures never put arbitrary exception text into jobs or events", async () => {
  const f = await fixture();
  const events: unknown[] = [];
  const s = makeService(
    f,
    async () => {
      throw new Error(
        "private-design-name https://private.invalid/?token=secret",
      );
    },
    {
      onEvent(event) {
        events.push(event);
      },
    },
  );
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const result = value(await s.waitForAttempt("job-work", f.context()));
  expect(result.status).toBe("failed");
  const serialized = JSON.stringify([events, result, s.lastError]);
  expect(serialized).not.toContain("private-design-name");
  expect(serialized).not.toContain("token=secret");
});
