import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { phaseReport } from "./phase-report.js";

it("retains both bootstrap and payload numeric collectors after actual child exit", async () => {
  // This small collector fixture resolves the existing project-host Koffi dependency.
  const root = await mkdtemp(
    path.resolve("packages", "project-host", ".phase-collector-"),
  );
  const identity = await lstat(root, { bigint: true });
  const errors: unknown[] = [];
  try {
    const diagnostics = path.join(root, "diagnostics");
    await mkdir(diagnostics);
    for (const area of ["bootstrap", "payload"]) {
      const target = path.join(root, area);
      await mkdir(target);
      await copyFile(
        path.resolve(
          "packages",
          "project-host",
          "dist",
          "installation-diagnostics.js",
        ),
        path.join(target, "installation-diagnostics.js"),
      );
      await copyFile(
        new URL("./phase-native.mjs", import.meta.url),
        path.join(target, "f08-native-timing.mjs"),
      );
      await writeFile(
        path.join(target, "capture.mjs"),
        (
          await readFile(
            new URL("./phase-capture.mjs", import.meta.url),
            "utf8",
          )
        ).replace(
          '"__F08_DIAGNOSTIC_DIRECTORY__"',
          JSON.stringify(diagnostics),
        ),
        { flag: "wx" },
      );
      await writeFile(
        path.join(target, "exercise.mjs"),
        `import "./capture.mjs";
import { traceInstallation } from "./installation-diagnostics.js";
import { nativeCapture } from "./f08-native-timing.mjs";
const trace = traceInstallation(true);
if (!trace) throw new Error("Missing capture");
nativeCapture.measure("pin", () => 1);
trace.phase("file-pins", trace.time(), 1);
trace.end(true);
`,
        { flag: "wx" },
      );
    }
    const entry = path.join(root, "entry.mjs");
    await writeFile(
      entry,
      'await import("./bootstrap/exercise.mjs"); await import("./payload/exercise.mjs");',
      { flag: "wx" },
    );
    await promisify(execFile)(process.execPath, [entry], {
      timeout: 10000,
      maxBuffer: 16384,
    });
    const files = (await readdir(diagnostics)).filter(
      (name) => !name.endsWith(".start.json"),
    );
    expect(files).toHaveLength(2);
    const reports = await Promise.all(
      files.map(async (file) =>
        phaseReport(await readFile(path.join(diagnostics, file)), file),
      ),
    );
    expect(reports.map((report) => report.instance).sort()).toEqual([1, 2]);
    for (const report of reports) {
      expect(report).toMatchObject({
        version: 2,
        incomplete: 0,
        samples: 3,
        native: {
          samplingErrors: 0,
          groups: [{ kind: "pin", calls: 1 }],
        },
      });
      expect(report.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "file-pins",
            rssBytesMax: expect.any(Number),
            cpuUserUs: expect.any(Number),
            cpuSystemUs: expect.any(Number),
          }),
        ]),
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const current = await lstat(root, { bigint: true });
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new Error("Owned collector fixture identity changed.");
    await rm(root, { recursive: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Collector exercise or cleanup failed.", {
      cause: errors[0],
    });
});
