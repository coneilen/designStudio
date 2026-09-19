import type { Clock } from "@design-studio/contracts";
import {
  createFakeClock,
  syntheticContext,
} from "@design-studio/contracts/testing";
import { expect, it } from "vitest";
import {
  CredentialAdministration,
  type CredentialAdminJournal,
  type CredentialAdminState,
  type OwnedCredentialAdapter,
} from "../src/credential-admin.js";
import { OwnedFigmaCredentialAdapter } from "../src/credential-admin-vault.js";
import { LocalSessionAuthenticator } from "../src/security.js";
import { deferred } from "./deferred.js";

const reference = {
  id: "figma_pat_00000000-0000-4000-8000-000000000001",
  providerId: "figma_rest",
  store: "windows-credential-manager",
} as const;
function fixture(clock?: Clock, nativeNull = false) {
  const raw = syntheticContext(clock ? { clock } : {});
  const sessions = new LocalSessionAuthenticator({
    clock: raw.clock,
    hosts: ["127.0.0.1:1234"],
    origins: [],
  });
  const credentials = sessions.createSession(raw.authorization, "cli");
  const authorization = sessions.authenticate({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:1234",
    method: "GET",
    bearer: credentials.credential,
  });
  const context = { ...raw, authorization };
  let actor = authorization.actorId;
  let stored: Uint8Array | undefined;
  const calls: string[] = [];
  const states: string[] = [];
  let journalState: CredentialAdminState | undefined;
  const journal: CredentialAdminJournal = {
    read: async () =>
      journalState ? structuredClone(journalState) : undefined,
    record: async (state) => {
      states.push(state.state);
      journalState = structuredClone(state);
    },
  };
  const backend: OwnedCredentialAdapter = {
    read: async () => {
      calls.push("read");
      return stored ? Uint8Array.from(stored) : undefined;
    },
    write: async (bytes: Uint8Array) => {
      calls.push("write");
      stored = Uint8Array.from(bytes);
    },
    remove: async () => {
      calls.push("remove");
      const present = stored !== undefined;
      stored?.fill(0);
      stored = undefined;
      return present;
    },
  };
  if (nativeNull) {
    const read = backend.read.bind(backend);
    const write = backend.write.bind(backend);
    const remove = backend.remove.bind(backend);
    const adapter = new OwnedFigmaCredentialAdapter(
      {
        projectId: raw.projectId,
        actorId: authorization.actorId,
        reference,
      },
      async () => ({
        AsyncEntry: class {
          async getSecret() {
            return (await read()) ?? null;
          }
          setSecret(bytes: Uint8Array) {
            return write(bytes);
          }
          deleteCredential() {
            return remove();
          }
        },
      }),
    );
    backend.read = adapter.read.bind(adapter);
    backend.write = adapter.write.bind(adapter);
    backend.remove = adapter.remove.bind(adapter);
  }
  const admin = new CredentialAdministration({
    projectId: raw.projectId,
    actorId: authorization.actorId,
    reference,
    authority: sessions.authority,
    currentActor: async () => actor,
    backend,
    journal,
  });
  return {
    admin,
    backend,
    journal,
    context,
    calls,
    states,
    sessions,
    actor(value: string) {
      actor = value;
    },
  };
}
const admit = (
  f: ReturnType<typeof fixture>,
  action: "setup" | "status" | "update" | "remove",
) =>
  f.admin.admit(
    {
      action,
      reference,
      confirmation: { action, referenceId: reference.id },
    },
    f.context,
  );

it.skipIf(process.platform !== "win32")(
  "native null supports absent status/setup/removal without permitting a present-value overwrite",
  async () => {
    const f = fixture(undefined, true);
    expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
      status: "complete",
      value: { presence: "absent" },
    });
    expect(
      await f.admin.execute(
        await admit(f, "setup"),
        Buffer.from("synthetic-native-only"),
      ),
    ).toMatchObject({ status: "complete", value: { presence: "present" } });
    expect(
      await f.admin.execute(
        await admit(f, "setup"),
        Buffer.from("must-not-overwrite"),
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(f.calls.filter((call) => call === "write")).toHaveLength(1);
    expect(await f.admin.execute(await admit(f, "remove"))).toMatchObject({
      status: "complete",
      value: { presence: "absent" },
    });
    expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
      status: "complete",
      value: { presence: "absent" },
    });
    await f.backend.write(new Uint8Array());
    const writes = f.calls.filter((call) => call === "write").length;
    expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
      value: { presence: "present" },
    });
    expect(
      await f.admin.execute(
        await admit(f, "setup"),
        Buffer.from("must-not-overwrite-empty"),
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(f.calls.filter((call) => call === "write")).toHaveLength(writes);
  },
);

