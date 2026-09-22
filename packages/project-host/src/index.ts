export { openCaptureCredentials } from "./capture-credentials.js";
export {
  type CaptureProject,
  CaptureStartupCleanupRequired,
  openCaptureProject,
} from "./capture-project.js";
export {
  acquireCaptureWork,
  assertCaptureWork,
  type CaptureWork,
} from "./capture-work.js";
export {
  assertCaptureDiagnosticInstallation,
  assertCaptureRecoveryInstallation,
  assertCaptureReferenceInstallation,
  type CaptureInstallationLease,
  type FixtureInstallationLease,
  type FixtureInstallationPaths,
  registerCaptureInstallationGuards,
  registerFixtureInstallationGuards,
  verifyCaptureInstallation,
  verifyFixtureInstallation,
} from "./installation.js";
export {
  type PatDialogClose,
  type PatDialogRun,
  startCapturePatDialog,
} from "./pat-dialog-controller.js";
export {
  type CurrentPrincipal,
  type FixturePaths,
  type FixtureProjectBinding,
  type FixtureProjectOptions,
  type FixtureProjectRegistry,
  type FixtureScope,
  WindowsFixtureProjects,
} from "./projects.js";
