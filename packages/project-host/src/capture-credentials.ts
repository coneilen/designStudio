import { randomUUID } from "node:crypto";
import {
  DEFAULT_BUDGETS,
  type OperationContext,
} from "@design-studio/contracts";
import {
  HostBoundaryError,
  LocalSessionAuthenticator,
  SystemClock,
} from "@design-studio/host";
import {
  type CredentialAdminAction,
  CredentialAdministration,
  type CredentialClaims,
} from "../../host/dist/credential-admin.js";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import { type CaptureProject, captureProjectOwner } from "./capture-project.js";
import { loadNative, refuse } from "./native.js";

/** Native-only composition. Neither paths, JSON grants nor fixture bindings are accepted. */
export async function openCaptureCredentials(project: CaptureProject) {
  const owned = captureProjectOwner(project);
  if (owned.users)
    refuse(
      "This capture project's credential reference already has an active owner.",
    );
  owned.users++;
  try {
    await project.recheck();
    const native = await loadNative();
    const clock = new SystemClock();
    const sessions = new LocalSessionAuthenticator({
      clock,
      hosts: ["127.0.0.1:47120"],
      origins: [],
    });
    let closed = false;
    let working = false;
    const currentActor = async () => {
      captureProjectOwner(project);
      await project.recheck();
      if (closed || native.principal() !== owned.sid)
        refuse("Native credential principal changed.");
      return owned.registry.currentPrincipal().actorId;
    };
    const admin = new CredentialAdministration({
      projectId: project.projectId,
      actorId: project.principal.actorId,
      reference: project.reference,
      authority: sessions.authority,
      currentActor,
      backend: new OwnedFigmaCredentialAdapter({
        projectId: project.projectId,
        actorId: project.principal.actorId,
        reference: project.reference,
      }),
      journal: owned.journal,
    });
    return Object.freeze({
      reference: project.reference,
      async execute(
        action: CredentialAdminAction,
        confirmedReference: string,
        signal: AbortSignal,
        input?: Uint8Array,
        claims?: CredentialClaims,
      ) {
        let secret: Uint8Array | undefined;
        try {
          if (input !== undefined) {
            if (
              !(input instanceof Uint8Array) ||
              input.buffer instanceof SharedArrayBuffer ||
              input.byteLength < 1 ||
              input.byteLength > 4096 ||
              input.some((byte) => byte < 33 || byte > 126)
            )
              throw new HostBoundaryError(
                "INVALID_INPUT",
                "Invalid owned credential input.",
              );
            secret = Uint8Array.from(input);
          }
        } finally {
          if (
            input instanceof Uint8Array &&
            !(input.buffer instanceof SharedArrayBuffer)
          )
            input.fill(0);
        }
        let context: OperationContext | undefined;
        let revoke: (() => void) | undefined;
        let admitted = false;
        try {
          if (
            closed ||
            working ||
            confirmedReference !== project.reference.id ||
            !["setup", "status", "update", "remove"].includes(action)
          )
            refuse(
              "Credential action needs a live native owner and exact reference confirmation.",
            );
          const requestedClaims =
            claims === undefined ? undefined : structuredClone(claims);
          working = true;
          admitted = true;
          await currentActor();
          if (signal.aborted)
            throw new HostBoundaryError(
              "CANCELLED",
              "Credential action cancelled.",
            );
          const deadline = new Date(clock.now() + 30_000).toISOString();
          const token = sessions.createSession(
            {
              schemaVersion: "1.0",
              projectId: project.projectId,
              actorId: project.principal.actorId,
              sessionId: randomUUID(),
              expiresAt: deadline,
              grants: [],
              egress: "deny",
            },
            "cli",
          );
          const authorization = sessions.authenticate({
            remoteAddress: "127.0.0.1",
            host: "127.0.0.1:47120",
            method: "POST",
            bearer: token.credential,
          });
          context = {
            schemaVersion: "1.0",
            projectId: project.projectId,
            requestId: randomUUID(),
            authorization,
            budget: { ...DEFAULT_BUDGETS, maxAttempts: 1 },
            deadline,
            clock,
            signal,
          };
          revoke = () => sessions.revoke(authorization);
          signal.addEventListener("abort", revoke, { once: true });
          const capability = await admin.admit(
            {
              action,
              reference: project.reference,
              confirmation: { action, referenceId: confirmedReference },
              ...(requestedClaims ? { claims: requestedClaims } : {}),
            },
            context,
          );
          await owned.journal.begin(action);
          return await admin.execute(capability, secret);
        } finally {
          secret?.fill(0);
          if (revoke) {
            signal.removeEventListener("abort", revoke);
            revoke();
          }
          if (admitted) working = false;
        }
      },
      close() {
        if (closed) return;
        if (working || admin.pending)
          refuse("Credential work has not quiesced.");
        closed = true;
        owned.users--;
      },
    });
  } catch (error) {
    owned.users--;
    throw error;
  }
}
