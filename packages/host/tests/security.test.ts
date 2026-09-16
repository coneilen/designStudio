import {
  createFakeClock,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import { HostBoundaryError } from "../src/guards.js";
import {
  decideEgress,
  LocalSessionAuthenticator,
  Redactor,
  ScopedCredentialStore,
} from "../src/security.js";

it("separates CLI and browser trust with expiry, CSRF, Host and loopback guards", () => {
  let now = Date.now();
  const sessions = new LocalSessionAuthenticator({
    clock: { now: () => now, sleep: async () => {} },
    hosts: ["127.0.0.1:8080"],
    origins: ["http://127.0.0.1:8080"],
  });
  const auth = syntheticContext().authorization;
  const cli = sessions.createSession(auth, "cli");
  const browser = sessions.createSession(auth, "browser");
  expect(cli.credential.length).toBeGreaterThanOrEqual(43);
  expect(cli.credential).not.toEqual(browser.credential);
  const request = {
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:8080",
    method: "GET",
    bearer: cli.credential,
  };
  const verified = sessions.authenticate(request);
  expect(sessions.authority(verified)).toBe(true);
  expect(sessions.authority(structuredClone(verified))).toBe(false);
  for (const override of [
    { bearer: "bad" },
    { remoteAddress: "10.0.0.1" },
    { host: "evil.invalid" },
    { origin: "null" },
    { origin: "http://127.0.0.1:8080" },
    { fetchSite: "cross-site" },
    { bearer: browser.credential },
  ])
    expect(() => sessions.authenticate({ ...request, ...override })).toThrow();
  const browserRequest = {
    remoteAddress: "127.0.0.1",
    host: request.host,
    method: "POST",
    origin: "http://127.0.0.1:8080",
    cookie: browser.credential,
    csrf: browser.csrf,
    fetchSite: "same-origin",
  };
  expect(sessions.authority(sessions.authenticate(browserRequest))).toBe(true);
  expect(() =>
    sessions.authenticate({ ...browserRequest, csrf: "wrong" }),
  ).toThrow(/CSRF/);
  expect(() =>
    sessions.authenticate({ ...browserRequest, origin: "null" }),
  ).toThrow();
  sessions.revoke(verified);
  expect(sessions.authority(verified)).toBe(false);
  now += 60_001;
  expect(() => sessions.authenticate(browserRequest)).toThrow(
    /expired|credential/i,
  );
});

it("rejects wildcard/null origin configuration", () => {
  for (const origin of [
    "*",
    "null",
    "https://*.invalid",
    "https://host.invalid/path",
  ]) {
    expect(
      () =>
        new LocalSessionAuthenticator({
          clock: syntheticContext().clock,
          hosts: ["localhost:1234"],
          origins: [origin],
        }),
    ).toThrow();
  }
});

it("redacts credentials, authorization text and signed URL retrieval metadata", () => {
  const redactor = new Redactor();
  redactor.addSecret(new TextEncoder().encode("synthetic-super-secret"));
  const output = redactor.redact(
    "synthetic-super-secret Bearer abc.def https://user:pass@assets.invalid/a?X-Amz-Signature=xyz#s",
  );
  expect(output).not.toContain("synthetic-super-secret");
  expect(output).not.toContain("abc.def");
  expect(output).not.toContain("xyz");
  expect(output).not.toContain("user:pass");
});

it("credential use scopes lookup, clears borrowed bytes and fails closed without native bindings", async () => {
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "credential",
    resourceId: "secret_one",
    operations: ["credential-use"],
  });
  const reference = {
    id: "secret_one",
    providerId: "provider_one",
    store: "windows-credential-manager",
  } as const;
  let calls = 0;
  const source = new TextEncoder().encode("synthetic-secret-for-tests");
  const options = {
    projectId: context.projectId,
    authority: () => true,
    references: [reference],
    redactor: new Redactor(),
  };
  const store = new ScopedCredentialStore({
    ...options,
    backend: {
      store: "windows-credential-manager",
      capability: "verified-native",
      read: async () => {
        calls++;
        return source;
      },
    },
  });
  let borrowed: Uint8Array | undefined;
  expect(
    await store.use(reference, context, async (secret) => {
      borrowed = secret;
      return "safe";
    }),
  ).toMatchObject({ status: "complete", value: "safe" });
  expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  expect(source.every((byte) => byte === 0)).toBe(true);
  expect(
    await store.use(
      { ...reference, providerId: "other" },
      context,
      async () => "bad",
    ),
  ).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(calls).toBe(1);
  expect(
    await new ScopedCredentialStore(options).use(
      reference,
      context,
      async () => "bad",
    ),
  ).toMatchObject({
    status: "unavailable",
    error: { code: "PROVIDER_UNAVAILABLE" },
  });
});

