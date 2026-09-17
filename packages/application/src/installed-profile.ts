import { ApplicationError } from "./response.js";
export const INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS = 15000;
export function authorityPolicy(
  value?: typeof INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS,
) {
  if (value === undefined) return {};
  if (value !== INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS)
    throw new ApplicationError("INVALID_INPUT");
  return { authorityTimeoutMs: INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS };
}
