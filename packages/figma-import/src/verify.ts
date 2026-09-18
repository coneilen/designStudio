import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { type ConversionLimits, fail } from "./boundary.js";
import {
  convertFigmaSnapshot,
  type FigmaConversion,
  type FigmaConversionInput,
} from "./converter.js";

/**
 * Replays the pinned adapter from separately held inputs, not from output projections.
 * This proves conversion reproducibility only, never source authorship or resource rights.
 */
export function verifyFigmaConversion(
  input: FigmaConversionInput,
  candidate: FigmaConversion,
  options: ConversionLimits = {},
): void {
  const expected = convertFigmaSnapshot(input, options);
  if (
    !(candidate.originalBytes instanceof Uint8Array) ||
    candidate.originalBytes.buffer instanceof SharedArrayBuffer ||
    hashBytes(candidate.originalBytes) !== hashBytes(expected.originalBytes)
  )
    fail(
      "ARTIFACT_INTEGRITY",
      "Conversion original bytes differ from the separately supplied input.",
    );
  const { originalBytes: _original, ...actualArtifacts } = candidate;
  const { originalBytes: _expected, ...expectedArtifacts } = expected;
  if (canonicalDigest(actualArtifacts) !== canonicalDigest(expectedArtifacts))
    fail(
      "ARTIFACT_INTEGRITY",
      "Conversion artifacts differ from deterministic source replay.",
    );
}
