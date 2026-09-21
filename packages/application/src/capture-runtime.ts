import type { CaptureProject } from "@design-studio/project-host";
import { assembleNativeCapture } from "./capture-runtime-internal.js";

export {
  CAPTURE_RECOVERY_CONFIRMATION,
  type NativeCaptureRecoveryInput,
} from "./capture-recovery.js";

export type {
  NativeCaptureInput,
  NativeCaptureRuntime,
} from "./capture-runtime-internal.js";
export {
  NativeCaptureCleanupRequired,
  NativeCaptureStartupCleanupRequired,
} from "./capture-runtime-internal.js";

/** Public native factory has no test policy, transport, root, vault or authorization overrides. */
export function openNativeCapture(project: CaptureProject) {
  return assembleNativeCapture(project);
}
