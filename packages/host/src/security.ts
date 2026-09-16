import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  AuthorizationContext,
  Budget,
  Clock,
  CredentialReference,
  CredentialStore,
  OperationContext,
  Outcome,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  type Authority,
  authorizeOperation,
  boundary,
  HostBoundaryError,
  OperationGuard,
} from "./guards.js";

const digest = (text: string) => createHash("sha256").update(text).digest();
const equal = (text: string, expected: Uint8Array) =>
  timingSafeEqual(digest(text), expected);

export interface LocalSessionOptions {
  clock: Clock;
  hosts: readonly string[];
  origins: readonly string[];
}
export interface LocalRequest {
  remoteAddress: string;
  host: string;
  method: string;
  origin?: string;
  fetchSite?: string;
  bearer?: string;
  cookie?: string;
  csrf?: string;
}
interface Session {
  authorization: AuthorizationContext;
  mode: "cli" | "browser";
  credentialHash: Uint8Array;
  csrfHash: Uint8Array;
}
export class LocalSessionAuthenticator {
  private readonly sessions = new Set<Session>();
  private readonly hosts: ReadonlySet<string>;
  private readonly origins: ReadonlySet<string>;
  private readonly clock: Clock;
  constructor(options: LocalSessionOptions) {
    this.clock = options.clock;
    if (
      !options.hosts.length ||
      options.hosts.some(
        (host) =>
          !/^(localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(host) ||
          Number(host.slice(host.lastIndexOf(":") + 1)) > 65535,
      )
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Host allowlist must use explicit loopback hosts and ports.",
      );
    for (const origin of options.origins) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid origin allowlist.",
        );
      }
      if (
        url.origin !== origin ||
        !["http:", "https:"].includes(url.protocol) ||
        origin.includes("*")
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Origins must be exact HTTP origins, never null or wildcard.",
        );
    }
    this.hosts = new Set(options.hosts);
    this.origins = new Set(options.origins);
  }
  createSession(
    authorization: AuthorizationContext,
    mode: "cli" | "browser",
  ): { credential: string; csrf: string } {
    if (
      !validateContract("AuthorizationContext", authorization).success ||
      Date.parse(authorization.expiresAt) <= this.clock.now()
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid or expired session authorization.",
      );
    const owned = structuredClone(authorization);
    for (const grant of owned.grants) {
      Object.freeze(grant.operations);
      Object.freeze(grant);
    }
    Object.freeze(owned.grants);
    Object.freeze(owned);
    const credential = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.add({
      authorization: owned,
      mode,
      credentialHash: digest(credential),
      csrfHash: digest(csrf),
    });
    return { credential, csrf };
  }
  readonly authority: Authority = (authorization) => {
    for (const session of this.sessions)
      if (
        session.authorization === authorization &&
        this.clock.now() < Date.parse(authorization.expiresAt)
      )
        return true;
    return false;
  };
  revoke(authorization: AuthorizationContext): void {
    for (const session of this.sessions) {
      if (session.authorization === authorization) {
        session.credentialHash.fill(0);
        session.csrfHash.fill(0);
        this.sessions.delete(session);
      }
    }
  }
  authenticate(request: LocalRequest): AuthorizationContext {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        request.remoteAddress,
      ) ||
      !this.hosts.has(request.host)
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Loopback address or Host denied.",
      );
    const mode = request.bearer !== undefined ? "cli" : "browser";
    if (
      (mode === "cli" &&
        (request.cookie !== undefined ||
          request.origin !== undefined ||
          request.fetchSite !== undefined)) ||
      (mode === "browser" &&
        (request.origin === undefined ||
          !this.origins.has(request.origin) ||
          (request.fetchSite !== undefined &&
            request.fetchSite !== "same-origin")))
    )
      throw new HostBoundaryError(
        "ORIGIN_FORBIDDEN",
        "Origin or client trust mode denied.",
      );
    const credential = request.bearer ?? request.cookie ?? "";
    if (credential.length > 256)
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Invalid session credential.",
      );
    let matched: Session | undefined;
    // Hash to fixed length before constant-time comparison, even for malformed tokens.
    for (const session of this.sessions)
      if (equal(credential, session.credentialHash) && session.mode === mode)
        matched = session;
    if (!matched || !this.authority(matched.authorization))
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Invalid or expired session credential.",
      );
    if (
      mode === "browser" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      (!request.csrf ||
        request.csrf.length > 256 ||
        !equal(request.csrf, matched.csrfHash))
    )
      throw new HostBoundaryError("CSRF_INVALID", "CSRF token required.");
    return matched.authorization;
  }
}

