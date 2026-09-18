import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { waitForReportedExit } from "./phase-exit.mjs";

it.runIf(process.platform === "win32" && process.arch === "x64")(
  "observes only a newly owned process exit with birth-time validation",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(performance.timeOrigin));setTimeout(()=>{},100);",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const origin = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (bytes) => resolve(Number(bytes.toString())));
      child.once("error", reject);
    });
    const exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    if (!child.pid) throw new Error("Owned child not started.");
    await waitForReportedExit(child.pid, origin);
    await exited;
    await expect(
      waitForReportedExit(process.pid, performance.timeOrigin),
    ).rejects.toThrow();
  },
);
