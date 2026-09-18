import { isatty } from "node:tty";
import { ApplicationError } from "@design-studio/application";
import {
  type PromptOptions,
  readMaskedSecretFromTerminal,
} from "./masked-secret-input.js";

/** Not wired to a command until reviewed native capture admission exists. */
export function readMaskedSecret(options: PromptOptions): Promise<Uint8Array> {
  if (
    !isatty(0) ||
    !isatty(2) ||
    process.stdin.fd !== 0 ||
    process.stderr.fd !== 2
  )
    return Promise.reject(new ApplicationError("ACTION_REQUIRED"));
  return readMaskedSecretFromTerminal(
    { input: process.stdin, output: process.stderr },
    options,
  );
}
