import { Worker } from "node:worker_threads";
import type { JsonObject } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import type { ImageBudget } from "./boundary.js";

type PngInfo = {
  width: number;
  height: number;
  colorSpace: "srgb" | "unknown";
};
async function decode(
  kind: "json" | "png",
  bytes: Uint8Array,
  budget: ImageBudget,
): Promise<unknown> {
  budget.check();
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.buffer instanceof SharedArrayBuffer ||
    bytes.length > budget.context.budget.maxInputBytes
  )
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Capture decoder input exceeds its original bound.",
    );
  const owned = Uint8Array.from(bytes);
  let worker: Worker;
  try {
    worker = new Worker(new URL("../dist/decode-worker.js", import.meta.url), {
      workerData: {
        kind,
        bytes: owned,
        maxInput: Math.min(26214400, budget.context.budget.maxInputBytes),
        maxOutput: Math.min(26214400, budget.context.budget.maxOutputBytes),
        maxPixels: Math.min(
          6553600,
          budget.context.budget.maxRasterPixels,
          Math.floor(budget.context.budget.maxOutputBytes / 4),
        ),
        maxNodes: Math.min(20000, budget.context.budget.maxExpandedNodes),
        maxDepth: Math.min(128, budget.context.budget.maxDepth),
      },
      transferList: [owned.buffer],
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
  } catch {
    if (owned.byteLength) owned.fill(0);
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Capture decoder worker could not start.",
    );
  }
  let message: unknown;
  let messages = 0;
  let failed = false;
  let termination: Promise<number> | undefined;
  const abort = () => {
    termination ??= worker.terminate();
  };
  const ended = new Promise<number>((resolve) => worker.once("exit", resolve));
  worker.on("error", () => {
    failed = true;
    abort();
  });
  worker.on("message", (value: unknown) => {
    if (++messages !== 1) {
      failed = true;
      abort();
    } else message = value;
  });
  let diagnostics = 0;
  for (const stream of [worker.stdout, worker.stderr])
    stream.on("data", (chunk: Buffer) => {
      diagnostics += chunk.length;
      chunk.fill(0);
      if (diagnostics > 1024) {
        failed = true;
        abort();
      }
    });
  budget.signal.addEventListener("abort", abort, { once: true });
  if (budget.signal.aborted) abort();
  try {
    const code = await ended;
    if (termination) await termination;
    budget.check();
    if (
      failed ||
      code !== 0 ||
      messages !== 1 ||
      !message ||
      typeof message !== "object" ||
      !("ok" in message) ||
      message.ok !== true ||
      !("kind" in message) ||
      message.kind !== kind
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Bounded capture decoding was unavailable or invalid.",
      );
    return message;
  } finally {
    budget.signal.removeEventListener("abort", abort);
    if (termination) await termination;
  }
}
export async function parseCaptureJson(
  bytes: Uint8Array,
  budget: ImageBudget,
): Promise<JsonObject> {
  const result = await decode("json", bytes, budget);
  if (
    !result ||
    typeof result !== "object" ||
    !("value" in result) ||
    !result.value ||
    typeof result.value !== "object" ||
    Array.isArray(result.value)
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Capture JSON is not an object.",
    );
  return result.value as JsonObject;
}
export async function decodeReference(
  bytes: Uint8Array,
  budget: ImageBudget,
): Promise<PngInfo> {
  const result = await decode("png", bytes, budget);
  if (
    !result ||
    typeof result !== "object" ||
    !("width" in result) ||
    typeof result.width !== "number" ||
    !("height" in result) ||
    typeof result.height !== "number" ||
    !("colorSpace" in result) ||
    (result.colorSpace !== "srgb" && result.colorSpace !== "unknown")
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Capture PNG metadata is invalid.",
    );
  return {
    width: result.width,
    height: result.height,
    colorSpace: result.colorSpace,
  };
}
