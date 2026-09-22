import { syntheticContext } from "@design-studio/contracts/testing";
import { boundary, HostBoundaryError } from "@design-studio/host";
import { expect, it } from "vitest";
import { failure, unwrap } from "../src/boundary.js";

it("preserves closed diagnostics through credential/host outcomes and job failures", async () => {
  const context = syntheticContext();
  const referenceDiagnostic = {
    stage: "png",
    reason: "raster-limit",
    mimeClass: "generic-binary",
  } as const;
  const error = new HostBoundaryError(
    "RASTER_LIMIT",
    "Bounded diagnostic.",
    false,
    undefined,
    referenceDiagnostic,
  );
  const outcome = await boundary(context, async () => {
    throw error;
  });
  expect(outcome).toMatchObject({
    status: "failed",
    error: { code: "RASTER_LIMIT", referenceDiagnostic },
  });
  expect(failure(context, error)).toMatchObject({
    error: { referenceDiagnostic },
  });
  try {
    unwrap(outcome);
    throw new Error("Expected terminal outcome");
  } catch (caught) {
    expect(failure(context, caught)).toMatchObject({
      status: "failed",
      error: { code: "RASTER_LIMIT", referenceDiagnostic },
    });
  }
});
