import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startProbe, withOwnedProbe } from "./owned-probe.js";

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
