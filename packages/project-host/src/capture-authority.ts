import { randomUUID } from "node:crypto";
import {
  type AuthorizationContext,
  type CredentialReference,
  DEFAULT_BUDGETS,
  type ErrorCode,
  type OperationContext,
} from "@design-studio/contracts";
import {
  HostBoundaryError,
  LocalSessionAuthenticator,
  SystemClock,
  snapshotOperationContext,
} from "@design-studio/host";
import { assertCaptureWork, type CaptureWork } from "./capture-work.js";

interface CapturePolicy {
  projectId: string;
  sourceId: string;
  credential: CredentialReference;
}
const CAPTURE_LIMITS = Object.freeze({
  ...DEFAULT_BUDGETS,
  maxExternalCalls: 4,
  maxAttempts: 1,
});
class ApplicationError extends HostBoundaryError {
  constructor(code: ErrorCode) {
    super(code, "Native capture authority denied.");
  }
}

export function nativeCapturePolicy(work: CaptureWork) {
  assertCaptureWork(work);
  const clock = new SystemClock();
  const sessions = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47121"],
    origins: [],
  });
  const issued = new Map<AuthorizationContext, () => void>();
  let closed = false;
  const check = async () => {
    assertCaptureWork(work);
    await work.current();
    if (closed) throw new ApplicationError("AUTH_REQUIRED");
  };
  const verify = (authorization: AuthorizationContext) =>
    !closed &&
    work.isCurrent() &&
    authorization.actorId === work.actorId &&
    sessions.authority(authorization);
  const outputRoot = `outputs_${work.project.projectId}`;
  return Object.freeze({
    clock,
    check,
    verify,
    actorId: work.actorId,
    outputRoot,
    async issueReferenceOffline(input: {
      jobId: string;
      requestId: string;
      jobReads: readonly string[];
      write: boolean;
      deadline: string;
      signal: AbortSignal;
    }): Promise<OperationContext> {
      const owned = { ...input, jobReads: [...input.jobReads] };
      await check();
      if (!work.referenceOfflineAuthority)
        throw new ApplicationError("FORBIDDEN");
      await work.referenceOfflineAuthority();
      if (owned.signal.aborted) throw new ApplicationError("CANCELLED");
      if (owned.jobReads.length > 1000 || issued.size >= 128)
        throw new ApplicationError("INPUT_LIMIT");
      if (
        owned.write &&
        !/^(offline_reference_|convert_reference_)[a-f0-9]{64}$/.test(
          owned.jobId,
        )
      )
        throw new ApplicationError("FORBIDDEN");
      const end = Math.min(clock.now() + 30000, Date.parse(owned.deadline));
      if (!Number.isFinite(end) || end <= clock.now())
        throw new ApplicationError("DEADLINE_EXCEEDED");
      const token = sessions.createSession(
        {
          schemaVersion: "1.0",
          projectId: work.project.projectId,
          actorId: work.actorId,
          sessionId: randomUUID(),
          expiresAt: new Date(end).toISOString(),
          grants: [
            {
              resourceKind: "artifact",
              resourceId: work.project.artifactRootId,
              operations: owned.write ? ["read", "write"] : ["read"],
            },
            {
              resourceKind: "artifact",
              resourceId: outputRoot,
              operations: ["read"],
            },
            ...[...new Set([owned.jobId, ...owned.jobReads])].map(
              (resourceId) => ({
                resourceKind: "job" as const,
                resourceId,
                operations:
                  owned.write && resourceId === owned.jobId
                    ? (["read", "write"] as ["read", "write"])
                    : (["read"] as ["read"]),
              }),
            ),
          ],
          egress: "deny",
        },
        "cli",
      );
      const authorization = sessions.authenticate({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:47121",
        method: "POST",
        bearer: token.credential,
      });
      const detach = () => owned.signal.removeEventListener("abort", abort);
      const abort = () => {
        detach();
        sessions.revoke(authorization);
        issued.delete(authorization);
      };
      owned.signal.addEventListener("abort", abort, { once: true });
      issued.set(authorization, detach);
      if (owned.signal.aborted) {
        abort();
        throw new ApplicationError("CANCELLED");
      }
      return snapshotOperationContext({
        schemaVersion: "1.0",
        projectId: work.project.projectId,
        requestId: owned.requestId,
        jobId: owned.jobId,
        authorization,
        signal: owned.signal,
        clock,
        deadline: new Date(end).toISOString(),
        budget: {
          ...CAPTURE_LIMITS,
          maxExternalCalls: 0,
          maxRasterPixels: 6553600,
        },
      });
    },
    async issueReferenceValidation(supplied: {
      jobId: string;
      requestId: string;
      jobReads: readonly string[];
      deadline: string;
      signal: AbortSignal;
    }): Promise<OperationContext> {
      const input = { ...supplied, jobReads: [...supplied.jobReads] };
      await check();
      if (!work.referenceValidationAuthority)
        throw new ApplicationError("FORBIDDEN");
      await work.referenceValidationAuthority();
      if (input.signal.aborted) throw new ApplicationError("CANCELLED");
      if (input.jobReads.length > 1000 || issued.size >= 128)
        throw new ApplicationError("INPUT_LIMIT");
      const end = Math.min(clock.now() + 30000, Date.parse(input.deadline));
      if (!Number.isFinite(end) || end <= clock.now())
        throw new ApplicationError("DEADLINE_EXCEEDED");
      const token = sessions.createSession(
        {
          schemaVersion: "1.0",
          projectId: work.project.projectId,
          actorId: work.actorId,
          sessionId: randomUUID(),
          expiresAt: new Date(end).toISOString(),
          grants: [
            ...[work.project.artifactRootId, outputRoot].map((resourceId) => ({
              resourceKind: "artifact" as const,
              resourceId,
              operations: ["read"] as ["read"],
            })),
            ...[...new Set([input.jobId, ...input.jobReads])].map(
              (resourceId) => ({
                resourceKind: "job" as const,
                resourceId,
                operations: ["read"] as ["read"],
              }),
            ),
          ],
          egress: "deny",
        },
        "cli",
      );
      const authorization = sessions.authenticate({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:47121",
        method: "POST",
        bearer: token.credential,
      });
      const detach = () => input.signal.removeEventListener("abort", abort);
      const abort = () => {
        detach();
        sessions.revoke(authorization);
        issued.delete(authorization);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      issued.set(authorization, detach);
      if (input.signal.aborted) {
        abort();
        throw new ApplicationError("CANCELLED");
      }
      return snapshotOperationContext({
        schemaVersion: "1.0",
        projectId: work.project.projectId,
        requestId: input.requestId,
        jobId: input.jobId,
        authorization,
        signal: input.signal,
        clock,
        deadline: new Date(end).toISOString(),
        budget: {
          ...CAPTURE_LIMITS,
          maxExternalCalls: 0,
          maxRasterPixels: 6553600,
        },
      });
    },
    async issue(input: {
      jobId: string;
      requestId: string;
      signal: AbortSignal;
      deadline?: string;
      parentSignal?: AbortSignal;
      jobReads?: readonly string[];
      jobWrite?: boolean;
      network?: CapturePolicy;
      reference?: { sourceId: string; diagnostic?: true };
      source?: CapturePolicy;
      output?: boolean;
    }): Promise<OperationContext> {
      const owned = {
        ...input,
        jobReads: [...(input.jobReads ?? [])],
        ...(input.network ? { network: structuredClone(input.network) } : {}),
        ...(input.reference
          ? { reference: structuredClone(input.reference) }
          : {}),
        ...(input.source ? { source: structuredClone(input.source) } : {}),
      };
      await check();
      if (owned.signal.aborted || owned.parentSignal?.aborted)
        throw new ApplicationError("CANCELLED");
      if (owned.reference) {
        if (owned.network || owned.source || !work.referenceAuthority)
          throw new ApplicationError("FORBIDDEN");
        await work.referenceAuthority();
        if (owned.reference.diagnostic) {
          if (!work.diagnosticAuthority)
            throw new ApplicationError("FORBIDDEN");
          await work.diagnosticAuthority();
        }
      }
      if (owned.jobReads.length > 1000)
        throw new ApplicationError("INPUT_LIMIT");
      const credentialExpiry = owned.network
        ? await work.readyCredential(clock.now())
        : undefined;
      await check();
      if (owned.signal.aborted || owned.parentSignal?.aborted)
        throw new ApplicationError("CANCELLED");
      const end = Math.min(
        clock.now() + 30000,
        owned.deadline === undefined ? Infinity : Date.parse(owned.deadline),
        credentialExpiry === undefined
          ? Infinity
          : Date.parse(credentialExpiry),
      );
      if (!Number.isFinite(end) || end <= clock.now())
        throw new ApplicationError("DEADLINE_EXCEEDED");
      const grants: AuthorizationContext["grants"] = [
        {
          resourceKind: "artifact",
          resourceId: work.project.artifactRootId,
          operations: ["read", "write"],
        },
        {
          resourceKind: "job",
          resourceId: owned.jobId,
          operations: owned.jobWrite === false ? ["read"] : ["read", "write"],
        },
        ...owned.jobReads
          .filter((id) => id !== owned.jobId)
          .map((resourceId) => ({
            resourceKind: "job" as const,
            resourceId,
            operations: ["read"] as ["read"],
          })),
      ];
      const source = owned.network ?? owned.source;
      if (source) {
        if (
          source.projectId !== work.project.projectId ||
          source.credential.id !== work.project.reference.id ||
          source.credential.providerId !== work.project.reference.providerId ||
          source.credential.store !== work.project.reference.store
        )
          throw new ApplicationError("FORBIDDEN");
        grants.push(
          {
            resourceKind: "source",
            resourceId: source.sourceId,
            operations: ["capture"],
          },
          {
            resourceKind: "provider",
            resourceId: "figma_rest",
            operations: ["read"],
          },
          {
            resourceKind: "credential",
            resourceId: work.project.reference.id,
            operations: ["credential-use"],
          },
        );
      }
      if (owned.output)
        grants.push({
          resourceKind: "artifact",
          resourceId: outputRoot,
          operations: ["read", "write"],
        });
      if (owned.reference)
        grants.push({
          resourceKind: "source",
          resourceId: owned.reference.sourceId,
          operations: ["reference-download"],
        });
      for (const [authorization, detach] of issued)
        if (Date.parse(authorization.expiresAt) <= clock.now()) {
          detach();
          sessions.revoke(authorization);
          issued.delete(authorization);
        }
      if (issued.size >= 128) throw new ApplicationError("ACTION_REQUIRED");
      const token = sessions.createSession(
        {
          schemaVersion: "1.0",
          projectId: work.project.projectId,
          actorId: work.actorId,
          sessionId: randomUUID(),
          expiresAt: new Date(end).toISOString(),
          grants,
          egress:
            owned.network || owned.reference
              ? "explicit-grant-required"
              : "deny",
        },
        "cli",
      );
      const authorization = sessions.authenticate({
        remoteAddress: "127.0.0.1",
        host: "127.0.0.1:47121",
        method: "POST",
        bearer: token.credential,
      });
      const detach = () => {
        owned.signal.removeEventListener("abort", abort);
        owned.parentSignal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        detach();
        sessions.revoke(authorization);
        issued.delete(authorization);
      };
      owned.signal.addEventListener("abort", abort, { once: true });
      owned.parentSignal?.addEventListener("abort", abort, { once: true });
      issued.set(authorization, detach);
      return snapshotOperationContext({
        schemaVersion: "1.0",
        projectId: work.project.projectId,
        requestId: owned.requestId,
        jobId: owned.jobId,
        authorization,
        signal: owned.signal,
        clock,
        deadline: new Date(end).toISOString(),
        budget: {
          ...CAPTURE_LIMITS,
          ...(owned.reference
            ? { maxExternalCalls: 1, maxRasterPixels: 6553600 }
            : {}),
        },
      });
    },
    close() {
      closed = true;
      for (const [authorization, detach] of issued) {
        detach();
        sessions.revoke(authorization);
      }
      issued.clear();
    },
  });
}
export type NativeCapturePolicy = ReturnType<typeof nativeCapturePolicy>;
