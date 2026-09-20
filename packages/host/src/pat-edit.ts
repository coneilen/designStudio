import { HostBoundaryError } from "./guards.js";
import { decodePatUtf16, patUtf16, replacementLength } from "./pat-input.js";

export interface PatEditPort {
  /** Returns an owned bounded clipboard copy, only in response to paste(). */
  clipboard(): Uint8Array;
  length(): number;
  selection(): { start: number; end: number };
  insert(bytes: Uint8Array): void;
  read(): Uint8Array;
  clear(): void;
  changed(valid: boolean): void;
  rejected(): void;
}
export class PatEditBoundary {
  constructor(private readonly port: PatEditPort) {}
  private reject(error: unknown): false {
    try {
      this.port.clear();
      this.port.changed(false);
    } catch {
      throw error instanceof HostBoundaryError
        ? error
        : new HostBoundaryError(
            "INTERRUPTED",
            "Native input cleanup failed; sensitive details withheld.",
          );
    }
    if (
      error instanceof HostBoundaryError &&
      (error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED")
    )
      throw error;
    if (
      error instanceof HostBoundaryError &&
      (error.code === "INVALID_INPUT" || error.code === "RESOURCE_UNRESOLVED")
    ) {
      this.port.rejected();
      return false;
    }
    throw new HostBoundaryError(
      "INTERRUPTED",
      "Native input ownership failed; sensitive details withheld.",
    );
  }
  paste(): boolean {
    let copy: Uint8Array | undefined;
    let token: Uint8Array | undefined;
    let insertion: Uint8Array | undefined;
    try {
      copy = this.port.clipboard();
      token = decodePatUtf16(copy);
      const selected = this.port.selection();
      const length = replacementLength(
        this.port.length(),
        selected.start,
        selected.end,
        token.length,
      );
      insertion = patUtf16(token);
      this.port.insert(insertion);
      if (this.port.length() !== length)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Native edit length disagreed with validated insertion.",
        );
      this.port.changed(length > 0);
      return true;
    } catch (error) {
      return this.reject(error);
    } finally {
      copy?.fill(0);
      token?.fill(0);
      insertion?.fill(0);
    }
  }
  character(value: number): boolean {
    try {
      if (!Number.isInteger(value) || value < 33 || value > 126)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Unsupported input character.",
        );
      const selected = this.port.selection();
      replacementLength(this.port.length(), selected.start, selected.end, 1);
      return true;
    } catch (error) {
      return this.reject(error);
    }
  }
  submit(): Buffer | undefined {
    let copy: Uint8Array | undefined;
    let token: Buffer | undefined;
    try {
      const before = this.port.length();
      if (!Number.isSafeInteger(before) || before < 1 || before > 4096)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid native edit length.",
        );
      copy = this.port.read();
      token = decodePatUtf16(copy);
      if (token.length !== before || this.port.length() !== before)
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Native input changed during acceptance.",
        );
      return token;
    } catch (error) {
      token?.fill(0);
      this.reject(error);
      return undefined;
    } finally {
      copy?.fill(0);
    }
  }
}
