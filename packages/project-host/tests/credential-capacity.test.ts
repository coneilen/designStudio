import { syntheticContext } from "@design-studio/contracts/testing";
import { LocalSessionAuthenticator } from "@design-studio/host";
import { expect, it } from "vitest";
import {
  type CredentialAdminAction,
  CredentialAdministration,
  type CredentialAdminState,
} from "../../host/dist/credential-admin.js";
import {
  admitCredentialCapacity,
  credentialStateWrite,
} from "../src/credential-capacity.js";

it("preserves one terminal slot for status and pending removal while normal changes require eight", () => {
  for (const state of [
    "ready",
    "pending-remove",
    "uncertain",
    "absent",
  ] as const)
    expect(() => admitCredentialCapacity("status", 1023, state)).not.toThrow();
  expect(() =>
    admitCredentialCapacity("remove", 1023, "pending-remove"),
  ).not.toThrow();
  expect(() => admitCredentialCapacity("remove", 1023, "ready")).toThrow(
    /capacity/,
  );
  for (const action of ["setup", "update"] as const) {
    expect(() => admitCredentialCapacity(action, 1016, "ready")).not.toThrow();
    expect(() => admitCredentialCapacity(action, 1017, "ready")).toThrow(
      /capacity/,
    );
  }
  for (const action of ["setup", "update", "status", "remove"] as const)
    expect(() =>
      admitCredentialCapacity(action, 1024, "pending-remove"),
    ).toThrow(/capacity/);
});

it("denies setup/update before any effect at exact 1023-record capacity", () => {
  for (const action of ["setup", "update"] as const)
    expect(() => admitCredentialCapacity(action, 1023, "ready", 1024)).toThrow(
      /capacity/,
    );
});
it("deduplicates status and protects a durable removal terminal slot across restarts", () => {
  const reference = {
    id: "ref",
    providerId: "figma_rest",
    store: "windows-credential-manager",
  } as const;
  const state = { reference, state: "ready" as const };
  for (let index = 0; index < 1021; index++) {
    admitCredentialCapacity("status", 2, state.state, 10);
    expect(credentialStateWrite(state, state, 2, 10)).toBe("retain");
  }
  admitCredentialCapacity("update", 2, "ready", 10);
  const pendingUpdate = { reference, state: "pending-update" as const };
  const uncertain = { reference, state: "uncertain" as const };
  expect(credentialStateWrite(state, pendingUpdate, 2, 10)).toBe("append");
  expect(credentialStateWrite(pendingUpdate, uncertain, 3, 10)).toBe("append");
  admitCredentialCapacity("status", 4, "uncertain", 10);
  expect(credentialStateWrite(uncertain, state, 4, 10)).toBe("append");
  admitCredentialCapacity("remove", 5, "ready", 10);
  const pendingRemove = { reference, state: "pending-remove" as const };
  expect(credentialStateWrite(state, pendingRemove, 5, 10)).toBe("append");
  for (let attempt = 0; attempt < 20; attempt++) {
    expect(credentialStateWrite(pendingRemove, uncertain, 6, 10)).toBe(
      "retain",
    );
    admitCredentialCapacity("status", 6, "pending-remove", 10);
    expect(credentialStateWrite(pendingRemove, state, 6, 10)).toBe("retain");
    admitCredentialCapacity("remove", 6, "pending-remove", 10);
    expect(credentialStateWrite(pendingRemove, pendingRemove, 6, 10)).toBe(
      "retain",
    );
  }
  expect(
    credentialStateWrite(pendingRemove, { reference, state: "absent" }, 9, 10),
  ).toBe("append");
  expect(
    credentialStateWrite({ reference, state: "absent" }, uncertain, 10, 10),
  ).toBe("retain");
  expect(() =>
    admitCredentialCapacity("remove", 10, "pending-remove", 10),
  ).toThrow();
});

