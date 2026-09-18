import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { phaseReport } from "./phase-report.js";

export interface DiagnosticOutcome {
  version: 1;
  testOnly: true;
  functionalPassed: boolean;
  captureComplete: boolean;
  measurement: unknown;
  reports: unknown[];
}
export async function persistDiagnostic(
  filename: string,
  outcome: DiagnosticOutcome,
): Promise<void> {
  if (
    !path.isAbsolute(filename) ||
    outcome.version !== 1 ||
    outcome.testOnly !== true ||
    typeof outcome.functionalPassed !== "boolean" ||
    typeof outcome.captureComplete !== "boolean" ||
    outcome.reports.length > 32
  )
    throw new Error("Invalid test diagnostic artifact.");
  const parent = path.dirname(filename);
  const before = await lstat(parent, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (await realpath(parent)) !== parent
  )
    throw new Error(
      "Test diagnostic parent is not an existing real directory.",
    );
  const measurement = outcome.measurement;
  if (measurement !== undefined) {
    if (
      !measurement ||
      typeof measurement !== "object" ||
      Array.isArray(measurement) ||
      Object.keys(measurement).sort().join(",") !==
        "batchMs,bytes,concurrent,files,recheckMs,serial,startupMs"
    )
      throw new Error("Invalid measurement fields.");
    for (const [key, value] of Object.entries(measurement)) {
      if (key === "serial" || key === "concurrent") {
        if (
          !Array.isArray(value) ||
          value.length > 9 ||
          value.some(
            (item) =>
              typeof item !== "number" || !Number.isFinite(item) || item < 0,
          )
        )
          throw new Error("Invalid bounded timing array.");
      } else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new Error("Invalid measurement value.");
    }
  }
  const reports = outcome.reports.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("pid" in value) ||
      !("instance" in value)
    )
      throw new Error("Invalid numeric report identity.");
    return phaseReport(
      Buffer.from(JSON.stringify(value)),
      `${value.pid}-${value.instance}.json`,
    );
  });
  const bytes = Buffer.from(JSON.stringify({ ...outcome, reports }));
  if (bytes.length > 1024 * 1024)
    throw new Error("Diagnostic artifact bound exceeded.");
  const current = await lstat(parent, { bigint: true });
  if (current.dev !== before.dev || current.ino !== before.ino)
    throw new Error("Diagnostic parent changed.");
  await writeFile(filename, bytes, { flag: "wx" });
}
