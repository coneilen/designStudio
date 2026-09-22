import { parentPort, workerData } from "node:worker_threads";
import { AssetError, decodeRaster } from "@design-studio/assets";
import { DEFAULT_BUDGETS, parseContract } from "@design-studio/contracts";
import { assetReasons, type DecoderReason } from "./diagnostic.js";

if (parentPort) {
  const port = parentPort;
  let bytes: Uint8Array | undefined;
  let kind: "json" | "png" | undefined;
  let reason: DecoderReason = "worker-protocol";
  try {
    const input: unknown = workerData;
    if (
      !input ||
      typeof input !== "object" ||
      !("bytes" in input) ||
      !(input.bytes instanceof Uint8Array) ||
      !("kind" in input) ||
      (input.kind !== "json" && input.kind !== "png") ||
      !("maxInput" in input) ||
      typeof input.maxInput !== "number" ||
      !("maxOutput" in input) ||
      typeof input.maxOutput !== "number" ||
      !("maxPixels" in input) ||
      typeof input.maxPixels !== "number" ||
      !("maxNodes" in input) ||
      typeof input.maxNodes !== "number" ||
      !("maxDepth" in input) ||
      typeof input.maxDepth !== "number"
    )
      throw new Error("worker-input");
    bytes = input.bytes;
    kind = input.kind;
    if (
      bytes.buffer instanceof SharedArrayBuffer ||
      ![
        input.maxInput,
        input.maxOutput,
        input.maxPixels,
        input.maxNodes,
        input.maxDepth,
      ].every((n) => Number.isSafeInteger(n) && n > 0) ||
      bytes.length > input.maxInput ||
      input.maxInput > 26214400 ||
      input.maxOutput > 26214400 ||
      input.maxPixels > 6553600 ||
      input.maxNodes > 20000 ||
      input.maxDepth > 128
    )
      throw new Error("worker-limit");
    if (input.kind === "json") {
      reason = "json-malformed";
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = parseContract("JsonObject", text, "json", {
        maxInputBytes: input.maxInput,
      });
      const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
      let entries = 0;
      while (stack.length) {
        const item = stack.pop();
        if (!item) throw new Error("worker-structure");
        if (item.depth > input.maxDepth) {
          reason = "depth-limit";
          throw new Error("worker-structure");
        }
        if (++entries > Math.min(640000, input.maxNodes * 32)) {
          reason = "node-limit";
          throw new Error("worker-structure");
        }
        if (item.value && typeof item.value === "object") {
          for (const child of Object.values(item.value))
            stack.push({ value: child, depth: item.depth + 1 });
        }
      }
      port.postMessage({ ok: true, kind: "json", value });
    } else {
      const raster = decodeRaster(bytes, {
        ...DEFAULT_BUDGETS,
        maxInputBytes: input.maxInput,
        maxOutputBytes: input.maxOutput,
        maxRasterPixels: input.maxPixels,
        maxExpandedNodes: input.maxNodes,
        maxDepth: input.maxDepth,
      });
      try {
        port.postMessage({
          ok: true,
          kind: "png",
          width: raster.width,
          height: raster.height,
          colorSpace: raster.colorSpace,
        });
      } finally {
        raster.rgba.fill(0);
      }
    }
  } catch (error) {
    if (error instanceof AssetError)
      reason = assetReasons[error.diagnostic.code] ?? "worker-protocol";
    port.postMessage({ ok: false, kind, reason });
  } finally {
    bytes?.fill(0);
    port.close();
  }
}
