import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  prepareOwnedProbeFixture,
  startProbe,
  withOwnedProbe,
} from "./owned-probe.js";

test("original cancellation rejects only after the actual child and pipes close", async ({
  signal,
}) => {
  const abort = new AbortController();
  const probe = startProbe(
    ["-e", 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    {
      signal: AbortSignal.any([signal, abort.signal]),
    },
  );
  let closed = false;
  probe.child.once("close", () => {
    closed = true;
  });
  const rejected = expect(probe.finished).rejects.toMatchObject({
    name: "AbortError",
  });
  try {
    if (!probe.child.stdout) throw new Error("Probe stdout was not captured");
    await Promise.race([once(probe.child.stdout, "data"), probe.finished]);
    abort.abort();
    await rejected;
    expect(closed).toBe(true);
    expect(
      probe.child.exitCode !== null || probe.child.signalCode !== null,
    ).toBe(true);
  } finally {
    abort.abort();
    await probe.finished.catch(() => undefined);
  }
});

test("joins cancelled original work before deleting its root or starting another fixture", async ({
  signal,
}) => {
  const abort = new AbortController();
  let root = "";
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = withOwnedProbe(
    AbortSignal.any([signal, abort.signal]),
    async (directory, run) => {
      root = directory;
      const child = run(["-e", "setInterval(()=>{},1000)"]);
      entered();
      await child;
    },
  );
  const rejected = expect(work).rejects.toMatchObject({
    cause: { name: "AbortError" },
  });
  await ready;
  expect((await lstat(root)).isDirectory()).toBe(true);
  abort.abort();
  await rejected;
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  await withOwnedProbe(signal, async (nextRoot, run) => {
    expect(nextRoot).not.toBe(root);
    const marker = path.join(nextRoot, "next.txt");
    await run([
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],'next')",
      marker,
    ]);
    expect(await readFile(marker, "utf8")).toBe("next");
  });
});
test.for([
  { name: "nonzero exit", code: "process.exit(7)", expected: { code: 7 } },
  {
    name: "bounded stdout",
    code: "process.stdout.write('x'.repeat(20000))",
    expected: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
  },
])(
  "does not disguise $name as successful probe output",
  async (scenario, { signal }) => {
    const probe = startProbe(["-e", scenario.code], { signal });
    await expect(probe.finished).rejects.toMatchObject(scenario.expected);
  },
);

test.for(["setup", "reader"] as const)(
  "split fixture joins original %s cancellation, real SQLite child and gates before root deletion",
  async (stage, { signal }) => {
    const runner = new AbortController();
    const originalSignal = AbortSignal.any([signal, runner.signal]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let childClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      childClosed = resolve;
    });
    const events: { phase: string; event: string }[] = [];
    let root = "";
    let originalSettled = false;
    let cleanupSettled = false;
    const gatedDatabase = async () => {
      const probe = startProbe(
        [
          "-e",
          'const Database=require(process.argv[1]);const db=new Database(process.argv[2],{nativeBinding:process.argv[3]});db.exec("CREATE TABLE synthetic(value INTEGER)");process.stdin.resume();process.stdout.write("sqlite-open");',
          path.resolve("packages\\storage\\node_modules\\better-sqlite3"),
          path.join(root, "synthetic.sqlite"),
          path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
        ],
        { signal: originalSignal },
      );
      probe.child.once("close", childClosed);
      const settled = probe.finished.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (!probe.child.stdout) throw new Error("Missing owned child stdout");
        const output = await Promise.race([
          once(probe.child.stdout, "data"),
          settled,
        ]);
        expect(Array.isArray(output)).toBe(true);
        if (!Array.isArray(output))
          throw new Error("SQLite child ended before ready");
        expect(String(output[0])).toBe("sqlite-open");
        entered();
        await gate;
        originalSignal.throwIfAborted();
      } finally {
        if (probe.child.exitCode === null && probe.child.signalCode === null)
          probe.child.kill();
        await settled;
        originalSettled = true;
      }
    };
    const fixture = prepareOwnedProbeFixture(
      "ownership-regression",
      originalSignal,
      async (directory, _run, phase) => {
        root = directory;
        if (stage === "setup") await phase("oldwriter", gatedDatabase);
        return directory;
      },
      (event) => events.push(event),
    );
    let work: Promise<unknown> = fixture.ready;
    let closing: Promise<unknown> | undefined;
    try {
      if (stage === "reader") {
        await fixture.ready;
        work = fixture.use(originalSignal, async (_value, _run, phase) => {
          await phase("newreader", gatedDatabase);
        });
      }
      const result = work.then(
        () => "settled",
        () => "rejected",
      );
      await Promise.race([
        entering,
        result.then(() => {
          throw new Error("Work ended before gate");
        }),
      ]);
      runner.abort();
      closing = fixture.close().then(
        () => {
          cleanupSettled = true;
        },
        (error: unknown) => {
          cleanupSettled = true;
          return error;
        },
      );
      await closed;
      expect(originalSettled).toBe(false);
      expect(cleanupSettled).toBe(false);
      expect((await lstat(root)).isDirectory()).toBe(true);
      expect(events.filter((e) => e.event === "runner-abort")).toEqual([
        expect.objectContaining({
          phase: stage === "setup" ? "oldwriter" : "newreader",
        }),
      ]);
      expect(() => fixture.use(originalSignal, async () => {})).toThrow();
      release();
      expect(await result).toBe("rejected");
      await closing;
      expect(originalSettled).toBe(true);
      expect(cleanupSettled).toBe(true);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      runner.abort();
      release();
      await Promise.allSettled([
        work,
        fixture.close(),
        ...(closing ? [closing] : []),
      ]);
    }
  },
);

test("split fixture transfers one exact root only after writer close and denies reuse", async ({
  signal,
}) => {
  const fixture = prepareOwnedProbeFixture(
    "ownership-regression",
    signal,
    async (root, run, phase) => {
      const writer = await phase("oldwriter", () =>
        run(["-e", 'process.stdout.write("closed-writer")']),
      );
      expect(writer.stdout).toBe("closed-writer");
      return root;
    },
    () => {},
  );
  try {
    const root = await fixture.ready;
    await fixture.use(signal, async (sameRoot, run, phase) => {
      expect(sameRoot).toBe(root);
      const reader = await phase("newreader", () =>
        run(["-e", 'process.stdout.write("closed-reader")']),
      );
      expect(reader.stdout).toBe("closed-reader");
    });
    expect(() => fixture.use(signal, async () => {})).toThrow();
    await fixture.close();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});
