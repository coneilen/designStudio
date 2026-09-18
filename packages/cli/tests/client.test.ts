import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { parseContract } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { parseArguments } from "../src/arguments.js";
import { callApi } from "../src/client.js";

it("sends credentials only as headers and preserves one typed response", async () => {
  let observed = "";
  const server = createServer((request, response) => {
    observed = request.headers.authorization ?? "";
    expect(request.url).toBe("/v1/projects/project_synthetic/doctor");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        schemaVersion: "1.0",
        success: false,
        requestId: "r",
        error: {
          code: "ACTION_REQUIRED",
          message: "Fixture not configured.",
          retryable: false,
          diagnosticIds: [],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No bound owned port.");
  try {
    const response = await callApi(parseArguments(["doctor", "--json"]), {
      port: address.port,
      credential: "a".repeat(43),
    });
    expect(response.success).toBe(false);
    expect(observed).toBe(`Bearer ${"a".repeat(43)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("does not send malformed credentials or invalid ports", async () => {
  await expect(
    callApi(parseArguments(["doctor"]), { port: 0, credential: "secret" }),
  ).rejects.toThrow();
});
it("reports the original bounded timeout rather than the socket error from closing its own request", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((request) => request.resume());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned port.");
  try {
    await expect(
      callApi(parseArguments(["doctor", "--timeout-ms", "20"]), {
        port: address.port,
        credential: "d".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("returns async acceptance without polling or presenting artifacts as completed work", async () => {
  const design = parseContract(
    "DesignIR",
    await readFile(
      "tests\\fixtures\\foundation\\settings-screen.design.json",
      "utf8",
    ),
    "json",
  );
  const revision = {
    schemaVersion: "1.0",
    id: "revision_1",
    projectId: design.projectId,
    designId: design.designId,
    parents: [],
    content: { id: "content", sha256: "a".repeat(64) },
    resources: design.resources,
    createdAt: "2026-09-16T00:00:00Z",
    actorId: "owner",
    changeSource: "import",
    provenance: { id: "provenance", sha256: "b".repeat(64) },
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    request.resume();
    response.writeHead(request.method === "POST" ? 202 : 200, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify({
        schemaVersion: "1.0",
        success: true,
        requestId: "logical",
        data:
          request.method === "POST"
            ? {
                kind: "accepted-job",
                jobId: "job_1",
                status: "queued",
                warnings: [],
              }
            : { kind: "revision", revision, design, warnings: [] },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned port.");
  try {
    const result = await callApi(
      parseArguments([
        "render",
        design.designId,
        "--async",
        "--request-id",
        "logical",
        "--json",
      ]),
      { port: address.port, credential: "c".repeat(43) },
    );
    expect(result).toMatchObject({
      success: true,
      data: { kind: "accepted-job", status: "queued" },
    });
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.includes("/wait"))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
