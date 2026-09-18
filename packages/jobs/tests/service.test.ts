import { createFakeClock } from "@design-studio/contracts/testing";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import { createJobService } from "../src/index.js";
import type {
  HandlerResult,
  JobExecution,
  TrustedJobHandler,
} from "../src/types.js";
import { deferred, fixture, output, value } from "./support.js";

const handler = (run: TrustedJobHandler["run"]): TrustedJobHandler => ({
  id: "synthetic",
  version: "v1",
  operation: "render",
  run,
});
async function finish(execution: JobExecution): Promise<HandlerResult> {
  const staged = value(await execution.stage(output));
  return {
    kind: "complete",
    completion: {
      outputs: [staged],
      outputState: "complete",
      diagnosticIds: [],
      comparisonVerdict: "fail",
    },
  };
}
function service(
  f: Awaited<ReturnType<typeof fixture>>,
  run = finish,
  maxWorkers = 1,
) {
  return createJobService({
    projectId: "project",
    repository: f.store.jobs,
    clock: f.clock,
    artifactRootId: f.artifactRootId,
    ownerId: "worker",
    handlers: [handler(run)],
    executionAuthority: f.executionAuthority,
    recoveryAuthority: f.recoveryAuthority,
    maxWorkers,
    leaseMs: 1000,
    heartbeatMs: 300,
    pollMs: 50,
  });
}
test("requires trusted authority ports and stays inert until explicitly driven", async () => {
  const f = await fixture();
  let calls = 0;
  const s = service(f, async (ex) => {
    calls++;
    return finish(ex);
  });
  const queued = value(await s.submit(f.submission(), f.context()));
  expect(queued.status).toBe("queued");
  expect(calls).toBe(0);
  expect(value(await s.getVersioned(queued.id, f.context()))).toEqual({
    job: queued,
    rowVersion: 1,
  });
  value(await s.runOnce());
  const completed = value(await s.wait(queued.id, f.context()));
  expect(completed.status).toBe("completed");
  expect(completed.comparisonVerdict).toBe("fail");
  expect(calls).toBe(1);
  value(await s.runOnce());
  expect(calls).toBe(1);
  expect(
    Object.keys(value(await s.getVersioned(queued.id, f.context()))).sort(),
  ).toEqual(["job", "rowVersion"]);
});
test("submission snapshots identity/budget, rejects changed payload and denies forged proof", async () => {
  const f = await fixture();
  const s = service(f);
  const input = f.submission();
  const ctx = f.context();
  const pending = s.submit(input, ctx);
  input.handlerId = "mutated";
  ctx.requestId = "mutated";
  ctx.budget.maxAttempts = 1;
  const queued = value(await pending);
  expect(queued.idempotency.key).toBe("work");
  expect(queued.budget.maxAttempts).toBe(3);
  expect(value(await s.submit(f.submission(), f.context())).id).toBe(queued.id);
  const conflict = f.submission();
  conflict.resourceKeys = ["changed"];
  expect(await s.submit(conflict, f.context())).toMatchObject({
    status: "failed",
    error: { code: "CONFLICT" },
  });
  const forged = f.context();
  forged.authorization = structuredClone(forged.authorization);
  expect(await s.get(queued.id, forged)).toMatchObject({
    status: "failed",
    error: { code: "AUTH_REQUIRED" },
  });
});
test("conditional cancel is durable, cooperative, and cannot use a stale version", async () => {
  const f = await fixture();
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  const s = service(f, async (ex) => {
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  const ex = await started.promise;
  const running = value(await s.getVersioned("job-work", f.context()));
  expect(
    await s.cancel("job-work", running.rowVersion - 1, f.context("cancel")),
  ).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
  value(await s.cancel("job-work", running.rowVersion, f.context("cancel")));
  expect(ex.context.signal.aborted).toBe(true);
  release.resolve({ kind: "fail", error: detail("CANCELLED") });
  expect(value(await s.wait("job-work", f.context())).status).toBe("cancelled");
});
test("expired noncooperative handler retains global slot even for different resource", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  const started = deferred<JobExecution>();
  const release = deferred<HandlerResult>();
  let calls = 0;
  const s = service(f, async (ex) => {
    calls++;
    started.resolve(ex);
    return release.promise;
  });
  value(await s.submit(f.submission("work", ["one"]), f.context()));
  clock.advance(1);
  value(await s.submit(f.submission("other", ["two"]), f.context("other")));
  value(await s.runOnce());
  const ex = await started.promise;
  clock.advance(1000);
  value(await s.runOnce());
  expect(ex.context.signal.aborted).toBe(true);
  expect(value(await s.get("job-work", f.context())).status).toBe(
    "interrupted",
  );
  expect(value(await s.get("job-other", f.context("other"))).status).toBe(
    "queued",
  );
  expect(calls).toBe(1);
  release.resolve({ kind: "fail", error: detail("INTERRUPTED") });
  await s.waitForAttempt("job-work", f.context());
});
test("retry deadlines, attempts and cumulative stage usage persist across reopen", async () => {
  const clock = createFakeClock(Date.parse("2026-09-17T00:00:00Z"));
  const f = await fixture({ clock });
  let calls = 0;
  const run: TrustedJobHandler["run"] = async (ex) => {
    calls++;
    if (calls === 1) {
      value(await ex.stage(output));
      return {
        kind: "retry",
        error: detail("PROVIDER_UNAVAILABLE", true),
        retryAfter: new Date(clock.now() + 5000).toISOString(),
      };
    }
    return finish(ex);
  };
  let s = service(f, run);
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  await s.waitForAttempt("job-work", f.context());
  expect(value(await s.get("job-work", f.context())).status).toBe("retry-wait");
  await f.reopen();
  s = service(f, run);
  clock.advance(4999);
  value(await s.runOnce());
  expect(calls).toBe(1);
  clock.advance(1);
  value(await s.runOnce());
  expect(value(await s.wait("job-work", f.context())).status).toBe("completed");
  expect(
    value(await f.store.jobs.get("job-work", f.context())).usage.outputBytes,
  ).toBe(output.length * 2);
});
test("staged renderer adapter journals each stage and offers no publish/discard", async () => {
  const f = await fixture();
  const s = service(f, async (ex) => {
    expect(Object.keys(ex.filesystem)).toEqual(["stage"]);
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(output)
      .digest("hex");
    expect(
      await ex.filesystem.stage(
        { artifactRootId: "wrong", path: `blobs/${hash}` },
        output,
        ex.context,
      ),
    ).toMatchObject({ status: "failed" });
    const a = value(
      await ex.filesystem.stage(
        { artifactRootId: f.artifactRootId, path: `blobs/${hash}` },
        output,
        ex.context,
      ),
    );
    const firstVersion = ex.record.rowVersion;
    const b = value(
      await ex.filesystem.stage(
        { artifactRootId: f.artifactRootId, path: `blobs/${hash}` },
        output,
        ex.context,
      ),
    );
    expect(ex.record.rowVersion).toBe(firstVersion + 2);
    expect(
      value(await f.store.jobs.getStages("job-work", f.context())).map(
        (s) => s.stagingId,
      ),
    ).toEqual(expect.arrayContaining([a.stagingId, b.stagingId]));
    return { kind: "wait", error: detail("ACTION_REQUIRED") };
  });
  value(await s.submit(f.submission(), f.context()));
  value(await s.runOnce());
  expect(value(await s.wait("job-work", f.context())).status).toBe(
    "waiting-for-user",
  );
});
