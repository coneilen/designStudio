import {
  decodeBackup,
  encodeBackup,
  JOB_STORAGE_LIMITS,
} from "@design-studio/storage";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import { fixture, makeService, output, value } from "./support.js";

test("a cancel-control retry replays without another mutation across restart", async () => {
  const f = await fixture();
  const run = async () => ({
    kind: "wait" as const,
    error: detail("ACTION_REQUIRED"),
  });
  let service = makeService(f, run);
  value(await service.submit(f.submission(), f.context()));
  const before = value(await service.getVersioned("job-work", f.context()));
  const accepted = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      f.context("cancel-control"),
    ),
  );
  expect(accepted.job.status).toBe("cancelled");
  expect(accepted.rowVersion).toBe(before.rowVersion + 1);
  await f.reopen();
  service = makeService(f, run);
  const replay = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      f.context("cancel-control"),
    ),
  );
  expect(replay).toEqual(accepted);
  expect(Object.keys(replay).sort()).toEqual(["job", "rowVersion"]);
  expect(
    value(await service.getVersioned("job-work", f.context())).rowVersion,
  ).toBe(accepted.rowVersion);
});

test("control key binds original target/precondition before completed-job handling", async () => {
  const f = await fixture();
  const service = makeService(f, async (ex) => ({
    kind: "complete",
    completion: {
      outputs: [value(await ex.stage(output))],
      outputState: "complete",
      diagnosticIds: [],
    },
  }));
  value(await service.submit(f.submission(), f.context()));
  const before = value(await service.getVersioned("job-work", f.context()));
  const accepted = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      f.context("cancel-control"),
    ),
  );
  expect(
    await service.cancel(
      "job-work",
      accepted.rowVersion,
      f.context("cancel-control"),
    ),
  ).toMatchObject({
    status: "failed",
    error: { code: "CONFLICT" },
  });
  value(await service.submit(f.submission("other"), f.context("other")));
  value(await service.runOnce());
  value(await service.waitForAttempt("job-other", f.context("other")));
  const completed = value(
    await service.getVersioned("job-other", f.context("other")),
  );
  expect(completed.job.status).toBe("completed");
  expect(
    await service.cancel(
      "job-other",
      completed.rowVersion,
      f.context("cancel-control"),
    ),
  ).toMatchObject({
    status: "failed",
    error: { code: "CONFLICT" },
  });
});

test("new controls advance the authoritative private version without changing terminal Job", async () => {
  const f = await fixture();
  const service = makeService(f, async () => ({
    kind: "wait",
    error: detail("ACTION_REQUIRED"),
  }));
  value(await service.submit(f.submission(), f.context()));
  const before = value(await service.getVersioned("job-work", f.context()));
  const first = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      f.context("control-one"),
    ),
  );
  const second = value(
    await service.cancel(
      "job-work",
      first.rowVersion,
      f.context("control-two"),
    ),
  );
  expect(second.rowVersion).toBe(first.rowVersion + 1);
  expect(second.job).toEqual(first.job);
  const replay = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      f.context("control-one"),
    ),
  );
  expect(replay).toEqual(second);
});

test("authorized restore keeps immutable control evidence but replay returns the restored version", async () => {
  const source = await fixture();
  const run = async () => ({
    kind: "wait" as const,
    error: detail("ACTION_REQUIRED"),
  });
  const service = makeService(source, run);
  value(await service.submit(source.submission(), source.context()));
  const before = value(
    await service.getVersioned("job-work", source.context()),
  );
  const accepted = value(
    await service.cancel(
      "job-work",
      before.rowVersion,
      source.context("cancel-control"),
    ),
  );
  const historical = value(
    await source.store.jobs.get("job-work", source.context()),
  ).cancelControls;
  const backup = decodeBackup(
    encodeBackup(
      value(await source.store.backup(source.context("backup"))),
      JOB_STORAGE_LIMITS.metadataBytes,
    ),
    JOB_STORAGE_LIMITS.metadataBytes,
  );
  const destination = await fixture({ seed: false });
  expect(
    await destination.store.restore(backup, destination.context("restore")),
  ).toMatchObject({ status: "failed" });
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
      before.rowVersion,
      destination.context("cancel-control"),
    ),
  );
  expect(replay).toEqual(current);
  const record = value(
    await destination.store.jobs.get("job-work", destination.context()),
  );
  expect(record.cancelControls).toEqual(historical);
  expect(record.rowVersion).toBe(current.rowVersion);
});
