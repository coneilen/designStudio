import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  createDedicatedSecretInputOwner,
  readMaskedSecretFromTerminal,
} from "../src/masked-secret-input.js";

const inputStream = () =>
  Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
class ClassTerminal {
  readonly #ownedInput = inputStream();
  input = this.#ownedInput;
  output = Object.assign(new PassThrough(), { isTTY: true });
  calls = 0;
  gate: Promise<void> | undefined;
  fail = false;
  async releaseAfterExit() {
    this.calls++;
    await this.gate;
    if (this.fail) throw new Error("private-class-cleanup");
    this.#ownedInput.setRawMode(false);
  }
}
function running(tty: ClassTerminal, afterRegistration?: () => void) {
  const input = tty.input;
  const control = createDedicatedSecretInputOwner(tty);
  afterRegistration?.();
  const result = readMaskedSecretFromTerminal(control.owner, {
    signal: new AbortController().signal,
  });
  let settled = false;
  const outcome = result.then(
    (bytes) => {
      settled = true;
      return { bytes };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  input.write(Buffer.from("\x1b[200~synthetic-owned\x1b[201~"));
  const receipt = control.confirmation();
  if (!receipt) throw new Error("Missing synthetic confirmation");
  control.confirm(receipt);
  return {
    input,
    control,
    outcome,
    settled: () => settled,
    async exit() {
      if (!input.closed) {
        const closed = once(input, "close");
        input.destroy();
        await closed;
      }
      return control.afterTerminalExit();
    },
  };
}

it("owns and awaits prototype cleanup with its original class receiver", async () => {
  const tty = new ClassTerminal();
  let resolve!: () => void;
  tty.gate = new Promise<void>((accept) => {
    resolve = accept;
  });
  const run = running(tty);
  const closing = run.exit();
  try {
    await new Promise<void>((accept) => setImmediate(accept));
    expect(tty.calls).toBe(1);
    expect(run.settled()).toBe(false);
    expect(run.control.state().pending).toBe(true);
    expect(run.input.isRaw).toBe(true);
  } finally {
    resolve();
  }
  expect(await closing).toMatchObject({ phase: "closed", pending: false });
  const outcome = await run.outcome;
  expect(outcome).toHaveProperty("bytes");
  if ("bytes" in outcome) outcome.bytes.fill(0);
  expect(run.input.isRaw).toBe(false);
});

it("retains failed prototype cleanup and retries against current receiver state", async () => {
  const tty = new ClassTerminal();
  tty.fail = true;
  const run = running(tty);
  expect(await run.exit()).toMatchObject({
    pending: true,
    cleanupCode: "INTERRUPTED",
  });
  const outcome = await run.outcome;
  if ("bytes" in outcome) outcome.bytes.fill(0);
  expect(outcome).toMatchObject({ error: { code: "INTERRUPTED" } });
  expect(tty.calls).toBe(1);
  expect(run.input.isRaw).toBe(true);
  tty.fail = false;
  expect(await run.control.afterTerminalExit()).toMatchObject({
    pending: false,
    phase: "closed",
  });
  expect(tty.calls).toBe(2);
  expect(run.input.isRaw).toBe(false);
});

it("snapshots terminal fields and cleanup identity while retaining the original receiver", async () => {
  const tty = new ClassTerminal();
  const foreign = inputStream();
  let replacementCalled = false;
  const run = running(tty, () => {
    tty.input = foreign;
    tty.output = Object.assign(new PassThrough(), { isTTY: false });
    tty.releaseAfterExit = async () => {
      replacementCalled = true;
    };
  });
  expect(await run.exit()).toMatchObject({ pending: false, phase: "closed" });
  const outcome = await run.outcome;
  if ("bytes" in outcome) outcome.bytes.fill(0);
  expect(tty.calls).toBe(1);
  expect(replacementCalled).toBe(false);
  expect(run.input.isRaw).toBe(false);
  expect(foreign.destroyed).toBe(false);
  expect(foreign.listenerCount("data")).toBe(0);
});

it("rejects missing or noncallable cleanup before ownership or input admission", () => {
  for (const cleanup of [undefined, null, false, "not-a-function"]) {
    const tty = new ClassTerminal();
    Object.defineProperty(tty, "releaseAfterExit", {
      value: cleanup,
      writable: true,
    });
    expect(() => createDedicatedSecretInputOwner(tty)).toThrow();
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount("data")).toBe(0);
    tty.releaseAfterExit = ClassTerminal.prototype.releaseAfterExit;
    expect(() => createDedicatedSecretInputOwner(tty)).not.toThrow();
  }
});
