import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { expect, it } from "vitest";
import { createApplication } from "../src/application.js";
import { draftWarning, success } from "../src/response.js";
import type { ApplicationResult } from "../src/types.js";

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
it("detaches nested service JSON and binary state even when a service reuses its response object", async () => {
  const context = syntheticContext();
  const value: ApplicationResult = {
    kind: "json",
    envelope: success(context.requestId, {
      kind: "artifact",
      artifact: {
        id: "artifact_owned",
        sha256: "a".repeat(64),
        byteLength: 1,
        mediaType: "application/octet-stream",
        path: `blobs/${"a".repeat(64)}`,
      },
      warnings: [draftWarning()],
    }),
  };
  const application = createApplication({
    authorize: async () => context,
    execute: async () => value,
  });
  const request = {
    operation: "getArtifact" as const,
    projectId: context.projectId,
    requestId: context.requestId,
    id: "artifact_owned",
    parameters: { sha256: "a".repeat(64) },
  };
  const first = await application.invoke(
    request,
    context.authorization,
    context.signal,
  );
  expect(first).not.toBe(value);
  if (
    first.kind !== "json" ||
    !first.envelope.success ||
    first.envelope.data.kind !== "artifact" ||
    !first.envelope.data.artifact
  )
    throw new Error("Expected artifact response.");
  first.envelope.data.artifact.sha256 = "b".repeat(64);
  first.envelope.data.warnings.length = 0;
  const next = await application.invoke(
    request,
    context.authorization,
    context.signal,
  );
  expect(next).toEqual(value);
  const binary: ApplicationResult = {
    kind: "binary",
    mediaType: "application/octet-stream",
    bytes: Uint8Array.of(1),
  };
  const download = createApplication({
    authorize: async () => context,
    execute: async () => binary,
  });
  const result = await download.invoke(
    { ...request, operation: "readArtifact" },
    context.authorization,
    context.signal,
  );
  if (result.kind !== "binary") throw new Error("Expected bytes.");
  result.bytes[0] = 9;
  expect(binary.bytes[0]).toBe(1);
});