it("never returns callback secrets or unredacted callback errors", async () => {
  const context = syntheticContext();
  context.authorization.grants.push({
    resourceKind: "credential",
    resourceId: "secret_one",
    operations: ["credential-use"],
  });
  const reference = {
    id: "secret_one",
    providerId: "provider_one",
    store: "configured-secure-store",
  } as const;
  const store = new ScopedCredentialStore({
    projectId: context.projectId,
    authority: () => true,
    references: [reference],
    redactor: new Redactor(),
    backend: {
      store: reference.store,
      capability: "verified-native",
      read: async () => new TextEncoder().encode("test-secret-not-real"),
    },
  });
  const output = await store.use(reference, context, async (secret) => ({
    nested: new TextDecoder().decode(secret),
  }));
  expect(output).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  const failure = await store.use(reference, context, async () => {
    throw new Error("test-secret-not-real");
  });
  expect(JSON.stringify(failure)).not.toContain("test-secret-not-real");
  for (const consumer of [
    async (secret: Uint8Array) => [...secret],
    async () => ({ "test-secret-not-real": "leaked key" }),
    async () => {
      throw new HostBoundaryError("INTERNAL_ERROR", "test-secret-not-real");
    },
  ]) {
    const result = await store.use<unknown>(reference, context, consumer);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("test-secret-not-real");
  }
  expect(
    await store.use(
      reference,
      { ...context, budget: { ...context.budget, maxOutputBytes: 2 } },
      async () => "oversized",
    ),
  ).toMatchObject({ error: { code: "OUTPUT_LIMIT" } });
});

it("denies egress by default, separates policy from evidence and enforces provider/data classes", () => {
  const context = syntheticContext();
  const request = {
    providerId: "provider_one",
    dataClasses: ["design"],
    evidenceIds: ["artifact_one"],
  };
  expect(
    decideEgress(context, request, {
      projectId: context.projectId,
      authority: () => true,
      rules: [],
    }).allowed,
  ).toBe(false);
  context.authorization.egress = "explicit-grant-required";
  context.authorization.grants.push({
    resourceKind: "provider",
    resourceId: "provider_one",
    operations: ["model-egress"],
  });
  context.budget.maxExternalCalls = 1;
  const policy = {
    projectId: context.projectId,
    authority: () => true,
    rules: [{ providerId: "provider_one", dataClasses: ["design"] }],
  };
  expect(decideEgress(context, request, policy)).toMatchObject({
    allowed: true,
    evidenceIds: ["artifact_one"],
    providerId: "provider_one",
  });
  expect(
    decideEgress(context, { ...request, dataClasses: ["ocr"] }, policy).allowed,
  ).toBe(false);
  expect(
    decideEgress(context, { ...request, providerId: "other" }, policy).allowed,
  ).toBe(false);
});
it("expires credential callback lifetime under the contract fake clock and wipes late backend results", async () => {
  const clock = createFakeClock(Date.now());
  const context = syntheticContext({
    clock,
    budget: { ...syntheticContext().budget, maxDurationMs: 5 },
  });
  context.authorization.grants.push({
    resourceKind: "credential",
    resourceId: "secret_one",
    operations: ["credential-use"],
  });
  const reference = {
    id: "secret_one",
    providerId: "provider_one",
    store: "configured-secure-store",
  } as const;
  let resolveRead: ((secret: Uint8Array) => void) | undefined;
  const store = new ScopedCredentialStore({
    projectId: context.projectId,
    authority: () => true,
    references: [reference],
    redactor: new Redactor(),
    backend: {
      store: reference.store,
      capability: "native-binding",
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    },
  });
  let called = false;
  const use = store.use(reference, context, async () => {
    called = true;
    return "safe";
  });
  clock.advance(5);
  expect(await use).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
  const late = Uint8Array.of(1, 2, 3);
  resolveRead?.(late);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(late).toEqual(Uint8Array.of(0, 0, 0));
  expect(called).toBe(false);
});