export class Redactor {
  private readonly secrets = new Set<string>();
  addSecret(bytes: Uint8Array): void {
    const buffer = Buffer.from(bytes);
    const text = buffer.toString("utf8");
    for (const value of [
      text,
      encodeURIComponent(text),
      buffer.toString("hex"),
      buffer.toString("base64"),
      buffer.toString("base64url"),
    ])
      if (value) this.secrets.add(value);
  }
  containsSecret(text: string): boolean {
    return [...this.secrets].some((secret) => text.includes(secret));
  }
  redact(text: string): string {
    let safe = text;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      safe = safe.split(secret).join("[REDACTED]");
    safe = safe.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]");
    return safe.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return `${url.href}[RETRIEVAL-METADATA-REDACTED]`;
      } catch {
        return "[REDACTED-URL]";
      }
    });
  }
}

export interface NativeCredentialBackend {
  readonly store: Exclude<CredentialReference["store"], "test-fake">;
  readonly capability: "verified-native" | "native-binding";
  /** Returns exclusively owned bytes; caller zeroes them after use. No enumeration. */
  read(
    reference: CredentialReference,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
export interface CredentialStoreOptions {
  projectId: string;
  authority: Authority;
  references: readonly CredentialReference[];
  redactor: Redactor;
  backend?: NativeCredentialBackend;
  budgetLimits?: Readonly<Budget>;
}
function secretInValue(
  value: unknown,
  redactor: Redactor,
  visited = new Set<unknown>(),
): boolean {
  if (typeof value === "string") return redactor.containsSecret(value);
  if (value instanceof Uint8Array)
    return (
      redactor.containsSecret(Buffer.from(value).toString("utf8")) ||
      redactor.containsSecret(Buffer.from(value).toString("base64"))
    );
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) &&
    redactor.containsSecret(Buffer.from(value).toString("utf8"))
  )
    return true;
  if (value === null || value === undefined || typeof value === "boolean")
    return false;
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value !== "object") return true;
  if (visited.has(value)) return true;
  visited.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return true;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).some(
    ([key, descriptor]) =>
      redactor.containsSecret(key) ||
      !("value" in descriptor) ||
      secretInValue(descriptor.value, redactor, visited),
  );
}
export class ScopedCredentialStore implements CredentialStore {
  private readonly references: readonly CredentialReference[];
  constructor(private readonly options: CredentialStoreOptions) {
    this.references = structuredClone(options.references);
  }
  use<T>(
    input: CredentialReference,
    context: OperationContext,
    consumer: (secret: Uint8Array) => Promise<T>,
  ): Promise<Outcome<T>> {
    return boundary(context, async () => {
      if (!validateContract("CredentialReference", input).success)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid credential reference.",
        );
      const reference = structuredClone(input);
      const guard = new OperationGuard(
        context,
        {
          projectId: this.options.projectId,
          resourceKind: "credential",
          resourceId: reference.id,
          operation: "credential-use",
        },
        this.options.authority,
        undefined,
        this.options.budgetLimits,
      );
      if (
        !validateContract("CredentialReference", reference).success ||
        !this.references.some(
          (entry) =>
            entry.id === reference.id &&
            entry.providerId === reference.providerId &&
            entry.store === reference.store,
        )
      )
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Credential reference is not configured for this project/provider.",
        );
      const backend = this.options.backend;
      if (!backend)
        throw new HostBoundaryError(
          "PROVIDER_UNAVAILABLE",
          "Native vault binding is not installed or verified; no plaintext fallback.",
          true,
        );
      if (
        backend.store !== reference.store ||
        !["verified-native", "native-binding"].includes(backend.capability)
      )
        throw new HostBoundaryError(
          "PROVIDER_UNAVAILABLE",
          "Configured vault backend does not support this store.",
          true,
        );
      const watch = guard.watch();
      let secret: Uint8Array | undefined;
      let cancel: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(watch.signal.reason);
          watch.signal.addEventListener("abort", cancel, { once: true });
          if (watch.signal.aborted) cancel();
        });
        const work = (async () => {
          const loaded = await backend.read(reference, watch.signal);
          if (watch.signal.aborted) {
            loaded.fill(0);
            throw watch.signal.reason;
          }
          secret = loaded;
          guard.consume("input", secret.byteLength);
          this.options.redactor.addSecret(secret);
          const value = await consumer(secret);
          if (secretInValue(value, this.options.redactor))
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Credential callback attempted to return secret material.",
            );
          guard.consume(
            "output",
            value instanceof Uint8Array
              ? value.byteLength
              : Buffer.byteLength(JSON.stringify(value) ?? ""),
          );
          guard.check();
          return value;
        })();
        return await Promise.race([work, cancelled]);
      } catch (error) {
        if (error instanceof HostBoundaryError)
          throw new HostBoundaryError(
            error.code,
            `Credential use failed (${error.code}); sensitive details withheld.`,
            error.unavailable,
          );
        throw new HostBoundaryError(
          "INTERNAL_ERROR",
          "Credential backend or consumer failed; sensitive details withheld.",
        );
      } finally {
        secret?.fill(0);
        if (cancel) watch.signal.removeEventListener("abort", cancel);
        await watch.close();
      }
    });
  }
}

