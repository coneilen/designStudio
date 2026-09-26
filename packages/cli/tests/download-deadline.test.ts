import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { type CommandOperation, success } from "@design-studio/application";
import type { Artifact } from "@design-studio/contracts";
import { expect, it, vi } from "vitest";
import { deferred } from "../../host/tests/deferred.js";
import { parseArguments } from "../src/arguments.js";
import {
  type CommandConnection,
  callApi,
  dispatchCommand,
} from "../src/client.js";
import { callLocal } from "../src/local.js";

const bytes = Uint8Array.of(1, 2, 3);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const source: Artifact = {
  id: `sha256_${sha256}`,
  path: `blobs/${sha256}`,
  sha256,
  byteLength: bytes.length,
  mediaType: "application/octet-stream",
};
const output = { ...source, path: "copy.bin" };
const args = (timeout: number) =>
  parseArguments([
    "artifacts",
    "get",
    source.id,
    "--sha256",
    sha256,
    "--output-root",
    "foundation_outputs",
    "--output-relative",
    "copy.bin",
    "--timeout-ms",
    String(timeout),
    "--json",
  ]);
function connection(metadataDelay = 0, contentDelay = 0): CommandConnection {
  const metadata = success("download", {
    kind: "artifact",
    artifact: source,
    warnings: [],
  });
  return {
    async json() {
      if (metadataDelay) await delay(metadataDelay);
      return structuredClone(metadata);
    },
    async receive(_path, _method, _timeout, _body, _headers, _media, parse) {
      if (contentDelay) await delay(contentDelay);
      return parse(bytes);
    },
  };
}
it("awaits admitted publisher quiescence at the deterministic synthetic deadline", async ({
  signal,
}) => {
  const command = args(40);
  const connections = connection();
  const entered = deferred<CommandOperation>();
  const finish = deferred<void>();
  let settled = false;
  let returned = false;
  const publish = vi.fn(
    async (
      _artifact: Artifact,
      _bytes: Uint8Array,
      _relative: string,
      operation: CommandOperation,
    ) => {
      entered.resolve(operation);
      await finish.promise;
      settled = true;
      return output;
    },
  );
  const cancel = () => finish.resolve();
  signal.addEventListener("abort", cancel, { once: true });
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  const pending = dispatchCommand(command, connections, publish, signal).then(
    (value) => {
      returned = true;
      return { value };
    },
    (error: unknown) => {
      returned = true;
      return { error };
    },
  );
  try {
    const operation = await Promise.race([
      entered.promise,
      pending.then((outcome) => {
        throw "error" in outcome
          ? outcome.error
          : new Error("Publisher was not admitted.");
      }),
    ]);
    expect(operation.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(operation.signal.aborted).toBe(true);
    expect(returned).toBe(false);
    expect(settled).toBe(false);
    finish.resolve();
    const outcome = await pending;
    expect(outcome).toMatchObject({ error: { code: "DEADLINE_EXCEEDED" } });
    expect(settled).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    await pending;
    signal.removeEventListener("abort", cancel);
    vi.useRealTimers();
  }
});
it("does not start publication after a late content callback exhausts the original command budget", async () => {
  const publish = vi.fn(async () => output);
  await expect(
    dispatchCommand(args(40), connection(0, 80), publish),
  ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  expect(publish).not.toHaveBeenCalled();
});
it("uses the same absolute operation and live signal across metadata, content and remaining-budget publication", async () => {
  const observed: unknown[] = [];
  const connections: CommandConnection = {
    async json(...parameters) {
      observed.push(parameters.at(-1));
      await delay(10);
      return success("download", {
        kind: "artifact",
        artifact: source,
        warnings: [],
      });
    },
    async receive(...parameters) {
      observed.push(parameters.at(-1));
      // The public parser remains the seventh positional argument.
      await delay(10);
      return parameters[6](bytes);
    },
  };
  const publish = vi.fn(async (...parameters: unknown[]) => {
    observed.push(parameters[3]);
    return output;
  });
  await dispatchCommand(args(1000), connections, publish);
  expect(observed[0]).toBeDefined();
  expect(observed[0]).toBe(observed[1]);
  expect(observed[0]).toBe(observed[2]);
  expect(observed[0]).toMatchObject({
    deadline: expect.any(String),
    signal: expect.any(AbortSignal),
    requestId: expect.any(String),
  });
});
it("propagates explicit cancellation into an active publisher and still awaits callback settlement", async () => {
  const controller = new AbortController();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const pending = dispatchCommand(
    args(1000),
    connection(),
    async (_artifact, _bytes, _relative, operation) => {
      entered?.();
      await gate;
      expect(operation.signal.aborted).toBe(true);
      completed = true;
      return output;
    },
    controller.signal,
  );
  await started;
  controller.abort();
  await Promise.resolve();
  expect(completed).toBe(false);
  finish?.();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(completed).toBe(true);
});
it("local download metadata, bytes and publication share cancellation rather than allocating fresh request signals", async () => {
  const signals: AbortSignal[] = [];
  const response = await callLocal(
    args(1000),
    {
      async call(invocation, signal) {
        if (!signal) throw new Error("Missing original operation signal.");
        signals.push(signal);
        return invocation.operation === "getArtifact"
          ? {
              kind: "json",
              envelope: success("download", {
                kind: "artifact",
                artifact: source,
                warnings: [],
              }),
            }
          : { kind: "binary", mediaType: "application/octet-stream", bytes };
      },
    },
    async (_artifact, _bytes, _relative, operation) => {
      expect(operation.signal).toBe(signals[0]);
      expect(signals[1]).toBe(signals[0]);
      return output;
    },
  );
  expect(response.success).toBe(true);
});
it("real loopback metadata/content elapsed time is charged against publication's original remaining budget", async () => {
  const server = createServer((request, response) => {
    if (request.url?.includes("/content")) {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(bytes);
      }, 15);
    } else {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            success("download", {
              kind: "artifact",
              artifact: source,
              warnings: [],
            }),
          ),
        );
      }, 15);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener.");
  try {
    let settled = false;
    await expect(
      callApi(
        args(200),
        { port: address.port, credential: "a".repeat(43) },
        async (_artifact, _bytes, _relative, operation) => {
          expect(
            Date.parse(operation.deadline) - operation.clock.now(),
          ).toBeLessThan(200);
          await delay(220);
          settled = true;
          expect(operation.signal.aborted).toBe(true);
          return output;
        },
      ),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(settled).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
