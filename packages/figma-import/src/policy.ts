import { fail } from "./boundary.js";

export type FigmaConversionPolicy = "fixed-v1" | "fixed-v2";
export const CURRENT_FIGMA_CONVERSION_POLICY: FigmaConversionPolicy =
  "fixed-v2";

const policies = Object.freeze({
  "fixed-v1": Object.freeze({
    version: "0.2.0",
    offlineAdapter: "figma-offline-fixed-v1",
    structureAdapter: "figma-structure-fixed-v1",
  } as const),
  "fixed-v2": Object.freeze({
    version: "0.3.0",
    offlineAdapter: "figma-offline-fixed-v2",
    structureAdapter: "figma-structure-fixed-v2",
  } as const),
});

export function figmaConversionPolicy(
  policy: FigmaConversionPolicy = CURRENT_FIGMA_CONVERSION_POLICY,
) {
  if (policy !== "fixed-v1" && policy !== "fixed-v2")
    fail("INVALID_INPUT", "Unknown intended conversion policy.");
  return policies[policy];
}
