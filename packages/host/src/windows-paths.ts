import path from "node:path";
import { HostBoundaryError } from "./guards.js";

const extendedPrefix = "\\\\?\\";

function validateDrivePath(filename: string): void {
  if (
    typeof filename !== "string" ||
    !/^[A-Za-z]:\\/.test(filename) ||
    filename.length + extendedPrefix.length >= 32767 ||
    filename.includes("/") ||
    filename.includes(":", 2) ||
    path.win32.normalize(filename) !== filename ||
    [...filename].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new HostBoundaryError(
      "PATH_FORBIDDEN",
      "Native publication requires a canonical local absolute drive path.",
    );
  for (const component of filename.slice(3).split("\\")) {
    if (
      !component ||
      component === "." ||
      component === ".." ||
      component.length > 255 ||
      /[. ]$/.test(component) ||
      /[<>"|?*]/.test(component) ||
      /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
        component,
      )
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Native path component is unsafe or aliases a Windows device.",
      );
  }
}

/** Internal Win32 encoding only; callers must supply ordinary checked drive paths. */
export function extendedDrivePath(filename: string): string {
  validateDrivePath(filename);
  return `${extendedPrefix}${filename}`;
}

/** Accept only the local DOS-drive form returned by GetFinalPathNameByHandleW. */
export function nativeDrivePath(filename: string): string {
  if (!filename.startsWith(extendedPrefix))
    throw new HostBoundaryError(
      "PATH_FORBIDDEN",
      "Unexpected native file path namespace.",
    );
  const ordinary = filename.slice(extendedPrefix.length);
  validateDrivePath(ordinary);
  return ordinary;
}
