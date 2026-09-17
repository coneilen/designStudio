import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("closes the inherited control pipe and actually exits when installed project acquisition fails", async () => {
  const entry = pathToFileURL(
    path.resolve("packages\\cli\\dist\\service.js"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {serve} from ${JSON.stringify(entry)};try{await serve(0,"3");}catch(error){process.stdout.write(JSON.stringify({code:error.code})+"\\n");process.exitCode=5;}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      shell: false,
      env: { SystemRoot: process.env.SystemRoot },
    },
  );
  let closed = false;
  let stderr = "";
  child.stderr?.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  try {
    const failure = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned startup failure was not reported.")),
        10000,
      );
      child.stdout?.once("data", (bytes) => {
        clearTimeout(timer);
        resolve(bytes.toString());
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(JSON.parse(failure).code).toBe("ACTION_REQUIRED");
    const observation = await Promise.race([
      exited,
      new Promise<"still-running">((resolve) =>
        setTimeout(() => resolve("still-running"), 1000),
      ),
    ]);
    expect(
      observation,
      "A caught project-open failure must not keep fd3 referenced.",
    ).toBe(5);
    expect(stderr).not.toContain("Bearer");
  } finally {
    if (!closed) child.kill();
    await exited;
    child.stdio[3]?.destroy();
  }
}, 15000);
