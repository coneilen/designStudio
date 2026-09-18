import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";
import { validateContract } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { PrivateChannel } from "../src/channel.js";

function run(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve("packages\\cli\\dist\\main.js"), ...args],
        { shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}
it.each([
  ["--help", 0],
  ["--version", 0],
  ["unimplemented", 2],
  ["serve", 5],
] as const)(
  "built CLI %s writes one versioned JSON object with exit %s",
  async (command, code) => {
    const result = await run([command, "--json"]);
    expect(result.code).toBe(code);
    expect(
      validateContract("ResponseEnvelope", JSON.parse(result.stdout)).success,
    ).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain("Bearer");
  },
);
it("does not echo a secret-like unknown argument in stdout/stderr", async () => {
  const result = await run(["doctor", "--token", "SECRET_MARKER", "--json"]);
  expect(result.code).toBe(2);
  expect(result.stdout + result.stderr).not.toContain("SECRET_MARKER");
});
it.each([
  ["doctor", "capabilities"],
  ["openapi", "api-description"],
] as const)(
  "reports local %s metadata without provisioning or opening a listener",
  async (command, kind) => {
    const result = await run([command, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.kind).toBe(kind);
    expect(
      validateContract("ResponseEnvelope", JSON.parse(result.stdout)).success,
    ).toBe(true);
  },
);
it("receives an API credential through fd3, never argv or environment", async () => {
  const credential = "b".repeat(43);
  const server = createServer((request, response) => {
    expect(request.headers.authorization?.slice(7)).toBe(credential);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        schemaVersion: "1.0",
        success: true,
        requestId: "pipe_request",
        data: {
          kind: "service",
          projectId: "project_synthetic",
          state: "stopped",
          warnings: [],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned port unavailable.");
  try {
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const argv = [
          path.resolve("packages\\cli\\dist\\main.js"),
          "doctor",
          "--mode",
          "api",
          "--session-fd",
          "3",
          "--json",
        ];
        expect(argv.join(" ")).not.toContain(credential);
        const child = spawn(process.execPath, argv, {
          shell: false,
          stdio: ["ignore", "pipe", "pipe", "overlapped"],
          env: { SystemRoot: process.env.SystemRoot },
        });
        let output = "";
        child.stdout?.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          output += chunk;
        });
        const pipe = child.stdio[3];
        if (!(pipe instanceof Duplex))
          throw new Error("Private pipe unavailable.");
        const channel = new PrivateChannel(pipe);
        void channel
          .write({ kind: "session", port: address.port, credential })
          .catch(reject);
        child.on("error", reject);
        child.on("close", (code) => {
          channel.close();
          resolve({ code, output });
        });
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).not.toContain(credential);
    expect(JSON.parse(result.output).requestId).toBe("pipe_request");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
