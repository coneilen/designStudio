import {
  type ContractName,
  type ContractTypes,
  type Diagnostic,
  type ErrorCode,
  type JsonObject,
  type JsonValue,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";

export class FigmaImportError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(
    code: ErrorCode,
    message: string,
    pointer = "",
    limit?: Diagnostic["limit"],
  ) {
    super(message);
    this.name = "FigmaImportError";
    this.diagnostic = {
      schemaVersion: "1.0",
      id: `diagnostic_${canonicalDigest([code, message, pointer])}`,
      code,
      severity: "error",
      message,
      operations: ["read", "resolve"],
      nodeIds: [],
      pointer,
      evidenceIds: [],
      recovery:
        "Supply a bounded selected nodes response; do not substitute or infer missing source.",
      ...(limit ? { limit } : {}),
    };
  }
}

export function fail(code: ErrorCode, message: string, pointer = ""): never {
  throw new FigmaImportError(code, message, pointer);
}
export function shape<K extends ContractName>(
  name: K,
  value: unknown,
): ContractTypes[K] {
  const result = validateContract(name, value);
  if (!result.success) fail("INVALID_SCHEMA", `Invalid ${name}.`);
  return result.value;
}
export function object(
  value: JsonValue | undefined,
  pointer: string,
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_INPUT", "Expected a source object.", pointer);
  return value;
}
export function string(value: JsonValue | undefined, pointer: string): string {
  if (typeof value !== "string" || !value || value.length > 160)
    fail("INVALID_INPUT", "Expected a bounded source identifier.", pointer);
  return value;
}
export const escapePointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
export const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export interface ConversionLimits {
  maxInputBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
}
export function limits(options: ConversionLimits) {
  function cap(value: number | undefined, maximum: number) {
    const selected = value ?? maximum;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
      fail("INVALID_INPUT", "Invalid conversion budget.");
    return selected;
  }
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = options.deadline ?? started + 30_000;
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(deadline) ||
    deadline > started + 30_000
  )
    fail("INVALID_INPUT", "Invalid conversion deadline.");
  const checkpoint = () => {
    if (options.signal?.aborted)
      fail("CANCELLED", "Offline conversion cancelled.");
    const current = now();
    if (!Number.isFinite(current))
      fail("INVALID_INPUT", "Invalid conversion clock.");
    if (current >= deadline)
      fail("DEADLINE_EXCEEDED", "Offline conversion deadline expired.");
  };
  checkpoint();
  return {
    maxInputBytes: cap(options.maxInputBytes, 26_214_400),
    maxNodes: cap(options.maxNodes, 20_000),
    maxDepth: cap(options.maxDepth, 128),
    checkpoint,
  };
}
