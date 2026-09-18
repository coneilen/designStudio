import { type ErrorCode, validateContract } from "@design-studio/contracts";

const stages = [
  "installation-recheck",
  "installation-current",
  "job-fault",
] as const;
export function diagnosticLine(
  stage: (typeof stages)[number],
  elapsedMs: number,
  code?: ErrorCode,
) {
  return `${JSON.stringify({
    type: "fixture-diagnostic",
    stage,
    elapsedMs: Math.min(600000, Math.max(0, Math.round(elapsedMs))),
    ...(code ? { code } : {}),
  })}\n`;
}
export function safeDiagnosticLine(line: string): string | undefined {
  if (line.length > 512) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("type" in value) ||
    value.type !== "fixture-diagnostic" ||
    !("stage" in value) ||
    (value.stage !== "installation-recheck" &&
      value.stage !== "installation-current" &&
      value.stage !== "job-fault") ||
    !("elapsedMs" in value) ||
    typeof value.elapsedMs !== "number" ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 600000 ||
    Object.keys(value).some(
      (key) => !["type", "stage", "elapsedMs", "code"].includes(key),
    )
  )
    return;
  const code =
    "code" in value ? validateContract("ErrorCode", value.code) : undefined;
  if (code && !code.success) return;
  return diagnosticLine(
    value.stage,
    value.elapsedMs,
    code?.success ? code.value : undefined,
  );
}