for (const action of ["setup", "update"] as const)
  for (const fault of [
    "before-effect",
    "after-effect",
    "after-terminal-record",
    "crash-before-effect",
    "crash-after-effect",
  ] as const)
    for (const finalization of [
      "known-absence",
      "uncertain-absence",
      "terminal-ack-failure",
    ] as const)
      it(`recovers ${action} at exactly eight free slots, ${fault}, ${finalization}`, async () => {
        const reference = {
          id: "figma_pat_00000000-0000-4000-8000-000000000001",
          providerId: "figma_rest",
          store: "windows-credential-manager",
        } as const;
        let present = action === "update";
        const history: CredentialAdminState[] = [
          { reference, state: present ? "ready" : "absent" },
          { reference, state: present ? "ready" : "absent" },
        ];
        let removal: "ambiguous-present" | "success" | "ambiguous-absent" =
          "ambiguous-present";
        let failedRead = false;
        let terminalFaultUsed = false;
        const context = syntheticContext();
        const sessions = new LocalSessionAuthenticator({
          clock: context.clock,
          hosts: ["127.0.0.1:1234"],
          origins: [],
        });
        const backend = {
          read: async () => {
            if (failedRead) throw new Error("synthetic unavailable read");
            return present ? Buffer.from("synthetic-capacity") : undefined;
          },
          write: async () => {
            if (fault !== "before-effect" && fault !== "crash-before-effect")
              present = true;
            if (fault !== "after-terminal-record")
              throw new Error("synthetic ambiguous write");
          },
          remove: async () => {
            if (removal === "ambiguous-present")
              throw new Error("synthetic ambiguous removal");
            present = false;
            if (removal === "ambiguous-absent")
              throw new Error("synthetic ambiguous removal");
            return true;
          },
        };
        const run = async (requested: CredentialAdminAction) => {
          const previous = history[history.length - 1];
          admitCredentialCapacity(
            requested,
            history.length,
            previous?.state,
            10,
          );
          const token = sessions.createSession(context.authorization, "cli");
          const authorization = sessions.authenticate({
            remoteAddress: "127.0.0.1",
            host: "127.0.0.1:1234",
            method: "POST",
            bearer: token.credential,
          });
          // New process/authority/capability for every simulated restart or explicit retry.
          const admin = new CredentialAdministration({
            projectId: context.projectId,
            actorId: authorization.actorId,
            reference,
            authority: sessions.authority,
            currentActor: async () => authorization.actorId,
            backend,
            journal: {
              read: async () => structuredClone(history[history.length - 1]),
              record: async (state) => {
                if (
                  requested === action &&
                  state.state === "uncertain" &&
                  fault.startsWith("crash-")
                )
                  throw new Error(
                    "Synthetic crash-equivalent journal interruption leaves only durable pending",
                  );
                const last = history[history.length - 1];
                if (
                  credentialStateWrite(last, state, history.length, 10) ===
                  "append"
                ) {
                  history.push(structuredClone(state));
                  if (
                    requested === action &&
                    state.state === "ready" &&
                    fault === "after-terminal-record" &&
                    !terminalFaultUsed
                  ) {
                    terminalFaultUsed = true;
                    throw new Error(
                      "synthetic failure after committed terminal record",
                    );
                  }
                  if (
                    requested === "remove" &&
                    state.state === "absent" &&
                    finalization === "terminal-ack-failure"
                  )
                    throw new Error(
                      "Synthetic late acknowledgement failure after confirmed absence",
                    );
                }
              },
            },
          });
          try {
            const proof = await admin.admit(
              {
                action: requested,
                reference,
                confirmation: { action: requested, referenceId: reference.id },
              },
              { ...context, authorization },
            );
            return await admin.execute(
              proof,
              requested === "setup" || requested === "update"
                ? Buffer.from("synthetic-capacity")
                : undefined,
            );
          } finally {
            sessions.revoke(authorization);
          }
        };
        expect(await run(action)).toMatchObject({ status: "interrupted" });
        const mutationRecords =
          fault === "after-terminal-record"
            ? 5
            : fault.startsWith("crash-")
              ? 3
              : 4;
        expect(history).toHaveLength(mutationRecords);
        failedRead = true;
        expect(await run("status")).toMatchObject({ status: "unavailable" });
        expect(history).toHaveLength(mutationRecords);
        failedRead = false;
        expect(await run("status")).toMatchObject({
          value: { presence: present ? "present" : "absent" },
        });
        expect(history).toHaveLength(mutationRecords + 1);
        if (!present) {
          for (let repeat = 0; repeat < 20; repeat++) await run("status");
          expect(history).toHaveLength(mutationRecords + 1);
          return;
        }
        for (let repeat = 0; repeat < 20; repeat++) {
          expect(await run("remove")).toMatchObject({ status: "interrupted" });
          expect(history[history.length - 1]?.state).toBe("pending-remove");
          expect(await run("status")).toMatchObject({
            value: { presence: "present" },
          });
          expect(history).toHaveLength(mutationRecords + 2);
        }
        removal =
          finalization === "uncertain-absence" ? "ambiguous-absent" : "success";
        if (finalization === "known-absence")
          expect(await run("remove")).toMatchObject({
            status: "complete",
            value: { presence: "absent" },
          });
        else {
          expect(await run("remove")).toMatchObject({ status: "interrupted" });
          expect(history).toHaveLength(
            mutationRecords + (finalization === "terminal-ack-failure" ? 3 : 2),
          );
          expect(await run("status")).toMatchObject({
            value: { presence: "absent" },
          });
        }
        expect(history).toHaveLength(mutationRecords + 3);
        for (let repeat = 0; repeat < 20; repeat++) await run("status");
        expect(history).toHaveLength(mutationRecords + 3);
      });
