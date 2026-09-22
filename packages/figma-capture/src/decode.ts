import { Worker } from "node:worker_threads";
import type { JsonObject } from "@design-studio/contracts";
import type { ImageBudget } from "./boundary.js";
import {
  decoderReasons,
  diagnosticError,
  operationDiagnostic,
} from "./diagnostic.js";

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
  try {
    budget.check();
  } catch (error) {
    throw operationDiagnostic(error);
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.buffer instanceof SharedArrayBuffer ||
    bytes.length > Math.min(26214400, budget.context.budget.maxInputBytes)
  )
    throw diagnosticError("INPUT_LIMIT", kind, "input-limit");
  const owned = Uint8Array.from(bytes);
  let worker: Worker;
  try {
    worker = new Worker(new URL("../dist/decode-worker.js", import.meta.url), {
      workerData: {
        kind,
        bytes: owned,
        maxInput: Math.min(26214400, budget.context.budget.maxInputBytes),
        maxOutput: Math.min(26214400, budget.context.budget.maxOutputBytes),
        maxPixels: Math.min(6553600, budget.context.budget.maxRasterPixels),
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
    throw diagnosticError(
      "PROVIDER_UNAVAILABLE",
      "worker",
      "worker-unavailable",
    );
  }
  let message: unknown;
  let messages = 0;
  let failed = false;
  let protocolFailure = false;
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
      protocolFailure = true;
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
        protocolFailure = true;
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
      !("kind" in message) ||
      message.kind !== kind
    )
      throw diagnosticError(
        "PROVIDER_UNAVAILABLE",
        "worker",
        !protocolFailure && (failed || code !== 0)
          ? "worker-unavailable"
          : "worker-protocol",
      );
    if (
      message.ok === false &&
      Object.keys(message).length === 3 &&
      "reason" in message &&
      typeof message.reason === "string" &&
      Object.hasOwn(decoderReasons, message.reason)
    ) {
      const reason = message.reason as keyof typeof decoderReasons;
      const allowed =
        kind === "json"
          ? ["json-malformed", "node-limit", "depth-limit", "worker-protocol"]
          : Object.keys(decoderReasons).filter(
              (entry) => entry !== "json-malformed" && entry !== "depth-limit",
            );
      if (allowed.includes(reason))
        throw diagnosticError(
          decoderReasons[reason],
          reason.startsWith("worker-") ? "worker" : kind,
          reason,
        );
    }
    if (
      message.ok !== true ||
      Object.keys(message).sort().join(",") !==
        (kind === "png" ? "colorSpace,height,kind,ok,width" : "kind,ok,value")
    )
      throw diagnosticError(
        "PROVIDER_UNAVAILABLE",
        "worker",
        "worker-protocol",
      );
    return message;
  } catch (error) {
    throw operationDiagnostic(error);
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
    throw diagnosticError("PROVIDER_UNAVAILABLE", "worker", "worker-protocol");
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
    !Number.isSafeInteger(result.width) ||
    result.width <= 0 ||
    !("height" in result) ||
    typeof result.height !== "number" ||
    !Number.isSafeInteger(result.height) ||
    result.height <= 0 ||
    !Number.isSafeInteger(result.width * result.height) ||
    result.width * result.height >
      Math.min(6553600, budget.context.budget.maxRasterPixels) ||
    result.width * result.height * 4 >
      Math.min(26214400, budget.context.budget.maxOutputBytes) ||
    !("colorSpace" in result) ||
    (result.colorSpace !== "srgb" && result.colorSpace !== "unknown")
  )
    throw diagnosticError("PROVIDER_UNAVAILABLE", "worker", "worker-protocol");
  return {
    width: result.width,
    height: result.height,
    colorSpace: result.colorSpace,
  };
}
