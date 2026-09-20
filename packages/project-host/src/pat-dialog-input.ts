import { performance } from "node:perf_hooks";
import { HostBoundaryError } from "../../host/dist/guards.js";
import { type PatChannel, PatKind } from "../../host/dist/pat-channel.js";
import { validatePatBytes } from "../../host/dist/pat-input.js";
import {
  collectWindowsPat,
  NativePatDialogError,
} from "../../host/dist/windows-pat-dialog.js";

/** Private fixed-helper session, entered only after its verified START. */
export async function runPatDialogInput(
  channel: PatChannel,
  duration: number,
): Promise<number> {
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid fixed input duration.",
    );
  const abort = new AbortController();
  const deadline = performance.now() + duration;
  let ended = false;
  let disposing = false;
  let inputExpired = false;
  let controlFailed = false;
  let ready: Promise<void> | undefined;
  let accepted: Buffer | undefined;
  let clean = false;
  let code = 0;
  const control = (async () => {
    try {
      let frame = await channel.readInput(duration);
      if (!frame) {
        inputExpired = true;
        abort.abort();
        const remaining = Math.ceil(deadline + 5000 - performance.now());
        if (remaining <= 0) throw new Error("terminal-deadline");
        frame = await channel.read(Math.min(5000, remaining));
      }
      try {
        if (frame.kind !== PatKind.cancel || frame.sequence !== 0) {
          controlFailed = true;
          throw new Error("protocol");
        }
        abort.abort();
      } finally {
        frame.bytes.fill(0);
      }
    } catch {
      if (!disposing || channel.receiveFailed) controlFailed = true;
      if (!ended) abort.abort();
    }
  })();
  try {
    accepted = await collectWindowsPat(abort.signal, deadline, () => {
      if (ready) throw new Error("duplicate-ready");
      ready = channel.send(PatKind.ready, 0);
      void ready.catch(() => abort.abort());
    });
    clean = true;
    validatePatBytes(accepted);
    if (inputExpired || performance.now() >= deadline)
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "PAT input deadline exceeded.",
      );
    if (abort.signal.aborted)
      throw new HostBoundaryError("CANCELLED", "PAT input cancelled.");
    await ready;
    if (inputExpired || performance.now() >= deadline)
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "PAT input deadline exceeded.",
      );
    if (abort.signal.aborted || controlFailed || channel.receiveFailed)
      throw new HostBoundaryError("CANCELLED", "PAT input cancelled.");
    await channel.send(PatKind.accepted, 1, accepted);
  } catch (error) {
    const inputError =
      error instanceof NativePatDialogError ? error : undefined;
    let primary =
      inputError?.primaryCode ??
      (error instanceof HostBoundaryError ? error.code : undefined);
    if (controlFailed || channel.receiveFailed)
      primary = "TRANSPORT_UNAVAILABLE";
    else if (inputExpired && primary === "CANCELLED")
      primary = "DEADLINE_EXCEEDED";
    clean ||= inputError?.cleanupComplete === true;
    const transportFailed =
      error instanceof HostBoundaryError &&
      error.code === "TRANSPORT_UNAVAILABLE";
    code =
      clean && !controlFailed && !channel.receiveFailed && !transportFailed
        ? 0
        : 1;
    try {
      await channel.send(
        PatKind.error,
        ready ? 1 : 0,
        Buffer.of(
          primary === "CANCELLED" ? 1 : primary === "DEADLINE_EXCEEDED" ? 2 : 3,
        ),
      );
    } catch {
      code = 1;
    }
  } finally {
    ended = true;
    accepted?.fill(0);
    if (ready) {
      try {
        await ready;
      } catch {
        code = 1;
      }
    }
    try {
      await channel.send(
        PatKind.closed,
        1,
        Buffer.of(
          clean && code === 0 && !controlFailed && !channel.receiveFailed
            ? 3
            : 0,
        ),
      );
    } catch {
      code = 1;
    }
    if (channel.receiveFailed || channel.hasBufferedInput) code = 1;
    disposing = true;
    await channel.close();
    await control;
    if (controlFailed || channel.receiveFailed) code = 1;
  }
  return code;
}
