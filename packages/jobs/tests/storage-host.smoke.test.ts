import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, test } from "vitest";
import { fixture, makeService, output, value } from "./support.js";

test.runIf(process.platform === "win32" && process.arch === "x64")(
  "job service commits via real native publication and replays the durable receipt after restart",
  async () => {
    const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
    const f = await fixture({ native: true, clock });
    let calls = 0;
    const run = async (execution: import("../src/types.js").JobExecution) => {
      calls++;
      const staged = value(await execution.stage(output));
      return {
        kind: "complete" as const,
        completion: {
          outputs: [staged],
          outputState: "complete" as const,
          diagnosticIds: [],
          comparisonVerdict: "inconclusive" as const,
        },
      };
    };
    let s = makeService(f, run, { leaseMs: 30000, heartbeatMs: 10000 });
    value(await s.submit(f.submission(), f.context()));
    value(await s.runOnce());
    const committed = value(await s.waitForAttempt("job-work", f.context()));
    expect(committed.status).toBe("completed");
    expect(committed.comparisonVerdict).toBe("inconclusive");
    expect(committed.receipt?.outputs[0]?.byteLength).toBe(output.length);
    await f.reopen();
    s = makeService(f, run);
    value(await s.runOnce());
    expect(value(await s.get("job-work", f.context())).receipt).toEqual(
      committed.receipt,
    );
    expect(calls).toBe(1);
  },
  30000,
);
