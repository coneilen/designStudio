import { validateContract } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { doctor } from "../src/doctor.js";

it("reports optional adapters unavailable without invoking tools or pretending rendering was observed", () => {
  const result = doctor();
  expect(validateContract("ProviderCapabilities", result).success).toBe(true);
  expect(
    result.operations.find((op) => op.operation === "render")?.availability,
  ).toBe("unverified");
  for (const name of ["figma", "device", "model", "browser-enrollment"]) {
    expect(
      result.operations.find((op) => op.operation === name)?.availability,
    ).toBe("unavailable");
  }
});
