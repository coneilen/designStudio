import { HostBoundaryError } from "@design-studio/host";
import type {
  CredentialAdminAction,
  CredentialAdminState,
} from "../../host/dist/credential-admin.js";

export const CREDENTIAL_JOURNAL_RECORDS = 1024;
export const CREDENTIAL_NORMAL_RESERVE = 8;
function remaining(count: number, maximum: number): number {
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(maximum) ||
    maximum < CREDENTIAL_NORMAL_RESERVE ||
    maximum > CREDENTIAL_JOURNAL_RECORDS ||
    count < 0 ||
    count > maximum
  )
    throw new HostBoundaryError(
      "ACTION_REQUIRED",
      "Credential journal capacity/history is invalid.",
    );
  return maximum - count;
}
/** maximum is a pure-policy test seam; native storage always uses the fixed 1024 ceiling. */
export function admitCredentialCapacity(
  action: CredentialAdminAction,
  count: number,
  state: CredentialAdminState["state"] | undefined,
  maximum = CREDENTIAL_JOURNAL_RECORDS,
): void {
  const free = remaining(count, maximum);
  const required =
    action === "setup" || action === "update"
      ? CREDENTIAL_NORMAL_RESERVE
      : action === "remove" && state !== "pending-remove"
        ? 2
        : 1;
  if (free < required)
    throw new HostBoundaryError(
      "ACTION_REQUIRED",
      "Credential journal lacks reserved capacity; no vault action was admitted.",
    );
}
export function credentialStateWrite(
  prior: CredentialAdminState | undefined,
  next: CredentialAdminState,
  count: number,
  maximum = CREDENTIAL_JOURNAL_RECORDS,
): "append" | "retain" {
  const free = remaining(count, maximum);
  if (JSON.stringify(prior) === JSON.stringify(next)) return "retain";
  if (prior?.state === "absent" && next.state === "uncertain") return "retain";
  if (
    prior?.state === "pending-remove" &&
    (next.state === "uncertain" ||
      (next.state === "ready" && free < CREDENTIAL_NORMAL_RESERVE))
  )
    return "retain";
  if (next.state === "pending-setup" || next.state === "pending-update")
    admitCredentialCapacity(
      next.state === "pending-setup" ? "setup" : "update",
      count,
      prior?.state,
      maximum,
    );
  if (next.state === "pending-remove")
    admitCredentialCapacity("remove", count, prior?.state, maximum);
  if (free < 1)
    throw new HostBoundaryError(
      "ACTION_REQUIRED",
      "Credential journal terminal capacity is unavailable.",
    );
  return "append";
}