it("enrolls only a fresh entry, reports exact-entry status, confirms replacement/removal and never returns bytes", async () => {
  const f = fixture();
  const token = Buffer.from("synthetic-only-pat");
  expect(await f.admin.execute(await admit(f, "setup"), token)).toMatchObject({
    status: "complete",
    value: { presence: "present" },
  });
  expect(token.every((byte) => byte === 0)).toBe(true);
  expect(f.calls).toEqual(["read", "write", "read"]);
  expect(f.states).toEqual(["pending-setup", "ready"]);
  const collision = await f.admin.execute(
    await admit(f, "setup"),
    Buffer.from("another-synthetic"),
  );
  expect(collision).toMatchObject({ error: { code: "CONFLICT" } });
  expect(f.calls.filter((call) => call === "write")).toHaveLength(1);
  const status = await f.admin.execute(await admit(f, "status"));
  expect(status).toMatchObject({
    status: "complete",
    value: { reference, presence: "present", expiryEvidence: "unknown" },
  });
  expect(JSON.stringify(status)).not.toContain("synthetic-only-pat");
  expect(
    await f.admin.execute(
      await admit(f, "update"),
      Buffer.from("replacement-synthetic"),
    ),
  ).toMatchObject({ status: "complete" });
  expect(await f.admin.execute(await admit(f, "remove"))).toMatchObject({
    status: "complete",
    value: { presence: "absent" },
  });
});

it("denies forged, replayed, unconfirmed or wrong-reference/action capabilities without native access", async () => {
  const f = fixture();
  for (const request of [
    { action: "status", reference },
    {
      action: "remove",
      reference,
      confirmation: { action: "update", referenceId: reference.id },
    },
    {
      action: "status",
      reference: { ...reference, providerId: "other" },
      confirmation: { action: "status", referenceId: reference.id },
    },
    {
      action: "enumerate",
      reference,
      confirmation: { action: "enumerate", referenceId: reference.id },
    },
  ])
    await expect(f.admin.admit(request, f.context)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  const cap = await admit(f, "status");
  await expect(f.admin.execute({ ...cap })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await f.admin.execute(cap)).toMatchObject({ status: "complete" });
  await expect(f.admin.execute(cap)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(f.calls).toEqual(["read"]);
});

it("rechecks live principal and authority after issuance and never extends expired proof", async () => {
  for (const mode of ["principal", "revoke", "cancel"] as const) {
    const f = fixture();
    const controller = new AbortController();
    f.context.signal = controller.signal;
    const cap = await admit(f, "setup");
    if (mode === "principal") f.actor("other_actor");
    if (mode === "revoke") f.sessions.revoke(f.context.authorization);
    if (mode === "cancel") controller.abort();
    const bytes = Buffer.from("synthetic-only-secret");
    expect((await f.admin.execute(cap, bytes)).status).not.toBe("complete");
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(f.calls).toEqual([]);
  }
});

it("journals intent before mutation; late cancelled writes retain ownership then report uncertainty", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.context.signal = controller.signal;
  const entered = deferred<void>();
  const write = deferred<void>();
  let borrowed: Uint8Array | undefined;
  f.backend.write = async (bytes) => {
    borrowed = bytes;
    entered.resolve();
    await write.promise;
  };
  const result = f.admin.execute(
    await admit(f, "setup"),
    Buffer.from("synthetic-late-write"),
  );
  await entered.promise;
  controller.abort();
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(f.admin.pending).toBe(true);
  expect(Buffer.from(borrowed ?? []).toString()).toBe("synthetic-late-write");
  expect(f.states).toEqual(["pending-setup"]);
  write.resolve();
  expect(await result).toMatchObject({
    status: "interrupted",
    error: { code: "OUTPUT_UNCERTAIN" },
  });
  expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  expect(f.admin.pending).toBe(false);
  expect(f.states).toEqual(["pending-setup", "uncertain"]);
  f.context.signal = new AbortController().signal;
  expect(
    await f.admin.execute(
      await admit(f, "setup"),
      Buffer.from("synthetic-again"),
    ),
  ).toMatchObject({ error: { code: "ACTION_REQUIRED" } });
  expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
    status: "complete",
    value: { presence: "absent" },
  });
});

it("preserves user-declared claims through status without treating them as verified expiry/scopes", async () => {
  const f = fixture();
  const cap = await f.admin.admit(
    {
      action: "setup",
      reference,
      confirmation: { action: "setup", referenceId: reference.id },
      claims: {
        declaredExpiresAt: "2099-01-01T00:00:00.000Z",
        declaredScopes: ["file_content:read"],
      },
    },
    f.context,
  );
  await f.admin.execute(cap, Buffer.from("synthetic-claims"));
  expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
    value: {
      expiryEvidence: "user-declared",
      declaredExpiresAt: "2099-01-01T00:00:00.000Z",
      declaredScopes: ["file_content:read"],
    },
  });
});

