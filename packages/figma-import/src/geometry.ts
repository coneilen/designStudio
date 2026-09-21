import type { JsonValue } from "@design-studio/contracts";
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
