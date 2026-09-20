import { parentPort, workerData } from "node:worker_threads";
import { decodeRaster } from "@design-studio/assets";
import { DEFAULT_BUDGETS, parseContract } from "@design-studio/contracts";

if (parentPort) {
  const port = parentPort;
  let bytes: Uint8Array | undefined;
  try {
    const input: unknown = workerData;
    if (
      !input ||
      typeof input !== "object" ||
      !("bytes" in input) ||
      !(input.bytes instanceof Uint8Array) ||
      !("kind" in input) ||
      !["json", "png"].includes(String(input.kind)) ||
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
    if (
      bytes.length > input.maxInput ||
      input.maxInput > 26214400 ||
      input.maxOutput > 26214400 ||
      input.maxPixels > 6553600 ||
      input.maxNodes > 20000 ||
      input.maxDepth > 128
    )
      throw new Error("worker-limit");
    if (input.kind === "json") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = parseContract("JsonObject", text, "json", {
        maxInputBytes: input.maxInput,
      });
      const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
      let entries = 0;
      while (stack.length) {
        const item = stack.pop();
        if (
          !item ||
          item.depth > input.maxDepth ||
          ++entries > Math.min(640000, input.maxNodes * 32)
        )
          throw new Error("worker-structure");
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
  } catch {
    port.postMessage({ ok: false });
  } finally {
    bytes?.fill(0);
    port.close();
  }
}
