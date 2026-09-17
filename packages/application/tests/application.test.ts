import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { expect, it } from "vitest";
import { createApplication } from "../src/application.js";

it("denies an invocation before selecting a business service", async () => {
  const clock = new SystemClock();
  const sessions = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47119"],
    origins: [],
  });
  const credentials = sessions.createSession(
    {
      schemaVersion: "1.0",
      projectId: "project_synthetic",
      actorId: "owner",
      sessionId: "session",
      expiresAt: new Date(clock.now() + 30000).toISOString(),
      egress: "deny",
      grants: [],
    },
    "cli",
  );
  const authorization = sessions.authenticate({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:47119",
    method: "GET",
    bearer: credentials.credential,
  });
  let selected = false;
  const application = createApplication({
    async authorize() {
      throw new Error("denied");
    },
    async execute() {
      selected = true;
      throw new Error("must not run");
    },
  });
  await expect(
    application.invoke(
      {
        operation: "doctor",
        projectId: "project_synthetic",
        requestId: "request",
        parameters: {},
      },
      authorization,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(selected).toBe(false);
  expect(DEFAULT_BUDGETS.maxExternalCalls).toBe(0);
});
