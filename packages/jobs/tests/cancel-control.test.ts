import * as files from "node:fs/promises";
import path from "node:path";
import {
  decodeBackup,
  encodeBackup,
  JOB_STORAGE_LIMITS,
  LocalStore,
} from "@design-studio/storage";
import { expect, onTestFinished, vi, test as vitestTest } from "vitest";
import { detail } from "../src/boundary.js";
import {
  deferred,
  fixture,
  inJobsTest,
  makeService,
  output,
  value,
} from "./support.js";
import {
  AsyncTestScope,
  inTestScope,
  ownTests,
  testScope,
} from "./test-scope.js";

const test = ownTests(vitestTest);

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

test("joins a real reopened database before fixture cleanup can remove its root", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  testScope().releaseOnEnd(() => release.resolve());
  const actualOpen = LocalStore.open.bind(LocalStore);
  const opening = vi
    .spyOn(LocalStore, "open")
    .mockImplementationOnce(async (options) => {
      const store = await actualOpen(options);
      entered.resolve();
      await release.promise;
      return store;
    });
  const reopen = f.reopen();
  const rejected = expect(reopen).rejects.toThrow(/closing/);
  await entered.promise;
  const remove = vi.spyOn(files, "rm");
  let closed = false;
  let closeError: unknown;
  const closing = f.close().then(
    () => {
      closed = true;
    },
    (error: unknown) => {
      closeError = error;
    },
  );
  try {
    expect(remove.mock.calls.some(([filename]) => filename === f.root)).toBe(
      false,
    );
    expect(closed).toBe(false);
    expect(closeError).toBeUndefined();
  } finally {
    release.resolve();
    await rejected;
    await closing;
    opening.mockRestore();
    remove.mockRestore();
    await f.close();
  }
  expect(closeError).toBeUndefined();
});

test.each(["setup", "reopen"] as const)(
  "runner cancellation joins original %s and closes a late admitted database before removal",
  async (kind) => {
    const runner = new AbortController();
    const scope = new AsyncTestScope(runner.signal);
    const entered = deferred<void>();
    const release = deferred<void>();
    testScope().releaseOnEnd(() => release.resolve());
    const f =
      kind === "reopen" ? await inTestScope(scope, () => fixture()) : undefined;
    const actualOpen = LocalStore.open.bind(LocalStore);
    let opened: LocalStore | undefined;
    let root: string | undefined;
    const opening = vi
      .spyOn(LocalStore, "open")
      .mockImplementationOnce(async (options) => {
        opened = await actualOpen(options);
        root = path.dirname(options.databasePath);
        entered.resolve();
        await release.promise;
        return opened;
      });
    const constructing = inTestScope(scope, () => (f ? f.reopen() : fixture()));
    const rejected = expect(constructing).rejects.toThrow(/cancelled/);
    await entered.promise;
    if (!opened || !root) throw new Error("Missing late synthetic database.");
    const filename = root;
    const closeStore = vi.spyOn(opened, "close");
    const remove = vi.spyOn(files, "rm");
    let joined = false;
    runner.abort();
    const closing = scope.close().then(() => {
      joined = true;
    });
    try {
      expect(joined).toBe(false);
      expect(closeStore).not.toHaveBeenCalled();
      expect(remove.mock.calls.some(([entry]) => entry === filename)).toBe(
        false,
      );
      release.resolve();
      await rejected;
      await closing;
      expect(joined).toBe(true);
    } finally {
      release.resolve();
      await closing;
      opening.mockRestore();
    }
    onTestFinished(async () => {
      try {
        expect(closeStore).toHaveBeenCalled();
        await expect(files.lstat(filename)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        closeStore.mockRestore();
        remove.mockRestore();
      }
    });
  },
);

test("failed service cleanup joins every original stop and blocks another fixture scope until retry", async () => {
  const f = await fixture();
  const handler = async () => ({
    kind: "wait" as const,
    error: detail("ACTION_REQUIRED"),
  });
  const first = makeService(f, handler);
  const second = makeService(f, handler);
  const release = deferred<void>();
  testScope().releaseOnEnd(() => release.resolve());
  const entered = deferred<void>();
  const firstStop = vi
    .spyOn(first, "stop")
    .mockRejectedValueOnce(new Error("Synthetic first stop failed"));
  const actualStop = second.stop.bind(second);
  const secondStop = vi
    .spyOn(second, "stop")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return actualStop();
    });
  let finished = false;
  const closing = f.close().finally(() => {
    finished = true;
  });
  const rejected = expect(closing).rejects.toMatchObject({
    message: "Original jobs service stops did not settle successfully.",
    errors: [
      expect.objectContaining({ message: "Synthetic first stop failed" }),
    ],
  });
  try {
    await entered.promise;
    expect(finished).toBe(false);
    const next = vi.fn();
    expect(() => inJobsTest(new AbortController().signal, next)).toThrow(
      /not quiesced/,
    );
    expect(next).not.toHaveBeenCalled();
    release.resolve();
    await rejected;
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
    expect((await files.lstat(f.root)).isDirectory()).toBe(true);
  } finally {
    release.resolve();
    await rejected;
    firstStop.mockRestore();
    secondStop.mockRestore();
    await f.close();
  }
});

test("a cancel-control retry replays without another mutation across restart", async ({
  signal,
}) => {
  const started = performance.now();
  let phase = "setup";
  const elapsed: Record<string, number> = {};
  const abort = () =>
    console.error(
      JSON.stringify({
        scope: "synthetic cancel-control runner abort",
        phase,
        elapsedMs: Math.round(performance.now() - started),
        completedPhaseMs: elapsed,
      }),
    );
  signal.addEventListener("abort", abort, { once: true });
  onTestFinished(() => signal.removeEventListener("abort", abort));
  const measure = async <T>(name: string, action: () => Promise<T>) => {
    phase = name;
    const before = performance.now();
    const result = await action();
    elapsed[name] = Math.round(performance.now() - before);
    return result;
  };
  const f = await measure("setup", () => fixture());
  const run = async () => ({
    kind: "wait" as const,
    error: detail("ACTION_REQUIRED"),
  });
  let service = makeService(f, run);
  value(
    await measure("submit", () => service.submit(f.submission(), f.context())),
  );
  const before = value(
    await measure("read-before", () =>
      service.getVersioned("job-work", f.context()),
    ),
  );
  const accepted = value(
    await measure("cancel", () =>
      service.cancel(
        "job-work",
        before.rowVersion,
        f.context("cancel-control"),
      ),
    ),
  );
  expect(accepted.job.status).toBe("cancelled");
  expect(accepted.rowVersion).toBe(before.rowVersion + 1);
  await measure("reopen", () => f.reopen());
  service = makeService(f, run);
  const replay = value(
    await measure("replay", () =>
      service.cancel(
        "job-work",
        before.rowVersion,
        f.context("cancel-control"),
      ),
    ),
  );
  expect(replay).toEqual(accepted);
  expect(Object.keys(replay).sort()).toEqual(["job", "rowVersion"]);
  expect(
    value(
      await measure("read-after", () =>
        service.getVersioned("job-work", f.context()),
      ),
    ).rowVersion,
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
