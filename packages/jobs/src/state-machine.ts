import type { JobStatus } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled", "failed", "waiting-for-user", "interrupted"],
  running: [
    "completed",
    "waiting-for-user",
    "retry-wait",
    "failed",
    "cancel-requested",
    "interrupted",
  ],
  "waiting-for-user": ["queued", "cancelled", "failed", "interrupted"],
  "retry-wait": ["running", "cancelled", "interrupted"],
  "cancel-requested": ["cancelled", "completed", "interrupted"],
  interrupted: [
    "queued",
    "cancelled",
    "failed",
    "waiting-for-user",
    "completed",
  ],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!transitions[from]?.includes(to))
    throw new HostBoundaryError("CONFLICT", "Illegal job transition.");
}

export function terminal(status: JobStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function retryDeadline(
  now: number,
  attempt: number,
  backoffMs: number,
  upstream: number | undefined,
  deadline: number,
): number {
  for (const value of [now, attempt, backoffMs, deadline, upstream ?? now])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new HostBoundaryError("INVALID_INPUT", "Invalid retry limit.");
  if (attempt < 1 || attempt > 100 || backoffMs < 1)
    throw new HostBoundaryError("INVALID_INPUT", "Invalid retry limit.");
  const next = Math.max(
    now + Math.min(backoffMs * 2 ** (attempt - 1), 30000),
    upstream ?? now,
  );
  if (!Number.isSafeInteger(next) || next >= deadline)
    throw new HostBoundaryError(
      "DEADLINE_EXCEEDED",
      "Retry exceeds the job deadline.",
    );
  return next;
}
