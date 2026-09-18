import { timingSafeEqual } from "node:crypto";
import type {
  CredentialReference,
  OperationContext,
  Outcome,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  type Authority,
  boundary,
  HostBoundaryError,
  snapshotOperationContext,
} from "./guards.js";

export type CredentialAdminAction = "setup" | "status" | "update" | "remove";
export interface CredentialClaims {
  declaredExpiresAt?: string;
  declaredScopes?: readonly ("file_metadata:read" | "file_content:read")[];
}
export interface CredentialStatus extends CredentialClaims {
  reference: CredentialReference;
  presence: "present" | "absent";
  expiryEvidence: "user-declared" | "unknown";
}
export interface CredentialAdminState extends CredentialClaims {
  reference: CredentialReference;
  state:
    | "pending-setup"
    | "pending-update"
    | "pending-remove"
    | "ready"
    | "absent"
    | "uncertain";
}
export interface CredentialAdminJournal {
  read(): Promise<CredentialAdminState | undefined>;
  /** Must durably acknowledge nonsecret state before resolving. */
  record(state: Readonly<CredentialAdminState>): Promise<void>;
}
export interface OwnedCredentialAdapter {
  /** All methods settle after actual native work. No abort-wrapper promises. */
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  remove(): Promise<boolean>;
}
export interface CredentialAdminCapability {
  readonly action: CredentialAdminAction;
  readonly reference: Readonly<CredentialReference>;
  readonly projectId: string;
  readonly expiresAt: string;
}
interface Admission {
  context: OperationContext;
  expires: number;
  action: CredentialAdminAction;
  claims: CredentialClaims;
}
interface Options {
  projectId: string;
  actorId: string;
  reference: CredentialReference;
  authority: Authority;
  currentActor(): Promise<string>;
  backend: OwnedCredentialAdapter;
  journal: CredentialAdminJournal;
}
function denied(): never {
  throw new HostBoundaryError(
    "FORBIDDEN",
    "Credential administration scope denied.",
  );
}
export function validateOwnedFigmaReference(
  reference: CredentialReference,
): void {
  if (
    !validateContract("CredentialReference", reference).success ||
    reference.providerId !== "figma_rest" ||
    reference.store !== "windows-credential-manager" ||
    !/^figma_pat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reference.id,
    )
  )
    denied();
}
function claimsFrom(value: unknown): CredentialClaims {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        !["declaredExpiresAt", "declaredScopes"].includes(key) ||
        !("value" in descriptor),
    )
  )
    denied();
  const expiry: unknown = descriptors.declaredExpiresAt?.value;
  const scopes: unknown = descriptors.declaredScopes?.value;
  if (expiry !== undefined && !validateContract("Timestamp", expiry).success)
    denied();
  if (
    scopes !== undefined &&
    (!Array.isArray(scopes) ||
      scopes.length > 2 ||
      scopes.some(
        (scope) => !["file_metadata:read", "file_content:read"].includes(scope),
      ) ||
      new Set(scopes).size !== scopes.length)
  )
    denied();
  return {
    ...(typeof expiry === "string" ? { declaredExpiresAt: expiry } : {}),
    ...(Array.isArray(scopes) ? { declaredScopes: [...scopes] } : {}),
  };
}

/**
 * Internal trusted-composition primitive, not an enrollment entrypoint.
 * Its owner must supply native principal/project admission and a durable journal.
 * Neither construction nor a JSON operation grant establishes that trust.
 */
