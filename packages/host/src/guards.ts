import { setTimeout as delay } from "node:timers/promises";
import {
  type AuthorizationContext,
  type Budget,
  type Clock,
  DEFAULT_BUDGETS,
  type ErrorCode,
  type Operation,
  type OperationContext,
  type Outcome,
  validateContract,
} from "@design-studio/contracts";

export class HostBoundaryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly unavailable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostBoundaryError";
  }
}

export type Authority = (authorization: AuthorizationContext) => boolean;
export interface OperationScope {
  projectId: string;
  actorId?: string;
  resourceKind: AuthorizationContext["grants"][number]["resourceKind"];
  resourceId: string;
  operation: Operation;
}
const ownedContexts = new WeakMap<OperationContext, string>();
function assertAuthorizationUnchanged(context: OperationContext): void {
  const initial = ownedContexts.get(context);
  if (
    initial !== undefined &&
    initial !== JSON.stringify(context.authorization)
  )
    throw new HostBoundaryError(
      "FORBIDDEN",
      "Authorization changed after the operation snapshot.",
    );
}
export function snapshotOperationContext(
  context: OperationContext,
): OperationContext {
  if (ownedContexts.has(context)) {
    assertAuthorizationUnchanged(context);
    return context;
  }
  const { signal, clock, ...request } = context;
  if (!validateContract("OperationRequestContext", request).success)
    throw new HostBoundaryError("INVALID_INPUT", "Invalid operation context.");
  const owned: OperationContext = Object.freeze({
    ...request,
    budget: Object.freeze({ ...request.budget }),
    authorization: context.authorization,
    signal,
    clock,
  });
  ownedContexts.set(owned, JSON.stringify(owned.authorization));
  return owned;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new HostBoundaryError("INVALID_INPUT", "Invalid sleep duration.");
    // Node timers overflow above 2^31-1; chunk rather than silently firing early.
    let remaining = milliseconds;
    do {
      const chunk = Math.min(remaining, 2_147_483_647);
      await delay(chunk, undefined, { signal });
      remaining -= chunk;
    } while (remaining > 0);
  }
}

export function authorizeOperation(
  context: OperationContext,
  scope: OperationScope,
  authority: Authority,
): void {
  assertAuthorizationUnchanged(context);
  const { clock, signal, ...request } = context;
  if (!validateContract("OperationRequestContext", request).success)
    throw new HostBoundaryError("INVALID_INPUT", "Invalid operation context.");
  if (signal.aborted)
    throw new HostBoundaryError("CANCELLED", "Operation cancelled.");
  const now = clock.now();
  if (!Number.isFinite(now))
    throw new HostBoundaryError("INVALID_INPUT", "Invalid clock value.");
  if (now >= Date.parse(context.deadline))
    throw new HostBoundaryError(
      "DEADLINE_EXCEEDED",
      "Operation deadline exceeded.",
    );
  const auth = context.authorization;
  if (now >= Date.parse(auth.expiresAt))
    throw new HostBoundaryError("AUTH_REQUIRED", "Session expired.");
  if (
    context.projectId !== scope.projectId ||
    auth.projectId !== scope.projectId ||
    (scope.actorId !== undefined && auth.actorId !== scope.actorId)
  )
    throw new HostBoundaryError("FORBIDDEN", "Project or actor scope denied.");
  if (!authority(auth))
    throw new HostBoundaryError(
      "AUTH_REQUIRED",
      "Trusted authority rejected session.",
    );
  if (
    !auth.grants.some(
      (grant) =>
        grant.resourceKind === scope.resourceKind &&
        grant.resourceId === scope.resourceId &&
        grant.operations.includes(scope.operation),
    )
  )
    throw new HostBoundaryError(
      "FORBIDDEN",
      "Resource operation grant denied.",
    );
}

