import type {
  JsonObject,
  JsonValue,
  ResourceSnapshot,
  StyledRange,
  Typography,
} from "@design-studio/contracts";
import { solid } from "./appearance.js";
import { FigmaImportError, numeric } from "./boundary.js";

export interface TextResult {
  typography: Typography;
  styledRanges: StyledRange[];
}
export function textStyle(
  raw: JsonObject,
  resources: ResourceSnapshot,
  problem: (property: string, reason: string, font?: boolean) => void,
  checkpoint: () => void,
): TextResult | undefined {
  let invalid = false;
  const reject = (property: string, reason: string, font = false) => {
    invalid = true;
    problem(property, reason, font);
  };
  const style = raw.style;
  if (
    !style ||
    typeof style !== "object" ||
    Array.isArray(style) ||
    typeof raw.characters !== "string"
  ) {
    reject("style", "Text requires captured characters and style.");
    return undefined;
  }
  const characters = raw.characters;
  function typography(
    value: JsonObject,
    pointer: string,
  ): Typography | undefined {
    checkpoint();
    if (
      typeof value.fontPostScriptName !== "string" ||
      (value.italic !== undefined && typeof value.italic !== "boolean")
    ) {
      reject(
        pointer,
        "Exact captured font identity and a valid style flag are required.",
        true,
      );
      return undefined;
    }
    const matches = resources.fonts.filter(
      (font) =>
        font.family === value.fontFamily &&
        font.weight === value.fontWeight &&
        font.style === (value.italic === true ? "italic" : "normal") &&
        (value.fontPostScriptName === undefined ||
          value.fontPostScriptName === font.postScriptName),
    );
    const font = matches[0];
    if (
      matches.length !== 1 ||
      !font ||
      (font.kind === "bundled"
        ? font.availability === "missing"
        : font.verification !== "verified") ||
      font.glyphCoverage === "missing-glyphs"
    ) {
      reject(
        pointer,
        "A unique matching pinned font declaration is required; no fallback is permitted.",
        true,
      );
      return undefined;
    }
    const fill = solid(value.fills ?? raw.fills);
    if (
      !numeric(value.fontSize) ||
      value.fontSize <= 0 ||
      !numeric(value.fontWeight) ||
      !numeric(value.lineHeightPx) ||
      value.lineHeightPx <= 0 ||
      !numeric(value.letterSpacing) ||
      !fill
    ) {
      reject(
        pointer,
        "Text requires explicit valid pixel metrics and a single solid paint.",
      );
      return undefined;
    }
    const alignment =
      value.textAlignHorizontal === "LEFT"
        ? "start"
        : value.textAlignHorizontal === "CENTER"
          ? "center"
          : value.textAlignHorizontal === "RIGHT"
            ? "end"
            : undefined;
    if (
      !alignment ||
      (value.textAlignVertical !== undefined &&
        value.textAlignVertical !== "TOP") ||
      (value.textAutoResize !== undefined &&
        !["NONE", "HEIGHT", "WIDTH_AND_HEIGHT"].includes(
          String(value.textAutoResize),
        ))
    ) {
      reject(pointer, "Unsupported text alignment or resizing semantics.");
      return undefined;
    }
    const handled = new Set([
      "fontFamily",
      "fontPostScriptName",
      "fontStyle",
      "fontWeight",
      "fontSize",
      "italic",
      "lineHeightPx",
      "lineHeightUnit",
      "lineHeightPercent",
      "lineHeightPercentFontSize",
      "letterSpacing",
      "fills",
      "textAlignHorizontal",
      "textAlignVertical",
      "textAutoResize",
    ]);
    for (const key of Object.keys(value)) {
      if (handled.has(key)) continue;
      const item = value[key];
      if (
        (["paragraphSpacing", "paragraphIndent", "listSpacing"].includes(key) &&
          item === 0) ||
        (key === "textCase" && item === "ORIGINAL") ||
        (key === "textDecoration" && item === "NONE") ||
        (key === "textTruncation" && item === "DISABLED") ||
        (key === "openTypeFlags" &&
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).length === 0)
      )
        continue;
      reject(
        `${pointer}/${key}`,
        "Unsupported or unknown text style property.",
      );
    }
    return {
      fontId: font.id,
      fontSize: value.fontSize,
      fontWeight: value.fontWeight,
      lineHeight: value.lineHeightPx,
      letterSpacing: value.letterSpacing,
      alignment,
      color: fill,
      wrap: value.textAutoResize === "WIDTH_AND_HEIGHT" ? "no-wrap" : "wrap",
    };
  }
  const base = typography(style, "style");
  const styledRanges: StyledRange[] = [];
  if (raw.characterStyleOverrides !== undefined) {
    const overrides = raw.characterStyleOverrides;
    const table = raw.styleOverrideTable;
    if (
      !Array.isArray(overrides) ||
      overrides.length !== raw.characters.length ||
      !table ||
      typeof table !== "object" ||
      Array.isArray(table)
    ) {
      reject(
        "characterStyleOverrides",
        "Styled ranges require complete UTF-16 coverage and an override table.",
      );
    } else {
      let start = 0;
      while (start < overrides.length) {
        checkpoint();
        if (styledRanges.length >= 20_000)
          throw new FigmaImportError(
            "NODE_LIMIT",
            "Styled ranges exceed the conversion profile limit.",
            "",
            {
              measured: styledRanges.length + 1,
              allowed: 20_000,
              unit: "node",
            },
          );
        const key = overrides[start];
        if (!Number.isSafeInteger(key) || typeof key !== "number" || key < 0) {
          reject("characterStyleOverrides", "Invalid style override index.");
          break;
        }
        let end = start + 1;
        while (overrides[end] === key && end < overrides.length) end++;
        const surrogateBoundary = (index: number) =>
          index > 0 &&
          index < characters.length &&
          /[\uD800-\uDBFF]/u.test(characters[index - 1] ?? "") &&
          /[\uDC00-\uDFFF]/u.test(characters[index] ?? "");
        if (surrogateBoundary(start) || surrogateBoundary(end))
          reject(
            "characterStyleOverrides",
            "Style boundary splits a surrogate pair.",
          );
        if (key !== 0) {
          const override: JsonValue | undefined = Object.hasOwn(
            table,
            String(key),
          )
            ? table[String(key)]
            : undefined;
          if (
            !override ||
            typeof override !== "object" ||
            Array.isArray(override)
          )
            reject("styleOverrideTable", "Missing style override definition.");
          else {
            const resolved = typography(
              { ...style, ...override },
              `styleOverrideTable/${key}`,
            );
            if (resolved)
              styledRanges.push({ start, end, typography: resolved });
          }
        }
        start = end;
      }
    }
  }
  return invalid || !base ? undefined : { typography: base, styledRanges };
}
