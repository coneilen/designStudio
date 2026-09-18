import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { ApplicationError } from "@design-studio/application";
import type { ErrorCode } from "@design-studio/contracts";

interface DedicatedTerminal {
  input: Readable & { isTTY?: boolean; setRawMode(mode: boolean): unknown };
  output: Writable & { isTTY?: boolean };
  /** Resource cleanup after observed dedicated terminal exit; never a trust assertion. */
  releaseAfterExit(): Promise<void>;
}
export interface PromptOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}
export interface SecretInputOwner {
  readonly kind: "dedicated-secret-input";
}
export interface SecretInputConfirmation {
  readonly kind: "secret-input-confirmation";
}
export interface SecretInputState {
  phase:
    | "awaiting-frame"
    | "collecting"
    | "awaiting-confirmation"
    | "closing"
    | "draining"
    | "discarding"
    | "closed";
  pending: boolean;
  parsedBytes: number;
  primaryCode?: ErrorCode;
  cleanupCode?: ErrorCode;
}
interface InputSession {
  state(): SecretInputState;
  confirmation(): SecretInputConfirmation | undefined;
  confirm(receipt: SecretInputConfirmation): void;
  afterTerminalExit(): Promise<SecretInputState>;
}
interface Registration {
  terminal: DedicatedTerminal;
  session?: InputSession;
}
const owners = new WeakMap<SecretInputOwner, Registration>();
const inputs = new WeakSet<Readable>();
const startMarker = [27, 91, 50, 48, 48, 126];
const endMarker = [27, 91, 50, 48, 49, 126];
const maxParsedBytes = 8192;
const recovery =
  "\r\nSecret input is retained. Close/discard this dedicated secret-input console; do not reuse it as a shell.\r\n";

function admissible({ input, output }: DedicatedTerminal): boolean {
  return (
    input.isTTY === true &&
    output.isTTY === true &&
    typeof input.setRawMode === "function" &&
    !input.destroyed &&
    !output.destroyed &&
    input.readableEncoding === null &&
    input.readableLength === 0 &&
    input.listenerCount("data") === 0 &&
    input.listenerCount("readable") === 0
  );
}

/**
 * Internal ownership primitive, NOT a verified platform/profile issuer.
 * A future native adapter must own a dedicated console and prove its exit and
 * out-of-band user confirmation. No production adapter is admitted yet.
 */
export function createDedicatedSecretInputOwner(terminal: DedicatedTerminal) {
  if (!admissible(terminal) || inputs.has(terminal.input))
    throw new ApplicationError("ACTION_REQUIRED");
  inputs.add(terminal.input);
  const owner: SecretInputOwner = Object.freeze({
    kind: "dedicated-secret-input",
  });
  const registration: Registration = {
    terminal: Object.freeze({ ...terminal }),
  };
  owners.set(owner, registration);
  const session = () => {
    if (!registration.session) throw new ApplicationError("ACTION_REQUIRED");
    return registration.session;
  };
  return Object.freeze({
    owner,
    state: () => session().state(),
    confirmation: () => session().confirmation(),
    // This control plane is never dispatched from terminal bytes.
    confirm: (receipt: SecretInputConfirmation) => session().confirm(receipt),
    // The native owner must observe console/process exit, not merely input EOF.
    afterTerminalExit: () => session().afterTerminalExit(),
  });
}

export class SecretInputFailure extends ApplicationError {
  readonly cleanupRequired = true;
  readonly recoveryGuidance = recovery;
  constructor(
    code: ErrorCode,
    readonly owner: SecretInputOwner,
  ) {
    super(code);
  }
}