export class OperationGuard {
  readonly context: OperationContext;
  private readonly scope: OperationScope;
  readonly expiresAt: number;
  private input = 0;
  private output = 0;
  private readonly limits: Readonly<Budget>;
  constructor(
    context: OperationContext,
    scope: OperationScope,
    private readonly authority: Authority,
    timeoutMs = context.budget.maxDurationMs,
    limits: Readonly<Budget> = DEFAULT_BUDGETS,
  ) {
    this.context = snapshotOperationContext(context);
    context = this.context;
    this.scope = Object.freeze({ ...scope });
    authorizeOperation(context, scope, authority);
    if (!validateContract("Budget", limits).success)
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid trusted budget limits.",
      );
    this.limits = Object.freeze({ ...limits });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid operation timeout.",
      );
    this.expiresAt = Math.min(
      Date.parse(context.deadline),
      Date.parse(context.authorization.expiresAt),
      context.clock.now() + context.budget.maxDurationMs,
      context.clock.now() + timeoutMs,
    );
    this.check();
  }
  check(): void {
    authorizeOperation(this.context, this.scope, this.authority);
    for (const key of Object.keys(this.limits) as (keyof Budget)[])
      if (this.context.budget[key] > this.limits[key])
        throw new HostBoundaryError(
          "POLICY_FAILED",
          "Request budget exceeds trusted host limit.",
        );
    if (this.context.clock.now() >= this.expiresAt)
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "Operation deadline exceeded.",
      );
  }
  consume(kind: "input" | "output", bytes: number): void {
    this.check();
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new HostBoundaryError("INVALID_INPUT", "Invalid byte count.");
    const limit =
      kind === "input"
        ? this.context.budget.maxInputBytes
        : this.context.budget.maxOutputBytes;
    if (bytes > limit - this[kind])
      throw new HostBoundaryError(
        kind === "input" ? "INPUT_LIMIT" : "OUTPUT_LIMIT",
        `${kind} byte limit exceeded.`,
      );
    this[kind] += bytes;
  }
  watch(): { signal: AbortSignal; close: () => Promise<void> } {
    this.check();
    const controller = new AbortController();
    const timer = new AbortController();
    const cancel = () =>
      controller.abort(
        new HostBoundaryError("CANCELLED", "Operation cancelled."),
      );
    this.context.signal.addEventListener("abort", cancel, { once: true });
    if (this.context.signal.aborted) cancel();
    const sleeping = this.context.clock
      .sleep(
        Math.max(0, Math.ceil(this.expiresAt - this.context.clock.now())),
        timer.signal,
      )
      .then(
        () =>
          controller.abort(
            new HostBoundaryError(
              "DEADLINE_EXCEEDED",
              "Operation deadline exceeded.",
            ),
          ),
        (error: unknown) => {
          if (
            timer.signal.aborted &&
            error instanceof Error &&
            error.name === "AbortError"
          )
            return;
          controller.abort(
            new HostBoundaryError(
              "INTERNAL_ERROR",
              "Deadline clock failed.",
              false,
              { cause: error },
            ),
          );
        },
      );
    return {
      signal: controller.signal,
      close: async () => {
        timer.abort();
        this.context.signal.removeEventListener("abort", cancel);
        await sleeping;
      },
    };
  }
}

export function complete<T>(context: OperationContext, value: T): Outcome<T> {
  return {
    schemaVersion: "1.0",
    projectId: context.projectId,
    requestId: context.requestId,
    status: "complete",
    value,
    diagnosticIds: [],
  };
}

export async function boundary<T>(
  context: OperationContext,
  operation: (context: OperationContext) => Promise<T>,
): Promise<Outcome<T>> {
  try {
    context = snapshotOperationContext(context);
    return complete(context, await operation(context));
  } catch (error) {
    if (!(error instanceof HostBoundaryError)) throw error;
    return {
      schemaVersion: "1.0",
      projectId: context.projectId,
      requestId: context.requestId,
      status:
        error.code === "CANCELLED"
          ? "cancelled"
          : error.code === "OUTPUT_UNCERTAIN" || error.code === "INTERRUPTED"
            ? "interrupted"
            : error.unavailable
              ? "unavailable"
              : "failed",
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        diagnosticIds: [],
      },
      diagnosticIds: [],
    };
  }
}
