import type { Readable, Writable } from "node:stream";
import { ApplicationError } from "@design-studio/application";

interface Terminal {
  input: Readable & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode(mode: boolean): unknown;
  };
  output: Writable & { isTTY?: boolean };
}
export interface PromptOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}
/** Internal stream engine for deterministic tests; not a public CLI export. */
export function readMaskedSecretFromTerminal(
  { input, output }: Terminal,
  options: PromptOptions,
): Promise<Uint8Array> {
  const timeout = options.timeoutMs ?? 300_000;
  if (
    !input.isTTY ||
    !output.isTTY ||
    typeof input.setRawMode !== "function" ||
    input.destroyed ||
    output.destroyed ||
    input.readableEncoding !== null ||
    input.readableLength !== 0 ||
    input.listenerCount("data") !== 0 ||
    input.listenerCount("readable") !== 0
  )
    return Promise.reject(new ApplicationError("ACTION_REQUIRED"));
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    return Promise.reject(new ApplicationError("INVALID_INPUT"));
  if (options.signal.aborted)
    return Promise.reject(new ApplicationError("CANCELLED"));
  const bytes = Buffer.alloc(4096);
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  let length = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ApplicationError) => {
      if (finished) return;
      finished = true;
      let result: Uint8Array | undefined;
      if (!error) result = Uint8Array.from(bytes.subarray(0, length));
      bytes.fill(0);
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      input.removeListener("data", data);
      input.removeListener("end", ended);
      input.removeListener("close", ended);
      input.removeListener("error", ioError);
      output.removeListener("error", ioError);
      try {
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
      } catch {
        error = new ApplicationError("INTERRUPTED");
      }
      if (error) {
        result?.fill(0);
        reject(error);
      } else if (result) resolve(result);
    };
    const cancel = () => finish(new ApplicationError("CANCELLED"));
    const ended = () => finish(new ApplicationError("CANCELLED"));
    const ioError = () => finish(new ApplicationError("TRANSPORT_UNAVAILABLE"));
    const data = (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        finish(new ApplicationError("INVALID_INPUT"));
        return;
      }
      try {
        for (let index = 0; index < chunk.byteLength; index++) {
          const byte = chunk[index];
          if (byte === 3 || byte === 4 || byte === 27) {
            cancel();
            return;
          }
          if (byte === 13 || byte === 10) {
            const trailingCrLf =
              byte === 13 &&
              chunk[index + 1] === 10 &&
              index + 2 === chunk.byteLength;
            if (!length || (index + 1 !== chunk.byteLength && !trailingCrLf))
              finish(new ApplicationError("INVALID_INPUT"));
            else finish();
            return;
          }
          if (byte === 8 || byte === 127) {
            if (length) bytes[--length] = 0;
          } else if (
            byte === undefined ||
            byte < 33 ||
            byte > 126 ||
            length === bytes.length
          ) {
            finish(new ApplicationError("INVALID_INPUT"));
            return;
          } else bytes[length++] = byte;
        }
      } finally {
        chunk.fill(0);
      }
    };
    try {
      input.on("end", ended);
      input.on("close", ended);
      input.on("error", ioError);
      output.on("error", ioError);
      options.signal.addEventListener("abort", cancel, { once: true });
      input.setRawMode(true);
      if (finished) return;
      output.write("Figma PAT (input hidden; Escape or Ctrl+C cancels): ");
      if (finished) return;
      input.on("data", data);
      timer = setTimeout(
        () => finish(new ApplicationError("DEADLINE_EXCEEDED")),
        timeout,
      );
      if (options.signal.aborted) cancel();
      else input.resume();
    } catch {
      ioError();
    }
  });
}
