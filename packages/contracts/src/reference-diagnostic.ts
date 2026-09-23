import { validateContract } from "./boundary.js";
import type { ReferenceDiagnostic } from "./generated.js";

/** Copy only the closed diagnostic contract, never an exception or worker payload. */
export function referenceDiagnosticFields(value: unknown): {
  referenceDiagnostic?: ReferenceDiagnostic;
} {
  if (!value || typeof value !== "object" || !("referenceDiagnostic" in value))
    return {};
  const checked = validateContract(
    "ReferenceDiagnostic",
    value.referenceDiagnostic,
  );
  return checked.success
    ? { referenceDiagnostic: structuredClone(checked.value) }
    : {};
}
