import type { ErrorCode, ReferenceDiagnostic } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";

type Reason = ReferenceDiagnostic["reason"];
export const decoderReasons = {
  "not-png": "UNSUPPORTED_FEATURE",
  "png-malformed": "ASSET_INVALID",
  "png-unsupported": "UNSUPPORTED_FEATURE",
  "png-interlace": "UNSUPPORTED_FEATURE",
  "png-animation": "UNSUPPORTED_FEATURE",
  "png-critical": "UNSUPPORTED_FEATURE",
  "png-color-unsupported": "UNSUPPORTED_FEATURE",
  "png-color-conflict": "ASSET_INVALID",
  "input-limit": "INPUT_LIMIT",
  "output-limit": "OUTPUT_LIMIT",
  "raster-limit": "RASTER_LIMIT",
  "node-limit": "NODE_LIMIT",
  "depth-limit": "DEPTH_LIMIT",
  "intermediate-limit": "OUTPUT_LIMIT",
  "json-malformed": "INVALID_INPUT",
  "worker-protocol": "PROVIDER_UNAVAILABLE",
  "worker-unavailable": "PROVIDER_UNAVAILABLE",
} as const satisfies Partial<Record<Reason, ErrorCode>>;
export type DecoderReason = keyof typeof decoderReasons;
export const assetReasons: Readonly<Record<string, DecoderReason>> = {
  RASTER_UNSUPPORTED: "not-png",
  PNG_MALFORMED: "png-malformed",
  PNG_UNSUPPORTED: "png-unsupported",
  PNG_INTERLACE_UNSUPPORTED: "png-interlace",
  PNG_ANIMATION_UNSUPPORTED: "png-animation",
  PNG_CRITICAL_UNSUPPORTED: "png-critical",
  PNG_COLOR_UNSUPPORTED: "png-color-unsupported",
  PNG_COLOR_CONFLICT: "png-color-conflict",
  INPUT_BYTES: "input-limit",
  OUTPUT_BYTES: "output-limit",
  RASTER_PIXELS: "raster-limit",
  PNG_CHUNKS: "node-limit",
  PNG_INTERMEDIATE_BYTES: "intermediate-limit",
  DECODER_CONTRACT: "worker-protocol",
};
export function diagnosticError(
  code: ErrorCode,
  stage: ReferenceDiagnostic["stage"],
  reason: Reason,
  mimeClass: ReferenceDiagnostic["mimeClass"] = "not-observed",
): HostBoundaryError {
  return new HostBoundaryError(
    code,
    "Bounded reference processing failed; only nonsecret classification is available.",
    false,
    undefined,
    { stage, reason, mimeClass },
  );
}
export function operationDiagnostic(
  error: unknown,
  mimeClass?: ReferenceDiagnostic["mimeClass"],
): unknown {
  if (!(error instanceof HostBoundaryError)) return error;
  if (error.referenceDiagnostic)
    return diagnosticError(
      error.code,
      error.referenceDiagnostic.stage,
      error.referenceDiagnostic.reason,
      mimeClass ?? error.referenceDiagnostic.mimeClass,
    );
  const reason: Partial<Record<ErrorCode, Reason>> = {
    CANCELLED: "cancelled",
    DEADLINE_EXCEEDED: "deadline",
    AUTH_REQUIRED: "authority",
    FORBIDDEN: "authority",
    INPUT_LIMIT: "input-limit",
    OUTPUT_LIMIT: "output-limit",
    RASTER_LIMIT: "raster-limit",
    NODE_LIMIT: "node-limit",
    DEPTH_LIMIT: "depth-limit",
  };
  const mapped = reason[error.code];
  return mapped
    ? diagnosticError(
        error.code,
        "operation",
        mapped,
        mimeClass ?? "not-observed",
      )
    : error;
}
export function mimeClass(
  mediaType: string | undefined,
): ReferenceDiagnostic["mimeClass"] {
  if (mediaType === undefined) return "missing";
  if (mediaType === "image/png") return "png";
  if (
    mediaType === "application/octet-stream" ||
    mediaType === "binary/octet-stream"
  )
    return "generic-binary";
  return "other";
}
export function requirePngMime(mediaType: string | undefined) {
  const classification = mimeClass(mediaType);
  if (classification === "missing" || classification === "other")
    throw diagnosticError(
      "UNSUPPORTED_FEATURE",
      "mime",
      classification === "missing" ? "mime-missing" : "mime-rejected",
      classification,
    );
  return classification;
}