it("snapshots action/reference/context before asynchronous principal admission", async () => {
  const f = fixture();
  const input = {
    action: "status",
    reference: { ...reference, id: String(reference.id) },
    confirmation: { action: "status", referenceId: reference.id },
  };
  const pending = f.admin.admit(input, f.context);
  input.action = "remove";
  input.reference.id = "figma_pat_00000000-0000-4000-8000-000000000002";
  input.confirmation.action = "remove";
  f.context.projectId = "other_project";
  const cap = await pending;
  expect(cap.action).toBe("status");
  expect((await f.admin.execute(cap)).status).toBe("complete");
  expect(f.calls).toEqual(["read"]);
});

it("refuses wrong projects, invalid input and in-flight overlap", async () => {
  const f = fixture();
  await expect(
    f.admin.admit(
      {
        action: "status",
        reference,
        confirmation: { action: "status", referenceId: reference.id },
      },
      { ...f.context, projectId: "other_project" },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const cap = await admit(f, "setup");
  await expect(
    f.admin.execute(cap, Buffer.from("bad\nsecret")),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(f.calls).toEqual([]);
  const entered = deferred<void>();
  const gate = deferred<Uint8Array | undefined>();
  f.backend.read = async () => {
    entered.resolve();
    return gate.promise;
  };
  const first = f.admin.execute(await admit(f, "status"));
  await entered.promise;
  const second = await f.admin.execute(await admit(f, "status"));
  expect(second).toMatchObject({ error: { code: "CONFLICT" } });
  gate.resolve(undefined);
  await first;
});

it("does not renew proof or return success after the original admin deadline", async () => {
  const clock = createFakeClock(Date.now());
  const f = fixture(clock);
  const cap = await admit(f, "setup");
  clock.advance(30_000);
  expect(
    await f.admin.execute(cap, Buffer.from("synthetic-expired")),
  ).toMatchObject({
    error: { code: "DEADLINE_EXCEEDED" },
  });
  expect(f.calls).toEqual([]);
});

it("does not mutate before durable intent and distinguishes unavailable status from absence", async () => {
  const f = fixture();
  f.journal.record = async () => {
    throw new Error("sensitive-journal-failure");
  };
  const result = await f.admin.execute(
    await admit(f, "setup"),
    Buffer.from("synthetic-journal"),
  );
  expect(result).toMatchObject({ status: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(f.calls).toEqual(["read"]);
  f.backend.read = async () => {
    throw new Error("sensitive-native-failure");
  };
  expect(await f.admin.execute(await admit(f, "status"))).toMatchObject({
    status: "unavailable",
    error: { code: "PROVIDER_UNAVAILABLE" },
  });
});

it("clears status bytes before awaiting principal revalidation and owns late-read failures", async () => {
  const clock = createFakeClock(Date.now());
  const f = fixture(clock);
  const entered = deferred<void>();
  const read = deferred<Uint8Array | undefined>();
  f.backend.read = async () => {
    entered.resolve();
    return read.promise;
  };
  const cap = await admit(f, "status");
  const result = f.admin.execute(cap);
  await entered.promise;
  clock.advance(30_000);
  expect(f.admin.pending).toBe(true);
  const bytes = Buffer.from("synthetic-status-read");
  read.resolve(bytes);
  expect(await result).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(f.admin.pending).toBe(false);
});

it("reports journal reconciliation failure after native mutation without falsely undoing it", async () => {
  const f = fixture();
  const record = f.journal.record;
  f.journal.record = async (state) => {
    if (state.state !== "pending-setup")
      throw new Error("private-durable-failure");
    await record(state);
  };
  const result = await f.admin.execute(
    await admit(f, "setup"),
    Buffer.from("synthetic-mutation"),
  );
  expect(result).toMatchObject({
    status: "interrupted",
    error: { code: "OUTPUT_UNCERTAIN" },
  });
  expect(f.states).toEqual(["pending-setup"]);
  expect(f.calls).toEqual(["read", "write", "read"]);
  expect(JSON.stringify(result)).not.toContain("private-durable-failure");
});

it("withholds native causes and leaves pending state when journaling or verification fails", async () => {
  const f = fixture();
  f.backend.write = async () => {
    throw new Error("secret-native-detail");
  };
  const result = await f.admin.execute(
    await admit(f, "setup"),
    Buffer.from("synthetic-input"),
  );
  expect(result).toMatchObject({
    status: "interrupted",
    error: { code: "OUTPUT_UNCERTAIN" },
  });
  expect(JSON.stringify(result)).not.toContain("secret-native-detail");
  expect(f.states).toEqual(["pending-setup", "uncertain"]);
});
