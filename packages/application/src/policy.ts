import { randomUUID } from "node:crypto";
import {
  type AuthorizationContext,
  type Budget,
  type Clock,
  DEFAULT_BUDGETS,
  type OperationContext,
  validateContract,
} from "@design-studio/contracts";
import {
  LocalSessionAuthenticator,
  snapshotOperationContext,
} from "@design-studio/host";
import { FIXTURE_IDS } from "./catalog.js";
import { ApplicationError } from "./response.js";
import { ARTIFACT_ROOT, PROJECT_ID } from "./routes.js";

export type Grants = AuthorizationContext["grants"];
export interface IssueRequest {
  requestId: string;
  jobId?: string;
  grants: Grants;
  signal: AbortSignal;
  deadline?: string;
  budget?: Budget;
  sourceAuthority?(): boolean;
}
export function createFixturePolicy(options: {
  clock: Clock;
  expectedActor: string;
  currentActor(): Promise<string>;
  onRevoked(): void;
}) {
  const clock = options.clock;
  const currentActor = options.currentActor;
  const expectedActor = options.expectedActor;
  const onRevoked = options.onRevoked;
  const sessions = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47119"],
    origins: [],
  });
  const issued = new Map<AuthorizationContext, () => void>();
  const sources = new WeakMap<AuthorizationContext, () => boolean>();
  let revoked = false;
  function revoke() {
    if (revoked) return;
    revoked = true;
    for (const [authorization, detach] of issued) {
      detach();
      sessions.revoke(authorization);
    }
    issued.clear();
    onRevoked();
  }
  const verify = (authorization: AuthorizationContext) =>
    !revoked &&
    authorization.actorId === expectedActor &&
    sessions.authority(authorization) &&
    (sources.get(authorization)?.() ?? true);
  async function check() {
    let actor: string;
    try {
      actor = await currentActor();
    } catch (error) {
      revoke();
      throw error;
    }
    if (revoked || actor !== expectedActor) {
      revoke();
      throw new ApplicationError("FORBIDDEN", 403);
    }
  }
  async function issue(input: IssueRequest): Promise<OperationContext> {
    if (
      !Array.isArray(input.grants) ||
      input.grants.length > 2048 ||
      !validateContract("JsonValue", input.grants).success ||
      !validateContract("Budget", input.budget ?? DEFAULT_BUDGETS).success
    )
      throw new ApplicationError("INVALID_INPUT");
    const owned = {
      ...input,
      grants: structuredClone(input.grants),
      budget: { ...(input.budget ?? DEFAULT_BUDGETS) },
    };
    if (
      !validateContract("Budget", owned.budget).success ||
      !validateContract("StableId", owned.requestId).success ||
      (owned.jobId !== undefined &&
        !validateContract("StableId", owned.jobId).success)
    )
      throw new ApplicationError("INVALID_INPUT");
    for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof Budget)[])
      if (owned.budget[key] > DEFAULT_BUDGETS[key])
        throw new ApplicationError("FORBIDDEN", 403);
    for (const grant of owned.grants) {
      if (
        !validateContract("StableId", grant.resourceId).success ||
        !["artifact", "design", "revision", "job", "provider"].includes(
          grant.resourceKind,
        ) ||
        grant.operations.some(
          (operation) => !["read", "write", "execute"].includes(operation),
        )
      )
        throw new ApplicationError("FORBIDDEN", 403);
      if (
        grant.resourceKind === "design" &&
        !FIXTURE_IDS.some((id) => grant.resourceId === `design_${id}`)
      )
        throw new ApplicationError("FORBIDDEN", 403);
      if (
        grant.resourceKind === "provider" &&
        (grant.resourceId !== "renderer_static" ||
          grant.operations.some((op) => op !== "execute"))
      )
        throw new ApplicationError("FORBIDDEN", 403);
      if (
        grant.operations.includes("execute") &&
        grant.resourceKind !== "provider"
      )
        throw new ApplicationError("FORBIDDEN", 403);
    }
    await check();
    if (owned.sourceAuthority && !owned.sourceAuthority())
      throw new ApplicationError("AUTH_REQUIRED", 401);
    if (owned.signal.aborted) throw new ApplicationError("CANCELLED");
    const end = Math.min(
      clock.now() + owned.budget.maxDurationMs,
      owned.deadline === undefined ? Infinity : Date.parse(owned.deadline),
    );
    if (!Number.isFinite(end) || end <= clock.now())
      throw new ApplicationError("DEADLINE_EXCEEDED", 504);
    for (const [authorization, detach] of issued)
      if (Date.parse(authorization.expiresAt) <= clock.now()) {
        detach();
        sessions.revoke(authorization);
        issued.delete(authorization);
      }
    if (issued.size >= 1024) throw new ApplicationError("ACTION_REQUIRED", 409);
    const credentials = sessions.createSession(
      {
        schemaVersion: "1.0",
        projectId: PROJECT_ID,
        actorId: expectedActor,
        sessionId: randomUUID(),
        expiresAt: new Date(end).toISOString(),
        egress: "deny",
        grants: owned.grants,
      },
      "cli",
    );
    const authorization = sessions.authenticate({
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:47119",
      method: "POST",
      bearer: credentials.credential,
    });
    if (owned.sourceAuthority)
      sources.set(authorization, owned.sourceAuthority);
    const abort = () => {
      sessions.revoke(authorization);
      issued.delete(authorization);
    };
    owned.signal.addEventListener("abort", abort, { once: true });
    issued.set(authorization, () =>
      owned.signal.removeEventListener("abort", abort),
    );
    return snapshotOperationContext({
      schemaVersion: "1.0",
      projectId: PROJECT_ID,
      requestId: owned.requestId,
      ...(owned.jobId ? { jobId: owned.jobId } : {}),
      authorization,
      budget: owned.budget,
      deadline: new Date(end).toISOString(),
      clock,
      signal: owned.signal,
    });
  }
  return {
    issue,
    verify,
    check,
    revoke,
    clock,
    actorId: expectedActor,
    rootGrant: {
      resourceKind: "artifact" as const,
      resourceId: ARTIFACT_ROOT,
      operations: ["read", "write"] as ["read", "write"],
    },
  };
}
export type FixturePolicy = ReturnType<typeof createFixturePolicy>;
