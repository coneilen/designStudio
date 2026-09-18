import type {
  Appearance,
  Color,
  JsonObject,
  JsonValue,
} from "@design-studio/contracts";
import { numeric } from "./boundary.js";

export function solid(value: JsonValue | undefined): Color | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const paint = value[0];
  if (
    !paint ||
    typeof paint !== "object" ||
    Array.isArray(paint) ||
    paint.type !== "SOLID" ||
    paint.visible === false ||
    Object.keys(paint).some(
      (key) =>
        !["type", "visible", "opacity", "color", "blendMode"].includes(key),
    ) ||
    (paint.blendMode !== undefined && paint.blendMode !== "NORMAL")
  )
    return undefined;
  const color = paint.color;
  if (!color || typeof color !== "object" || Array.isArray(color))
    return undefined;
  if (
    Object.keys(color).some((key) => !["r", "g", "b", "a"].includes(key)) ||
    (paint.visible !== undefined && typeof paint.visible !== "boolean")
  )
    return undefined;
  const { r, g, b, a } = color;
  const opacity = paint.opacity ?? 1;
  if (
    ![r, g, b, a, opacity].every(
      (channel) => numeric(channel) && channel >= 0 && channel <= 1,
    )
  )
    return undefined;
  if (
    !numeric(r) ||
    !numeric(g) ||
    !numeric(b) ||
    !numeric(a) ||
    !numeric(opacity)
  )
    return undefined;
  return { space: "srgb", r, g, b, a: a * opacity };
}

export function appearance(
  raw: JsonObject,
  unsupported: (property: string, reason: string) => void,
): Appearance {
  const result: Appearance = {};
  if (raw.fills !== undefined) {
    const fill = solid(raw.fills);
    if (fill) result.fill = fill;
    else if (!Array.isArray(raw.fills) || raw.fills.length)
      unsupported(
        "fills",
        "Only one visible solid sRGB paint is converted; image/gradient/multiple paints need additional evidence or support.",
      );
  }
  if (raw.opacity !== undefined) {
    if (numeric(raw.opacity) && raw.opacity >= 0 && raw.opacity <= 1)
      result.opacity = raw.opacity;
    else unsupported("opacity", "Invalid source opacity.");
  }
  if (raw.cornerRadius !== undefined) {
    if (numeric(raw.cornerRadius) && raw.cornerRadius >= 0)
      result.radius = raw.cornerRadius;
    else unsupported("cornerRadius", "Invalid corner radius.");
  }
  if (raw.rectangleCornerRadii !== undefined) {
    const radii = raw.rectangleCornerRadii;
    if (
      Array.isArray(radii) &&
      radii.length === 4 &&
      radii.every(
        (radius) => numeric(radius) && radius >= 0 && radius === radii[0],
      ) &&
      numeric(radii[0])
    )
      result.radius = radii[0];
    else
      unsupported(
        "rectangleCornerRadii",
        "Unequal corner radii are outside the conversion profile.",
      );
  }
  if (raw.clipsContent !== undefined) {
    if (typeof raw.clipsContent !== "boolean")
      unsupported("clipsContent", "Invalid clipping flag.");
    else
      result.clip = raw.clipsContent
        ? {
            kind: result.radius ? "rounded-bounds" : "bounds",
            ...(result.radius ? { radius: result.radius } : {}),
          }
        : { kind: "none" };
  }
  const strokes = Array.isArray(raw.strokes)
    ? raw.strokes.filter(
        (paint) =>
          !paint ||
          typeof paint !== "object" ||
          Array.isArray(paint) ||
          paint.visible !== false,
      )
    : raw.strokes;
  if (strokes !== undefined && (!Array.isArray(strokes) || strokes.length)) {
    const color = solid(strokes);
    if (raw.type === "TEXT")
      unsupported(
        "strokes",
        "Text glyph outlines are unsupported; they cannot be represented by a box border.",
      );
    else if (
      color &&
      numeric(raw.strokeWeight) &&
      raw.strokeWeight >= 0 &&
      raw.strokeAlign === "INSIDE"
    )
      result.border = { width: raw.strokeWeight, color };
    else
      unsupported(
        "strokes",
        "Only a uniform inside solid stroke is converted.",
      );
  }
  return result;
}
