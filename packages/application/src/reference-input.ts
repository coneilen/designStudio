import type { ReferenceInputAccounting } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import { REFERENCE_LIMITS } from "../../figma-capture/dist/reference.js";

/** One invocation, including storage verification, publication and retained work. */
export class ReferenceInput {
  privateBytes = 0;
  networkBytes = 0;
  maximumFileBytes = REFERENCE_LIMITS.maxInputBytes;
  phase: ReferenceInputAccounting["phase"] = "proof";
  private rejected: ReferenceInputAccounting["rejected"];
  snapshot(): ReferenceInputAccounting {
    return {
      limitBytes: REFERENCE_LIMITS.maxInputBytes,
      privateBytes: this.privateBytes,
      networkBytes: this.networkBytes,
      phase: this.phase,
      ...(this.rejected ? { rejected: { ...this.rejected } } : {}),
    };
  }
  private reject(
    bytes: number,
    kind: "private" | "network",
    limit: "aggregate" | "per-read",
  ) {
    if (Number.isSafeInteger(bytes) && bytes >= 0)
      this.rejected ??= { kind, bytes, limit, phase: this.phase };
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Reference input allowance exhausted.",
    );
  }
  reserveRead(bytes: number) {
    if (bytes > this.maximumFileBytes)
      this.reject(bytes, "private", "per-read");
    this.check(bytes, "private");
    this.privateBytes += bytes;
  }
  reserveNetwork(bytes: number) {
    this.check(bytes, "network");
    this.networkBytes += bytes;
  }
  private check(bytes: number, kind: "private" | "network") {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes >
        REFERENCE_LIMITS.maxInputBytes - this.privateBytes - this.networkBytes
    )
      this.reject(bytes, kind, "aggregate");
  }
}
