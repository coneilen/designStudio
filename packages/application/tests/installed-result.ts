import { parseContract } from "@design-studio/contracts";
import { safeDiagnosticLine } from "../src/telemetry.js";
export function installedFailure(stdout: unknown, stderr: unknown): string {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 2 * 1024 * 1024)
    return "INVALID_ENVELOPE";
  try {
    const response = parseContract("ResponseEnvelope", stdout, "json");
    const job =
      response.success && response.data.kind === "job"
        ? response.data.job
        : undefined;
    const code = !response.success
      ? response.error.code
      : (job?.error?.code ?? "NONZERO_SUCCESS");
    const events =
      typeof stderr === "string" && Buffer.byteLength(stderr) <= 65536
        ? stderr
            .split("\n")
            .map(safeDiagnosticLine)
            .filter((value): value is string => value !== undefined)
            .slice(-8)
            .map((value) => value.trim())
        : [];
    return JSON.stringify({
      code,
      ...(job ? { state: job.status } : {}),
      diagnostics: events,
    });
  } catch {
    return "INVALID_ENVELOPE";
  }
}
