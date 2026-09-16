import { createHash } from "node:crypto";
import type {
  Artifact,
  Budget,
  LicenseEvidence,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";

export interface AssetDiagnostic {
  code: string;
  message: string;
  measured?: number;
  allowed?: number;
}

export class AssetError extends Error {
  constructor(readonly diagnostic: AssetDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "AssetError";
  }
}

export function fail(code: string, message: string): never {
  throw new AssetError({ code, message });
}

export function bound(code: string, measured: number, allowed: number): void {
  if (!Number.isSafeInteger(measured) || measured < 0 || measured > allowed) {
    throw new AssetError({
      code,
      message: "Resource budget exceeded",
      measured,
      allowed,
    });
  }
}

export function validateLimits(limits: Budget): void {
  if (
    !validateContract("Budget", limits).success ||
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    fail("INVALID_BUDGET", "Expected validated finite integer caller budgets");
  }
}

export function inputLimit(bytes: Uint8Array, limits: Budget): void {
  validateLimits(limits);
  bound("INPUT_BYTES", bytes.byteLength, limits.maxInputBytes);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyBytes(
  bytes: Uint8Array,
  expected: Pick<Artifact, "sha256" | "byteLength">,
): void {
  if (
    bytes.byteLength !== expected.byteLength ||
    sha256(bytes) !== expected.sha256
  ) {
    fail(
      "BYTE_IDENTITY",
      "Artifact size or SHA-256 does not match the pinned identity",
    );
  }
}

export type RightsUse = "redistribute" | "embed" | "local-render";
export type RightsAuthority = (
  license: LicenseEvidence,
  contentSha256: string,
  use: RightsUse,
) => boolean;

export function verifyRights(
  license: LicenseEvidence,
  content: Uint8Array,
  notice: Uint8Array,
  use: RightsUse,
  authority: RightsAuthority,
): void {
  if (!validateContract("LicenseEvidence", license).success)
    fail("RIGHTS_INVALID", "Invalid license evidence");
  verifyBytes(notice, license.notice);
  if (
    (use === "redistribute" && license.redistribution !== "permitted") ||
    (use === "embed" && license.embedding !== "permitted") ||
    !authority(license, sha256(content), use)
  ) {
    fail(
      "RIGHTS_UNVERIFIED",
      "Trusted rights approval for these exact bytes and use is required",
    );
  }
}
