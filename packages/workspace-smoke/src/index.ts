import { createHash } from "node:crypto";

export function fingerprintFixture(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