/** Only a registered single-use owner may start this internal protocol. */
export function readMaskedSecretFromTerminal(
  owner: SecretInputOwner,
  options: PromptOptions,
): Promise<Uint8Array> {
  const registration = owners.get(owner);
  if (
    !registration ||
    registration.session ||
    !admissible(registration.terminal)
  )
    return Promise.reject(new ApplicationError("ACTION_REQUIRED"));
  const timeout = options.timeoutMs ?? 300_000;
  const signal = options.signal;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    return Promise.reject(new ApplicationError("INVALID_INPUT"));
  const deadline = performance.now() + timeout;
  const { input, output, releaseAfterExit } = registration.terminal;
  const candidate = Buffer.alloc(4096);
  let length = 0;
  let marker = 0;
  let receipt: SecretInputConfirmation | undefined;
  let phase: SecretInputState["phase"] = "awaiting-frame";
  let primaryCode: ErrorCode | undefined;
  let cleanupCode: ErrorCode | undefined;
  let parsedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: Promise<SecretInputState> | undefined;
  let guidanceWritten = false;
  const state = (): SecretInputState => ({
    phase,
    pending: phase !== "closed",
    parsedBytes,
    ...(primaryCode ? { primaryCode } : {}),
    ...(cleanupCode ? { cleanupCode } : {}),
  });
  return new Promise((resolve, reject) => {
    const clearCandidate = () => {
      candidate.fill(0);
      length = 0;
      receipt = undefined;
    };
    const guide = () => {
      if (guidanceWritten) return;
      guidanceWritten = true;
      try {
        output.write(recovery);
      } catch {
        cleanupCode = "TRANSPORT_UNAVAILABLE";
      }
    };
    const fail = (code: ErrorCode) => {
      if (phase === "closed") return;
      clearCandidate();
      if (phase !== "draining") {
        phase = phase === "collecting" ? "draining" : "discarding";
        marker = 0;
      }
      if (!primaryCode) {
        primaryCode = code;
        reject(new SecretInputFailure(code, owner));
      }
      guide();
    };
    const abort = () => fail("CANCELLED");
    const checkDeadline = () => {
      if (performance.now() < deadline) return true;
      fail("DEADLINE_EXCEEDED");
      phase = "discarding";
      return false;
    };
    const eof = () => {
      if (phase !== "closing") fail("CANCELLED");
    };
    const ioError = () => {
      cleanupCode = "TRANSPORT_UNAVAILABLE";
      fail("TRANSPORT_UNAVAILABLE");
    };
    const ready = () => {
      marker = 0;
      if (!length) {
        fail("INVALID_INPUT");
        return;
      }
      phase = "awaiting-confirmation";
      receipt = Object.freeze({ kind: "secret-input-confirmation" });
      try {
        output.write(
          "\r\nPaste complete. Confirm using the dedicated owner's separate control; terminal keys cannot confirm.\r\n",
        );
      } catch {
        ioError();
      }
    };
    const byte = (value: number) => {
      if (phase === "discarding" || phase === "closed") return;
      if (phase === "closing" || phase === "awaiting-confirmation") {
        fail("INVALID_INPUT");
        return;
      }
      if (phase === "awaiting-frame") {
        if (value !== startMarker[marker]) {
          fail(value === 3 || value === 4 ? "CANCELLED" : "INVALID_INPUT");
        } else if (++marker === startMarker.length) {
          phase = "collecting";
          marker = 0;
        }
        return;
      }
      if (phase === "draining") {
        marker =
          value === endMarker[marker] ? marker + 1 : value === 27 ? 1 : 0;
        if (marker === endMarker.length) {
          phase = "discarding";
          marker = 0;
        }
        return;
      }
      if (marker || value === 27) {
        if (value !== endMarker[marker]) {
          fail("INVALID_INPUT");
          marker = value === 27 ? 1 : 0;
        } else if (++marker === endMarker.length) ready();
      } else if (value < 33 || value > 126) {
        fail(value === 3 || value === 4 ? "CANCELLED" : "INVALID_INPUT");
      } else if (length === candidate.length) {
        fail("INPUT_LIMIT");
      } else candidate[length++] = value;
    };
    const data = (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        fail("INVALID_INPUT");
        return;
      }
      try {
        if (!checkDeadline()) return;
        for (const value of chunk) {
          if (phase === "discarding" || phase === "closed") break;
          if (parsedBytes === maxParsedBytes) {
            fail("INPUT_LIMIT");
            cleanupCode = "INPUT_LIMIT";
            phase = "discarding";
            break;
          }
          parsedBytes++;
          byte(value);
        }
      } finally {
        // One constant-memory discard sink stays owned until terminal exit.
        chunk.fill(0);
      }
    };
    const detach = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      input.removeListener("data", data);
      input.removeListener("end", eof);
      input.removeListener("close", eof);
      input.removeListener("error", ioError);
      output.removeListener("error", ioError);
    };
    registration.session = {
      state,
      confirmation: () => receipt,
      confirm: (inputReceipt) => {
        if (
          !receipt ||
          inputReceipt !== receipt ||
          phase !== "awaiting-confirmation"
        )
          throw new ApplicationError("FORBIDDEN");
        if (!checkDeadline()) throw new ApplicationError("DEADLINE_EXCEEDED");
        receipt = undefined;
        phase = "closing";
        guide();
      },
      afterTerminalExit: async () => {
        if (release) return release;
        if (phase === "closed") return state();
        if (!input.closed || !input.destroyed || input.readableLength !== 0)
          return state();
        if (phase !== "closing" && !primaryCode) fail("CANCELLED");
        release = Promise.resolve()
          .then(releaseAfterExit)
          .then(
            () => {
              checkDeadline();
              detach();
              const result = primaryCode
                ? undefined
                : Uint8Array.from(candidate.subarray(0, length));
              clearCandidate();
              phase = "closed";
              cleanupCode = undefined;
              if (result) resolve(result);
              return state();
            },
            () => {
              cleanupCode = "INTERRUPTED";
              fail("INTERRUPTED");
              return state();
            },
          );
        try {
          return await release;
        } finally {
          release = undefined;
        }
      },
    };
    try {
      input.on("data", data);
      input.on("end", eof);
      input.on("close", eof);
      input.on("error", ioError);
      output.on("error", ioError);
      signal.addEventListener("abort", abort, { once: true });
      input.setRawMode(true);
      output.write(
        "Paste one Figma PAT in this dedicated console (input hidden). Ordinary typing/newlines cannot submit.\r\n",
      );
      timer = setTimeout(() => {
        fail("DEADLINE_EXCEEDED");
        phase = "discarding";
      }, timeout);
      if (signal.aborted) abort();
      input.resume();
    } catch {
      ioError();
    }
  });
}
