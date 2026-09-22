import { HostBoundaryError } from "@design-studio/host";
import { REFERENCE_LIMITS } from "../../figma-capture/dist/reference.js";

/** One invocation, including storage verification, publication and retained work. */
export class ReferenceInput {
  privateBytes = 0;
  networkBytes = 0;
  maximumFileBytes = REFERENCE_LIMITS.maxInputBytes;
  reserveRead(bytes: number) {
    if (bytes > this.maximumFileBytes)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Reference artifact exceeds its per-read bound.",
      );
    this.check(bytes);
    this.privateBytes += bytes;
  }
  reserveNetwork(bytes: number) {
    this.check(bytes);
    this.networkBytes += bytes;
  }
  private check(bytes: number) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes >
        REFERENCE_LIMITS.maxInputBytes - this.privateBytes - this.networkBytes
    )
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Aggregate reference private and network reads exceed the invocation bound.",
      );
  }
}
