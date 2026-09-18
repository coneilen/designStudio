import path from "node:path";

export function offlineRestorePaths(
  workspace: string,
  environment: Readonly<Record<string, string | undefined>>,
): { store: string; cache: string } {
  const selected = (key: string, fallback: string): string => {
    const value = environment[key] ?? fallback;
    if (
      !path.isAbsolute(value) ||
      value.includes("\0") ||
      (process.platform === "win32" &&
        !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value))
    )
      throw new Error(`${key} must be an explicit absolute offline test path.`);
    return value;
  };
  return {
    store: selected(
      "FIXTURE_INSTALL_TEST_STORE",
      path.join(workspace, ".tools", "pnpm-store"),
    ),
    cache: selected(
      "FIXTURE_INSTALL_TEST_CACHE",
      path.join(workspace, ".cache", "pnpm"),
    ),
  };
}

function detail(
  error: unknown,
  key: "code" | "stdout" | "stderr",
  limit: number,
): string {
  if (!error || typeof error !== "object" || !(key in error))
    return "<unavailable>";
  const value: unknown =
    key === "code" && "code" in error
      ? error.code
      : key === "stdout" && "stdout" in error
        ? error.stdout
        : key === "stderr" && "stderr" in error
          ? error.stderr
          : undefined;
  if (Buffer.isBuffer(value))
    return (
      value.subarray(0, limit).toString("utf8") +
      (value.length > limit ? " [truncated]" : "")
    );
  if (typeof value !== "string" && typeof value !== "number")
    return "<unavailable>";
  const text = String(value);
  return text.slice(0, limit) + (text.length > limit ? " [truncated]" : "");
}

export async function withOfflineRestoreDiagnostics<T>(
  restore: () => Promise<T>,
): Promise<T> {
  try {
    return await restore();
  } catch (cause) {
    throw new Error(
      `Offline candidate restore failed.\ncode: ${detail(cause, "code", 128)}\nstdout: ${detail(cause, "stdout", 65536)}\nstderr: ${detail(cause, "stderr", 65536)}`,
      { cause },
    );
  }
}