export interface EgressRequest {
  providerId: string;
  dataClasses: readonly string[];
  evidenceIds: readonly string[];
}
export interface EgressPolicy {
  projectId: string;
  authority: Authority;
  rules: readonly { providerId: string; dataClasses: readonly string[] }[];
}
export interface EgressDecision {
  id: string;
  projectId: string;
  actorId: string;
  providerId: string;
  dataClasses: readonly string[];
  evidenceIds: readonly string[];
  allowed: boolean;
  reason: string;
}
export function decideEgress(
  context: OperationContext,
  request: EgressRequest,
  policy: EgressPolicy,
): EgressDecision {
  let allowed = false;
  let reason = "Project policy denies external data.";
  try {
    authorizeOperation(
      context,
      {
        projectId: policy.projectId,
        resourceKind: "provider",
        resourceId: request.providerId,
        operation: "model-egress",
      },
      policy.authority,
    );
    if (
      context.authorization.egress === "explicit-grant-required" &&
      context.budget.maxExternalCalls > 0 &&
      request.dataClasses.length > 0 &&
      request.evidenceIds.length > 0 &&
      policy.rules.some(
        (rule) =>
          rule.providerId === request.providerId &&
          request.dataClasses.every((kind) => rule.dataClasses.includes(kind)),
      )
    ) {
      allowed = true;
      reason =
        "Configured provider and every data class permitted; not a transmission receipt.";
    }
  } catch (error) {
    if (!(error instanceof HostBoundaryError)) throw error;
    reason = error.message;
  }
  return {
    id: randomUUID(),
    projectId: context.projectId,
    actorId: context.authorization.actorId,
    providerId: request.providerId,
    dataClasses: [...request.dataClasses],
    evidenceIds: [...request.evidenceIds],
    allowed,
    reason,
  };
}
