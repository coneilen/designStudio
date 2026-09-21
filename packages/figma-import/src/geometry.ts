import type { Bounds, JsonValue } from "@design-studio/contracts";
import { numeric } from "./boundary.js";

export function translationOnly(value: JsonValue | undefined): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [x, y] = value;
  return (
    Array.isArray(x) &&
    Array.isArray(y) &&
    x.length === 3 &&
    y.length === 3 &&
    x[0] === 1 &&
    x[1] === 0 &&
    y[0] === 0 &&
    y[1] === 1 &&
    numeric(x[2]) &&
    numeric(y[2])
  );
}

export function equalRenderBounds(
  value: JsonValue | undefined,
  bounds: Bounds | undefined,
): boolean {
  return !!(
    bounds &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    value.x === bounds.x &&
    value.y === bounds.y &&
    value.width === bounds.width &&
    value.height === bounds.height
  );
}

export function equalSize(
  value: JsonValue | undefined,
  bounds: Bounds | undefined,
): boolean {
  return !!(
    bounds &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    value.x === bounds.width &&
    value.y === bounds.height
  );
}

export function leftTopConstraints(value: JsonValue | undefined): boolean {
  return !!(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    value.horizontal === "LEFT" &&
    value.vertical === "TOP"
  );
}

export function neutralFixedProperty(
  key: string,
  value: JsonValue | undefined,
): boolean {
  switch (key) {
    case "fillGeometry":
    case "strokeGeometry":
      // Empty arrays supply no additional paths; nonempty geometry is never inferred from a box.
      return Array.isArray(value) && value.length === 0;
    case "scrollBehavior":
      // Normal captured placement has no fixed/sticky override.
      return value === "SCROLLS";
    case "layoutAlign":
      // No child alignment override; captured auto-layout itself retains its separate loss.
      return value === "INHERIT";
    case "layoutGrow":
      return value === 0;
    case "layoutWrap":
      return value === "NO_WRAP";
    case "constraints":
      // Absolute offsets preserve these anchors, not center/scale/opposite-edge constraints.
      return leftTopConstraints(value);
    default:
      return false;
  }
}