export class CredentialAdministration {
  readonly #options: Options;
  readonly #capabilities = new WeakMap<CredentialAdminCapability, Admission>();
  #working = false;
  get pending(): boolean {
    return this.#working;
  }
  constructor(options: Options) {
    validateOwnedFigmaReference(options.reference);
    if (
      !validateContract("StableId", options.projectId).success ||
      !validateContract("StableId", options.actorId).success
    )
      denied();
    this.#options = Object.freeze({
      ...options,
      reference: Object.freeze(structuredClone(options.reference)),
    });
  }
  private check(admission: Admission): void {
    const { context, expires } = admission;
    snapshotOperationContext(context);
    const now = context.clock.now();
    if (!Number.isFinite(now)) denied();
    if (context.signal.aborted)
      throw new HostBoundaryError("CANCELLED", "Credential action cancelled.");
    if (now >= Date.parse(context.authorization.expiresAt))
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Credential authority expired.",
      );
    if (now >= expires)
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "Credential action deadline exceeded.",
      );
    if (
      context.projectId !== this.#options.projectId ||
      context.authorization.projectId !== this.#options.projectId ||
      context.authorization.actorId !== this.#options.actorId
    )
      denied();
    if (!this.#options.authority(context.authorization))
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Credential authority revoked.",
      );
  }
  private async recheck(admission: Admission): Promise<void> {
    this.check(admission);
    let actor: string;
    try {
      actor = await this.#options.currentActor();
    } catch {
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Current principal could not be verified.",
      );
    }
    this.check(admission);
    if (actor !== this.#options.actorId) denied();
  }
  async admit(
    input: unknown,
    inputContext: OperationContext,
  ): Promise<CredentialAdminCapability> {
    const context = snapshotOperationContext(inputContext);
    if (!input || typeof input !== "object" || Array.isArray(input)) denied();
    const fields = Object.getOwnPropertyDescriptors(input);
    if (
      Object.entries(fields).some(
        ([key, descriptor]) =>
          !["action", "reference", "confirmation", "claims"].includes(key) ||
          !("value" in descriptor),
      )
    )
      denied();
    let request: {
      action?: CredentialAdminAction;
      reference?: CredentialReference;
      confirmation?: { action?: CredentialAdminAction; referenceId?: string };
      claims?: unknown;
    };
    try {
      request = structuredClone(input);
    } catch {
      denied();
    }
    const { action, reference, confirmation } = request;
    if (
      !action ||
      !["setup", "status", "update", "remove"].includes(action) ||
      !reference ||
      !validateContract("CredentialReference", reference).success ||
      reference.id !== this.#options.reference.id ||
      reference.providerId !== this.#options.reference.providerId ||
      reference.store !== this.#options.reference.store ||
      confirmation?.action !== action ||
      confirmation.referenceId !== reference.id ||
      Object.keys(confirmation).some(
        (key) => !["action", "referenceId"].includes(key),
      )
    )
      denied();
    const claims = claimsFrom(request.claims);
    if (
      (action === "remove" || action === "status") &&
      Object.keys(claims).length
    )
      denied();
    const admission: Admission = {
      context,
      expires: Math.min(
        Date.parse(context.deadline),
        Date.parse(context.authorization.expiresAt),
        context.clock.now() + Math.min(30_000, context.budget.maxDurationMs),
      ),
      action,
      claims,
    };
    await this.recheck(admission);
    const capability = Object.freeze({
      action,
      reference: this.#options.reference,
      projectId: this.#options.projectId,
      expiresAt: new Date(admission.expires).toISOString(),
    });
    this.#capabilities.set(capability, admission);
    return capability;
  }
  async execute(
    capability: CredentialAdminCapability,
    input?: Uint8Array,
  ): Promise<Outcome<CredentialStatus>> {
    let secret: Uint8Array | undefined;
    const admission = this.#capabilities.get(capability);
    if (admission) this.#capabilities.delete(capability);
    try {
      if (!admission) denied();
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
            "Invalid bounded credential bytes.",
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
    try {
      return await boundary(admission.context, async () => {
        if (this.#working)
          throw new HostBoundaryError(
            "CONFLICT",
            "Credential action is still in flight.",
          );
        this.#working = true;
        const { action, claims } = admission;
        let knownClaims = claims;
        let mutationStarted = false;
        let observed: Uint8Array | undefined;
        const record = async (state: CredentialAdminState["state"]) => {
          await this.#options.journal.record(
            Object.freeze({
              reference: this.#options.reference,
              state,
              ...knownClaims,
            }),
          );
        };
        try {
          if (
            (action === "setup" || action === "update") !==
            (secret !== undefined)
          )
            throw new HostBoundaryError(
              "INVALID_INPUT",
              "This credential action requires different input.",
            );
          await this.recheck(admission);
          const prior = await this.#options.journal.read();
          await this.recheck(admission);
          if (prior) {
            if (
              !validateContract("CredentialReference", prior.reference)
                .success ||
              prior.reference.id !== this.#options.reference.id ||
              prior.reference.providerId !==
                this.#options.reference.providerId ||
              prior.reference.store !== this.#options.reference.store ||
              ![
                "pending-setup",
                "pending-update",
                "pending-remove",
                "ready",
                "absent",
                "uncertain",
              ].includes(prior.state)
            )
              denied();
            if (
              action !== "status" &&
              !["ready", "absent"].includes(prior.state)
            )
              throw new HostBoundaryError(
                "ACTION_REQUIRED",
                "Reconcile the uncertain owned entry with an authorized status read first.",
              );
            if (action === "status" && prior.state === "ready")
              knownClaims = claimsFrom({
                ...(prior.declaredExpiresAt === undefined
                  ? {}
                  : { declaredExpiresAt: prior.declaredExpiresAt }),
                ...(prior.declaredScopes === undefined
                  ? {}
                  : { declaredScopes: prior.declaredScopes }),
              });
          }
          observed = await this.#options.backend.read();
          const present = observed !== undefined;
          observed?.fill(0);
          observed = undefined;
          await this.recheck(admission);
          if (action === "setup" && present)
            throw new HostBoundaryError(
              "CONFLICT",
              "Owned credential already exists; use confirmed update.",
            );
          if (action === "update" && !present)
            throw new HostBoundaryError(
              "RESOURCE_UNRESOLVED",
              "Owned credential is absent.",
            );
          if (action !== "status") {
            await record(`pending-${action}`);
            await this.recheck(admission);
            mutationStarted = true;
            if (action === "remove") await this.#options.backend.remove();
            else if (secret) await this.#options.backend.write(secret);
            await this.recheck(admission);
            observed = await this.#options.backend.read();
            const verified =
              action === "remove"
                ? observed === undefined
                : observed !== undefined &&
                  secret !== undefined &&
                  observed.byteLength === secret.byteLength &&
                  timingSafeEqual(observed, secret);
            observed?.fill(0);
            observed = undefined;
            await this.recheck(admission);
            if (!verified)
              throw new HostBoundaryError(
                "OUTPUT_UNCERTAIN",
                "Credential verification did not confirm the requested change.",
              );
          }
          const presence =
            action === "status"
              ? present
                ? "present"
                : "absent"
              : action === "remove"
                ? "absent"
                : "present";
          if (presence === "absent") knownClaims = {};
          await record(presence === "present" ? "ready" : "absent");
          await this.recheck(admission);
          return {
            reference: structuredClone(this.#options.reference),
            presence,
            ...knownClaims,
            expiryEvidence: knownClaims.declaredExpiresAt
              ? "user-declared"
              : "unknown",
          };
        } catch (error) {
          if (mutationStarted) {
            try {
              await record("uncertain");
            } catch {
              throw new HostBoundaryError(
                "OUTPUT_UNCERTAIN",
                "Credential change and journal state are uncertain; reconcile the owned reference.",
              );
            }
            throw new HostBoundaryError(
              "OUTPUT_UNCERTAIN",
              "Credential change may have taken effect; reconcile the owned reference.",
            );
          }
          if (error instanceof HostBoundaryError)
            throw new HostBoundaryError(
              error.code,
              `Credential administration failed (${error.code}); sensitive details withheld.`,
              error.unavailable,
            );
          throw new HostBoundaryError(
            "PROVIDER_UNAVAILABLE",
            "Credential backend or journal unavailable; no fallback.",
            true,
          );
        } finally {
          observed?.fill(0);
          this.#working = false;
        }
      });
    } finally {
      secret?.fill(0);
    }
  }
}
