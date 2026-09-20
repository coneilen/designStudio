import { expect, it } from "vitest";
import { OwnedFigmaCredentialAdapter } from "../src/credential-admin-vault.js";

it.skipIf(process.platform !== "win32")(
  "uses fixed derived owned targets and only asynchronous byte methods without abort wrappers",
  async () => {
    const targets: string[] = [];
    const calls: string[] = [];
    let stored: Uint8Array | undefined;
    const adapter = new OwnedFigmaCredentialAdapter(
      {
        projectId: "project_one",
        actorId: "actor_one",
        reference: {
          id: "figma_pat_00000000-0000-4000-8000-000000000001",
          providerId: "figma_rest",
          store: "windows-credential-manager",
        },
      },
      async () => ({
        AsyncEntry: class {
          constructor(service: string, account: string) {
            expect(service).toMatch(
              /^DesignStudio\.FigmaPAT\.v1\.[a-f0-9]{64}$/,
            );
            expect(account).toMatch(/^principal-[a-f0-9]{64}$/);
            targets.push(`${service}:${account}`);
          }
          async getSecret(...args: unknown[]) {
            expect(args).toEqual([]);
            calls.push("read");
            return stored;
          }
          async setSecret(bytes: Uint8Array, ...args: unknown[]) {
            expect(args).toEqual([]);
            calls.push("write");
            stored = Uint8Array.from(bytes);
          }
          async deleteCredential(...args: unknown[]) {
            expect(args).toEqual([]);
            calls.push("remove");
            stored = undefined;
            return true;
          }
        },
      }),
    );
    await adapter.write(Uint8Array.of(65, 66));
    expect(await adapter.read()).toEqual(Uint8Array.of(65, 66));
    expect(await adapter.remove()).toBe(true);
    expect(new Set(targets).size).toBe(1);
    expect(calls).toEqual(["write", "read", "remove"]);
  },
);
