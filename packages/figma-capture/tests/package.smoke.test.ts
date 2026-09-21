import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports the capture service without network/vault work and keeps transport/test seams private", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const api = await import("@design-studio/figma-capture");
    if (typeof api.createFigmaCaptureJobs !== "function" || api.CAPTURE_LIMITS.maxExternalCalls !== 4) throw new Error("Missing capture API");
    for (const key of ["FigmaHttpsTransport", "decodeReference", "captureSelectedFrame", "syntheticCertificate", "acquireReference", "ReferenceBudget", "referenceUrl", "parseCaptureJson"]) {
      if (key in api) throw new Error("Private capture implementation exported");
    }
    try { await import("@design-studio/figma-capture/dist/transport.js"); throw new Error("Private subpath exported"); }
    catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }
    process.stdout.write("capture-public-import-ok");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {},
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("capture-public-import-ok");
});
