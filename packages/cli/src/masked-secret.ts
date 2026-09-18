import { ApplicationError } from "@design-studio/application";
import type { PromptOptions } from "./masked-secret-input.js";

/** No native dedicated-console/profile/confirmation adapter is admitted yet. */
export function readMaskedSecret(_options: PromptOptions): Promise<Uint8Array> {
  return Promise.reject(new ApplicationError("ACTION_REQUIRED"));
}
