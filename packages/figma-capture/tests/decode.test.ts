import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { HostBoundaryError } from "@design-studio/host";
import { expect, it } from "vitest";
import {
  chunk,
  header,
  image,
  signature,
} from "../../assets/tests/png-fixtures.js";
import type { ImageBudget } from "../src/boundary.js";
import { decodeReference, parseCaptureJson } from "../src/decode.js";

export function decoderBudget(
  overrides: Partial<typeof DEFAULT_BUDGETS> = {},
): ImageBudget {
  const context = syntheticContext({
    budget: { ...DEFAULT_BUDGETS, ...overrides },
  });
  return {
    body: 0,
    context,
    signal: context.signal,
    policy: { imageOrigins: [] },
    check() {
      if (context.signal.aborted)
        throw new HostBoundaryError("CANCELLED", "synthetic cancellation");
    },
    dnsQuery() {},
    receive() {},
    decoded() {},
  };
}
it.each([
  ["malformed", image().subarray(0, -1), "ASSET_INVALID", "png-malformed"],
  [
    "not PNG",
    Buffer.from("<html>synthetic</html>"),
    "UNSUPPORTED_FEATURE",
    "not-png",
  ],
  [
    "interlace",
    Buffer.concat([signature, header(6, 8, 1, 1, 1), chunk("IEND")]),
    "UNSUPPORTED_FEATURE",
    "png-interlace",
  ],
  [
    "animation",
    image(6, 8, undefined, [chunk("acTL", Buffer.alloc(8))]),
    "UNSUPPORTED_FEATURE",
    "png-animation",
  ],
] as const)(
  "propagates isolated %s as safe reason",
  async (_name, bytes, code, reason) => {
    await expect(decodeReference(bytes, decoderBudget())).rejects.toMatchObject(
      {
        code,
        referenceDiagnostic: {
          stage: "png",
          reason,
          mimeClass: "not-observed",
        },
      },
    );
  },
);
it("propagates output, raster, input and node limits without generic invalid-input", async () => {
  await expect(
    decodeReference(image(), decoderBudget({ maxOutputBytes: 3 })),
  ).rejects.toMatchObject({
    code: "OUTPUT_LIMIT",
    referenceDiagnostic: { reason: "output-limit" },
  });
  await expect(
    decodeReference(
      Buffer.concat([signature, header(6, 8, 2), chunk("IEND")]),
      decoderBudget({ maxRasterPixels: 1 }),
    ),
  ).rejects.toMatchObject({
    code: "RASTER_LIMIT",
    referenceDiagnostic: { reason: "raster-limit" },
  });
  await expect(
    decodeReference(image(), decoderBudget({ maxInputBytes: 1 })),
  ).rejects.toMatchObject({
    code: "INPUT_LIMIT",
    referenceDiagnostic: { reason: "input-limit" },
  });
  await expect(
    decodeReference(image(), decoderBudget({ maxExpandedNodes: 1 })),
  ).rejects.toMatchObject({
    code: "NODE_LIMIT",
    referenceDiagnostic: { reason: "node-limit" },
  });
});
it("keeps JSON malformed and structural bounds separate", async () => {
  await expect(
    parseCaptureJson(Buffer.from("{bad"), decoderBudget()),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    referenceDiagnostic: { reason: "json-malformed" },
  });
  await expect(
    parseCaptureJson(
      Buffer.from('{"a":{"b":1}}'),
      decoderBudget({ maxDepth: 1 }),
    ),
  ).rejects.toMatchObject({
    code: "DEPTH_LIMIT",
    referenceDiagnostic: { reason: "depth-limit" },
  });
});
it("does not return text metadata and preserves original encoded bytes", async () => {
  const bytes = image(6, 8, undefined, [
    chunk("tEXt", Buffer.from("Synthetic\0private fixture text")),
  ]);
  const original = Buffer.from(bytes);
  expect(await decodeReference(bytes, decoderBudget())).toEqual({
    width: 1,
    height: 1,
    colorSpace: "unknown",
  });
  expect(bytes).toEqual(original);
});
it("reports cancellation before worker start and while running", async () => {
  for (const immediate of [true, false]) {
    const controller = new AbortController();
    const budget = decoderBudget();
    const controlled = {
      ...budget,
      signal: controller.signal,
      check() {
        if (controller.signal.aborted)
          throw new HostBoundaryError("CANCELLED", "synthetic");
      },
    };
    if (immediate) controller.abort();
    const result = decodeReference(image(), controlled);
    if (!immediate) controller.abort();
    await expect(result).rejects.toMatchObject({
      code: "CANCELLED",
      referenceDiagnostic: { reason: "cancelled" },
    });
  }
});
