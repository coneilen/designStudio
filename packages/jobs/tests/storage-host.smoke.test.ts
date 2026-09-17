import { createFakeClock } from "@design-studio/contracts/testing";
import {
  decodeBackup,
  encodeBackup,
  JOB_STORAGE_LIMITS,
} from "@design-studio/storage";
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

test.runIf(process.platform === "win32" && process.arch === "x64")(
  "native restored cancellation replay returns current version and unchanged completed evidence",
  async () => {
    const source = await fixture({ native: true });
    const run = async (execution: import("../src/types.js").JobExecution) => ({
      kind: "complete" as const,
      completion: {
        outputs: [value(await execution.stage(output))],
        outputState: "complete" as const,
        diagnosticIds: [],
      },
    });
    const service = makeService(source, run, {
      leaseMs: 30000,
      heartbeatMs: 10000,
    });
    value(await service.submit(source.submission(), source.context()));
    const queued = value(
      await service.getVersioned("job-work", source.context()),
    );
    value(await service.runOnce());
    const completed = value(
      await service.waitForAttempt("job-work", source.context()),
    );
    const accepted = value(
      await service.cancel(
        "job-work",
        queued.rowVersion,
        source.context("cancel-control"),
      ),
    );
    expect(accepted.job.receipt).toEqual(completed.receipt);
    const controls = value(
      await source.store.jobs.get("job-work", source.context()),
    ).cancelControls;
    const backup = decodeBackup(
      encodeBackup(
        value(await source.store.backup(source.context("backup"))),
        JOB_STORAGE_LIMITS.metadataBytes,
      ),
      JOB_STORAGE_LIMITS.metadataBytes,
    );
    const destination = await fixture({ native: true, seed: false });
    destination.trustBackup(backup.sha256);
    value(
      await destination.store.restore(backup, destination.context("restore")),
    );
    const restored = makeService(destination, run);
    const current = value(
      await restored.getVersioned("job-work", destination.context()),
    );
    expect(current.rowVersion).toBeGreaterThan(accepted.rowVersion);
    const replay = value(
      await restored.cancel(
        "job-work",
        queued.rowVersion,
        destination.context("cancel-control"),
      ),
    );
    expect(replay).toEqual(current);
    expect(replay.job.receipt).toEqual(completed.receipt);
    expect(
      value(await destination.store.jobs.get("job-work", destination.context()))
        .cancelControls,
    ).toEqual(controls);
  },
  30000,
);
