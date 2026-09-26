import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationError } from "@design-studio/application";
import {
  CAPTURE_RECOVERY_CONFIRMATION,
  DIAGNOSTIC_APPROVAL_CONFIRMATION,
  DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
  NativeCaptureCleanupRequired,
  type NativeCaptureInput,
  type NativeCaptureRecoveryInput,
  type NativeCaptureRuntime,
  NativeCaptureStartupCleanupRequired,
  type NativeReferenceForkInput,
  type NativeReferenceForkResultInput,
  type NativeReferenceInput,
  type NativeReferenceOfflineInput,
  type NativeReferenceRecoveryPlanInput,
  openNativeCapture,
  openNativeReferenceConversionInspection,
  openNativeReferenceFork,
  openNativeReferenceForkResult,
  openNativeReferenceOffline,
  openNativeReferenceValidation,
  REFERENCE_APPROVAL_CONFIRMATION,
  REFERENCE_CONVERSION_CONFIRMATION,
  REFERENCE_DOWNLOAD_CONFIRMATION,
  REFERENCE_FORK_CONFIRMATION,
  REFERENCE_RECOVERY_CONFIRMATION,
} from "@design-studio/application/capture";
import {
  type ErrorCode,
  type NativeCaptureEnvelope,
  type NativeCaptureRecoveryEnvelope,
  type NativeReferenceEnvelope,
  type NativeReferenceForkEnvelope,
  type NativeReferenceForkResultEnvelope,
  type NativeReferenceOfflineEnvelope,
  type NativeReferenceRecoveryPlanEnvelope,
  validateContract,
} from "@design-studio/contracts";
import {
  assertCaptureDiagnosticInstallation,
  assertCaptureRecoveryInstallation,
  assertCaptureReferenceInstallation,
  assertReferenceConversionInspectionInstallation,
  assertReferenceForkInstallation,
  assertReferenceOfflineInstallation,
  assertReferenceValidationInstallation,
  type CaptureInstallationLease,
  type CaptureProject,
  CaptureStartupCleanupRequired,
  openCaptureCredentials,
  openCaptureProject,
  type PatDialogRun,
  registerCaptureInstallationGuards,
  startCapturePatDialog,
  verifyCaptureInstallation,
} from "@design-studio/project-host";

type Action = "setup" | "status" | "update" | "remove";
type NativeEnvelope =
  | NativeCaptureEnvelope
  | NativeCaptureRecoveryEnvelope
  | NativeReferenceEnvelope
  | NativeReferenceRecoveryPlanEnvelope
  | NativeReferenceOfflineEnvelope
  | NativeReferenceForkEnvelope
  | NativeReferenceForkResultEnvelope;
interface NativeArguments {
  command:
    | "help"
    | "project-create"
    | Action
    | "figma-capture"
    | "figma-inspect"
    | "figma-convert"
    | "figma-artifact"
    | "figma-recover"
    | "figma-reference-recovery-plan"
    | "figma-reference-fork"
    | "figma-reference-fork-result"
    | `figma-${NativeReferenceOfflineInput["operation"]}`
    | `figma-${NativeReferenceInput["operation"]}`;
  project?: string;
  reference?: string;
  expires?: string;
  capture?:
    | NativeCaptureInput
    | NativeCaptureRecoveryInput
    | NativeReferenceInput
    | NativeReferenceRecoveryPlanInput
    | NativeReferenceOfflineInput
    | NativeReferenceForkInput
    | NativeReferenceForkResultInput;
}
const offlineOperations = [
  "reference-recovery-apply-plan",
  "reference-recovery-apply",
  "reference-recovery-inspect",
  "convert-reference",
  "reference-conversion-inspect",
] as const;
function isOffline(
  input: NonNullable<NativeArguments["capture"]>,
): input is NativeReferenceOfflineInput {
  return offlineOperations.some((value) => value === input.operation);
}
const referenceOperations = [
  "reference-plan",
  "reference-approve",
  "reference-download",
  "reference-inspect",
  "reference-diagnostic-plan",
  "reference-diagnostic-approve",
  "reference-diagnostic-download",
  "reference-diagnostic-inspect",
] as const;
function isReference(
  input: NonNullable<NativeArguments["capture"]>,
): input is NativeReferenceInput {
  return referenceOperations.some((value) => value === input.operation);
}
function envelopeKind(input: NonNullable<NativeArguments["capture"]>) {
  if (input.operation === "reference-fork-result")
    return "NativeReferenceForkResultEnvelope" as const;
  if (input.operation === "reference-fork")
    return "NativeReferenceForkEnvelope" as const;
  return isOffline(input)
    ? ("NativeReferenceOfflineEnvelope" as const)
    : input.operation === "reference-recovery-plan"
      ? ("NativeReferenceRecoveryPlanEnvelope" as const)
      : isReference(input)
        ? ("NativeReferenceEnvelope" as const)
        : input.operation === "recover"
          ? ("NativeCaptureRecoveryEnvelope" as const)
          : ("NativeCaptureEnvelope" as const);
}
export function parseCaptureArguments(
  argv: readonly string[],
): NativeArguments {
  const args = [...argv];
  if (args.length === 0 || (args.length === 1 && args[0] === "--help"))
    return { command: "help" };
  if (
    args.length > 14 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 256)
  )
    throw new ApplicationError("INVALID_INPUT");
  const [area, verb] = args;
  if (area === "figma") {
    if (
      !verb ||
      ![
        "capture",
        "inspect",
        "convert",
        "artifact",
        "recover",
        "reference-recovery-plan",
        "reference-fork",
        "reference-fork-result",
        ...offlineOperations,
        ...referenceOperations,
      ].includes(verb)
    )
      throw new ApplicationError("INVALID_INPUT");
    const options = new Map<string, string>();
    for (let index = 2; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (
        !name ||
        !value ||
        value.startsWith("--") ||
        options.has(name) ||
        ![
          "--project",
          "--request-id",
          ...(verb === "reference-recovery-plan" ? ["--expected-job"] : []),
          ...(verb === "reference-fork-result" ? ["--expected-receipt"] : []),
          ...(verb === "reference-fork"
            ? ["--expected-job", "--expected-recovery", "--confirm"]
            : []),
          ...(offlineOperations.some((value) => value === verb)
            ? ["--expected-job"]
            : []),
          ...(verb === "reference-recovery-apply"
            ? ["--expected-proof", "--confirm"]
            : []),
          ...(verb === "convert-reference"
            ? ["--expected-recovery", "--confirm"]
            : []),
          ...(verb === "reference-conversion-inspect"
            ? ["--expected-recovery"]
            : []),
          ...(verb === "reference-diagnostic-inspect" ? ["--inspection"] : []),
          ...(verb === "reference-approve" ||
          verb === "reference-diagnostic-approve"
            ? ["--origin", "--expected-proof", "--confirm"]
            : []),
          ...(verb === "reference-download" ||
          verb === "reference-diagnostic-download"
            ? ["--expected-approval", "--confirm"]
            : []),
          ...(verb === "capture" ? ["--url"] : []),
          ...(verb === "artifact" ? ["--role", "--output"] : []),
          ...(verb === "recover"
            ? [
                "--failed-job-id",
                "--next-request-id",
                "--expected-proof",
                "--confirm",
              ]
            : []),
        ].includes(name)
      )
        throw new ApplicationError("INVALID_INPUT");
      options.set(name, value);
    }
    const project = options.get("--project");
    const requestId = options.get("--request-id");
    if (
      !project ||
      !/^capture_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        project,
      ) ||
      !requestId ||
      !validateContract("StableId", requestId).success ||
      (verb === "capture" && !options.has("--url")) ||
      (verb === "artifact" &&
        (!options.has("--role") || !options.has("--output")))
    )
      throw new ApplicationError("INVALID_INPUT");
    const role = options.get("--role");
    if (verb === "reference-fork-result") {
      const expectedReceipt = options.get("--expected-receipt");
      if (
        !expectedReceipt ||
        !validateContract("Sha256", expectedReceipt).success
      )
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: "figma-reference-fork-result",
        project,
        capture: {
          operation: "reference-fork-result",
          requestId,
          expectedReceipt,
        },
      };
    }
    if (verb === "reference-fork") {
      const expectedJob = options.get("--expected-job");
      const expectedRecovery = options.get("--expected-recovery");
      if (
        !expectedJob ||
        !expectedRecovery ||
        !validateContract("Sha256", expectedJob).success ||
        !validateContract("Sha256", expectedRecovery).success ||
        options.get("--confirm") !== REFERENCE_FORK_CONFIRMATION
      )
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: "figma-reference-fork",
        project,
        capture: {
          operation: "reference-fork",
          requestId,
          expectedJob,
          expectedRecovery,
          confirmation: REFERENCE_FORK_CONFIRMATION,
        },
      };
    }
    const offlineOperation = offlineOperations.find((value) => value === verb);
    if (offlineOperation) {
      const expectedJob = options.get("--expected-job");
      const expectedProof = options.get("--expected-proof");
      const expectedRecovery = options.get("--expected-recovery");
      const confirmation = options.get("--confirm");
      if (
        !expectedJob ||
        !validateContract("Sha256", expectedJob).success ||
        (offlineOperation === "reference-recovery-apply" &&
          (!validateContract("Sha256", expectedProof).success ||
            confirmation !== REFERENCE_RECOVERY_CONFIRMATION)) ||
        (offlineOperation === "convert-reference" &&
          (!validateContract("Sha256", expectedRecovery).success ||
            confirmation !== REFERENCE_CONVERSION_CONFIRMATION)) ||
        (offlineOperation === "reference-conversion-inspect" &&
          !validateContract("Sha256", expectedRecovery).success)
      )
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: `figma-${offlineOperation}`,
        project,
        capture: {
          operation: offlineOperation,
          requestId,
          expectedJob,
          ...(expectedProof ? { expectedProof } : {}),
          ...(expectedRecovery ? { expectedRecovery } : {}),
          ...(confirmation ? { confirmation } : {}),
        },
      };
    }
    if (verb === "reference-recovery-plan") {
      const expectedJob = options.get("--expected-job");
      if (!expectedJob || !validateContract("Sha256", expectedJob).success)
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: "figma-reference-recovery-plan",
        project,
        capture: {
          operation: "reference-recovery-plan",
          requestId,
          expectedJob,
        },
      };
    }
    const referenceOperation = referenceOperations.find(
      (value) => value === verb,
    );
    if (referenceOperation) {
      const diagnostic = referenceOperation.startsWith("reference-diagnostic-");
      const operation = diagnostic
        ? referenceOperation.replace("reference-diagnostic-", "reference-")
        : referenceOperation;
      const origin = options.get("--origin");
      const expectedProof = options.get("--expected-proof");
      const expectedApproval = options.get("--expected-approval");
      const confirmation = options.get("--confirm");
      const inspection = options.get("--inspection");
      if (
        (inspection !== undefined && inspection !== "metadata-only") ||
        (operation === "reference-approve" &&
          (origin !== "https://figma-alpha-api.s3.us-west-2.amazonaws.com" ||
            !validateContract("Sha256", expectedProof).success ||
            confirmation !==
              (diagnostic
                ? DIAGNOSTIC_APPROVAL_CONFIRMATION
                : REFERENCE_APPROVAL_CONFIRMATION))) ||
        (operation === "reference-download" &&
          (!validateContract("Sha256", expectedApproval).success ||
            confirmation !==
              (diagnostic
                ? DIAGNOSTIC_DOWNLOAD_CONFIRMATION
                : REFERENCE_DOWNLOAD_CONFIRMATION)))
      )
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: `figma-${referenceOperation}`,
        project,
        capture: {
          operation: referenceOperation,
          requestId,
          ...(origin ? { origin } : {}),
          ...(expectedProof ? { expectedProof } : {}),
          ...(expectedApproval ? { expectedApproval } : {}),
          ...(confirmation ? { confirmation } : {}),
          ...(inspection === "metadata-only" ? { inspection } : {}),
        },
      };
    }
    if (verb === "recover") {
      const failedJobId = options.get("--failed-job-id");
      const nextRequestId = options.get("--next-request-id");
      const expectedProof = options.get("--expected-proof");
      const confirmation = options.get("--confirm");
      if (
        !failedJobId ||
        !/^capture_[0-9a-f]{64}$/.test(failedJobId) ||
        !nextRequestId ||
        !validateContract("StableId", nextRequestId).success ||
        requestId === nextRequestId ||
        (expectedProof === undefined) !== (confirmation === undefined) ||
        (expectedProof !== undefined &&
          (!validateContract("Sha256", expectedProof).success ||
            confirmation !== CAPTURE_RECOVERY_CONFIRMATION))
      )
        throw new ApplicationError("INVALID_INPUT");
      return {
        command: "figma-recover",
        project,
        capture: {
          operation: "recover",
          requestId,
          failedJobId,
          nextRequestId,
          ...(expectedProof !== undefined ? { expectedProof } : {}),
          ...(confirmation !== undefined ? { confirmation } : {}),
        },
      };
    }
    const roles = [
      "metadata",
      "nodes",
      "render-map",
      "reference",
      "source",
      "manifest",
      "result",
      "design",
      "resources",
      "source-map",
      "conversion-evidence",
      "provenance",
      "report",
    ] as const;
    const selectedRole = roles.find((item) => item === role);
    if (role && !selectedRole) throw new ApplicationError("INVALID_INPUT");
    const operation = verb as NativeCaptureInput["operation"];
    const url = options.get("--url");
    const outputRelative = options.get("--output");
    return {
      command: `figma-${operation}`,
      project,
      capture: {
        operation,
        requestId,
        ...(url ? { url } : {}),
        ...(selectedRole ? { role: selectedRole } : {}),
        ...(outputRelative ? { outputRelative } : {}),
      },
    };
  }
  const flags = new Map<string, string | true>();
  for (let index = 2; index < args.length; index++) {
    const name = args[index];
    if (!name || flags.has(name)) throw new ApplicationError("INVALID_INPUT");
    if (["--new", "--interactive", "--json"].includes(name))
      flags.set(name, true);
    else if (
      ["--project", "--confirm-reference", "--expires-at"].includes(name)
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new ApplicationError("INVALID_INPUT");
      flags.set(name, value);
    } else throw new ApplicationError("INVALID_INPUT");
  }
  if (area === "project" && verb === "create") {
    if (
      !flags.has("--new") ||
      [...flags.keys()].some((key) => !["--new", "--json"].includes(key))
    )
      throw new ApplicationError("INVALID_INPUT");
    return { command: "project-create" };
  }
  if (
    area !== "credential" ||
    !verb ||
    !["setup", "status", "update", "remove"].includes(verb) ||
    flags.has("--new")
  )
    throw new ApplicationError("INVALID_INPUT");
  const project = flags.get("--project");
  const reference = flags.get("--confirm-reference");
  const pattern =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (
    typeof project !== "string" ||
    !new RegExp(`^capture_${pattern}$`).test(project) ||
    typeof reference !== "string" ||
    reference !== `figma_pat_${project.slice(8)}`
  )
    throw new ApplicationError("INVALID_INPUT");
  const input = verb === "setup" || verb === "update";
  if (input !== flags.has("--interactive") || (input && flags.has("--json")))
    throw new ApplicationError("INVALID_INPUT");
  const expires = flags.get("--expires-at");
  if (
    expires !== undefined &&
    (!input ||
      typeof expires !== "string" ||
      expires.length > 64 ||
      !validateContract("Timestamp", expires).success)
  )
    throw new ApplicationError("INVALID_INPUT");
  return {
    command: verb as Action,
    project,
    reference,
    ...(typeof expires === "string" ? { expires } : {}),
  };
}
function safeCode(error: unknown): ErrorCode {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    validateContract("ErrorCode", error.code).success
  )
    return error.code as ErrorCode;
  return "INTERNAL_ERROR";
}
const retainedCommands = new Set<NativeCaptureCommandCleanupRequired>();
const cleanupMessage = (operation: ErrorCode, cleanup: ErrorCode) =>
  `Operation ${operation}; cleanup ${cleanup}. Owned resources are retained; callback closure, secret cleanup and publication recovery are unconfirmed. Retry only this cleanup owner under current authority. Process exit is OS release, not recovery proof.`;
export class NativeCaptureCommandCleanupRequired extends Error {
  readonly code = "INTERRUPTED";
  private closing: Promise<void> | undefined;
  private closed = false;
  constructor(
    private readonly envelope: NativeEnvelope,
    readonly operationCode: ErrorCode,
    private currentCleanupCode: ErrorCode,
    private readonly release: () => Promise<void>,
  ) {
    super(
      "Native command cleanup is unconfirmed; this owner retains its resources.",
    );
    retainedCommands.add(this);
  }
  get cleanupCode(): ErrorCode {
    return this.currentCleanupCode;
  }
  get result(): NativeEnvelope {
    const result = structuredClone(this.envelope);
    if (result.error)
      result.error.message = cleanupMessage(
        this.operationCode,
        this.currentCleanupCode,
      );
    return result;
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = this.release()
      .then(() => {
        this.closed = true;
        retainedCommands.delete(this);
      })
      .catch((error: unknown) => {
        this.currentCleanupCode =
          error instanceof NativeCaptureCleanupRequired
            ? error.cleanupCode
            : safeCode(error);
        throw this;
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}
export async function runCaptureCommand(args: readonly string[]) {
  const request = parseCaptureArguments(args);
  if (request.command === "help")
    return {
      status: "complete",
      profile: "figma-capture-v1",
      usage: [
        "project create --new [--json]",
        "credential status|remove --project <ID> --confirm-reference <REF> [--json]",
        "credential setup|update --project <ID> --confirm-reference <REF> --interactive [--expires-at <ISO timestamp>]",
        "figma capture --project <ID> --url <single-frame URL> --request-id <logical ID>",
        "figma inspect|convert --project <ID> --request-id <logical ID>",
        "figma artifact --project <ID> --request-id <logical ID> --role <artifact role> --output <private filename>",
        "figma recover --project <ID> --request-id <failed request> --failed-job-id <failed job> --next-request-id <next request> [--expected-proof <SHA256> --confirm AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA]",
        "figma reference-plan|reference-inspect --project <ID> --request-id <original capture request>",
        "figma reference-approve --project <ID> --request-id <original capture request> --origin https://figma-alpha-api.s3.us-west-2.amazonaws.com --expected-proof <SHA256> --confirm APPROVE-ONE-SELECTED-REFERENCE",
        "figma reference-download --project <ID> --request-id <original capture request> --expected-approval <SHA256> --confirm DOWNLOAD-ONE-APPROVED-REFERENCE",
        "figma reference-diagnostic-plan|reference-diagnostic-inspect --project <ID> --request-id <original capture request>",
        "figma reference-diagnostic-inspect --project <ID> --request-id <original capture request> --inspection metadata-only",
        "figma reference-diagnostic-approve --project <ID> --request-id <original capture request> --origin https://figma-alpha-api.s3.us-west-2.amazonaws.com --expected-proof <SHA256> --confirm APPROVE-ONE-DIAGNOSTIC-REFERENCE",
        "figma reference-diagnostic-download --project <ID> --request-id <original capture request> --expected-approval <SHA256> --confirm DOWNLOAD-ONE-DIAGNOSTIC-REFERENCE",
        "figma reference-recovery-plan --project <ID> --request-id <original capture request> --expected-job <Job SHA256>",
        "figma reference-recovery-apply-plan|reference-recovery-inspect --project <ID> --request-id <original capture request> --expected-job <Job SHA256>",
        "figma reference-conversion-inspect --project <ID> --request-id <original capture request> --expected-job <Job SHA256> --expected-recovery <recovery receipt SHA256>",
        "figma reference-recovery-apply --project <ID> --request-id <original capture request> --expected-job <Job SHA256> --expected-proof <current v7 plan SHA256> --confirm RECOVER-VERIFIED-REFERENCE-OFFLINE",
        "figma convert-reference --project <ID> --request-id <original capture request> --expected-job <Job SHA256> --expected-recovery <recovery receipt SHA256> --confirm CONVERT-WITH-RECOVERED-REFERENCE",
        "figma reference-fork --project <SOURCE ID> --request-id <original capture request> --expected-job <Job SHA256> --expected-recovery <recovery receipt SHA256> --confirm FORK-VERIFIED-INPUTS-AND-CONVERT-OFFLINE",
        "figma reference-fork-result --project <DESTINATION ID> --request-id <ID> --expected-receipt <fork receipt SHA256>",
      ],
      limitation:
        "Native entry needs an independently approved capture release. Setup/update display an app-owned masked Figma PAT dialog; status reads one owned vault entry; remove deletes only the explicitly confirmed entry. Capture allows at most four calls in 30 seconds. The default empty download-origin policy yields a partial result before CDN contact. Inspection is private metadata only; explicit artifact output stays in the owned private project. Conversion is an unapproved draft, never render-readiness. Recovery additionally requires the installed recovery supplement: it records one exact next-request authorization offline, not a retry, quota assertion, or capture result. Third requests remain blocked. Offline reference apply migrates to schema 5 and seals the project against unrelated mutations: one recovery slot and its explicit convert-reference operation only; historical reads and backup remain available, but ordinary staging/commits/jobs/revisions/pin changes and maintenance deletion are blocked.",
    };
  if (retainedCommands.size) throw new ApplicationError("ACTION_REQUIRED");
  let installation: CaptureInstallationLease | undefined;
  let guard: { close(): void } | undefined;
  let project: CaptureProject | undefined;
  let credentials:
    | Awaited<ReturnType<typeof openCaptureCredentials>>
    | undefined;
  let dialog: PatDialogRun | undefined;
  let runtime: NativeCaptureRuntime | undefined;
  let validation:
    | Awaited<ReturnType<typeof openNativeReferenceValidation>>
    | undefined;
  let offline:
    | Awaited<ReturnType<typeof openNativeReferenceOffline>>
    | undefined;
  let fork: ReturnType<typeof openNativeReferenceFork> | undefined;
  let forkResult: ReturnType<typeof openNativeReferenceForkResult> | undefined;
  let startupCleanup: (() => Promise<void>) | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let result: unknown;
  let primary: ErrorCode | undefined;
  let cleanupFailure: NativeCaptureCommandCleanupRequired | undefined;
  try {
    installation = await verifyCaptureInstallation();
    guard = registerCaptureInstallationGuards(installation);
    if (request.command === "figma-recover")
      assertCaptureRecoveryInstallation(installation);
    if (request.command === "figma-reference-recovery-plan")
      assertReferenceValidationInstallation(installation);
    if (request.capture && isOffline(request.capture))
      assertReferenceOfflineInstallation(installation);
    if (request.capture?.operation === "reference-conversion-inspect")
      assertReferenceConversionInspectionInstallation(installation);
    if (
      request.capture?.operation === "reference-fork" ||
      request.capture?.operation === "reference-fork-result"
    )
      assertReferenceForkInstallation(installation);
    if (request.capture && isReference(request.capture))
      assertCaptureReferenceInstallation(installation);
    if (
      request.capture &&
      isReference(request.capture) &&
      request.capture.operation.startsWith("reference-diagnostic-")
    )
      assertCaptureDiagnosticInstallation(installation);
    if (abort.signal.aborted) throw new ApplicationError("CANCELLED");
    project = await openCaptureProject(
      installation,
      request.command === "project-create" ? undefined : request.project,
    );
    if (request.command === "project-create") {
      result = {
        status: "complete",
        operation: "project-create",
        projectId: project.projectId,
        reference: project.reference,
        privateRoot: path.dirname(project.paths.database),
      };
    } else if (request.capture) {
      if (request.capture.operation === "reference-fork-result") {
        forkResult = openNativeReferenceForkResult(project);
        result = await forkResult.execute(request.capture, abort.signal);
      } else if (request.capture.operation === "reference-fork") {
        const installed = installation;
        fork = openNativeReferenceFork(project, () =>
          openCaptureProject(installed),
        );
        result = await fork.execute(request.capture, abort.signal);
      } else if (isOffline(request.capture)) {
        offline =
          request.capture.operation === "reference-conversion-inspect"
            ? await openNativeReferenceConversionInspection(project)
            : await openNativeReferenceOffline(project);
        result = await offline.execute(request.capture, abort.signal);
      } else if (request.capture.operation === "reference-recovery-plan") {
        validation = await openNativeReferenceValidation(project);
        result = await validation.execute(request.capture, abort.signal);
      } else {
        runtime = await openNativeCapture(project);
        result = isReference(request.capture)
          ? runtime.reference
            ? await runtime.reference(request.capture, abort.signal)
            : (() => {
                throw new ApplicationError("FORBIDDEN");
              })()
          : request.capture.operation === "recover"
            ? await runtime.recover(request.capture, abort.signal)
            : await runtime.execute(request.capture, abort.signal);
      }
    } else {
      if (!["setup", "status", "update", "remove"].includes(request.command))
        throw new ApplicationError("INVALID_INPUT");
      credentials = await openCaptureCredentials(project);
      let secret: Buffer | undefined;
      try {
        if (request.command === "setup" || request.command === "update") {
          process.stderr.write(
            `Opening an app-owned Figma PAT dialog for ${project.projectId}, reference ${project.reference.id}. Do not enter a Windows password.\n`,
          );
          dialog = startCapturePatDialog(project, abort.signal);
          secret = await dialog.result;
        }
        const pending = setTimeout(() => {
          process.stderr.write(
            "Native credential work is still pending. Original vault work and private project ownership remain held until actual settlement; cancellation is not cleanup proof.\n",
          );
        }, 30_000);
        try {
          result = await credentials.execute(
            request.command as Action,
            request.reference ?? "",
            abort.signal,
            secret,
            request.expires
              ? { declaredExpiresAt: request.expires }
              : undefined,
          );
        } finally {
          clearTimeout(pending);
        }
      } finally {
        secret?.fill(0);
      }
    }
  } catch (error) {
    primary = safeCode(error);
    if (
      error instanceof CaptureStartupCleanupRequired ||
      error instanceof NativeCaptureStartupCleanupRequired
    )
      startupCleanup = error.close;
  } finally {
    if (request.capture && request.project) {
      const release = async () => {
        if (startupCleanup) {
          await startupCleanup();
          startupCleanup = undefined;
        }
        await runtime?.close();
        await validation?.close();
        await offline?.close();
        await fork?.close();
        await forkResult?.close();
        await project?.close();
        guard?.close();
        await installation?.close();
      };
      try {
        await release();
      } catch (error) {
        const prior = validateContract(envelopeKind(request.capture), result);
        const operationCode =
          primary ??
          (error instanceof NativeCaptureCleanupRequired
            ? error.operationCode
            : prior.success
              ? prior.value.error?.code
              : undefined) ??
          "INTERRUPTED";
        const cleanupCode =
          error instanceof NativeCaptureCleanupRequired
            ? error.cleanupCode
            : safeCode(error);
        const envelopeBase = {
          schemaVersion: "1.0" as const,
          projectId: request.project,
          requestId: request.capture.requestId,
          error: {
            code: "INTERRUPTED" as const,
            message: cleanupMessage(operationCode, cleanupCode),
            retryable: false,
            diagnosticIds: [],
          },
        };
        const envelope: NativeEnvelope =
          request.capture.operation === "reference-fork-result"
            ? {
                ...envelopeBase,
                operation: "reference-fork-result",
                status: "failed",
                inputAccounting: forkResult?.failureResult?.inputAccounting ?? {
                  limitBytes: 26214400,
                  privateBytes: 0,
                  networkBytes: 0,
                  phase: "proof",
                },
              }
            : request.capture.operation === "reference-fork"
              ? {
                  ...envelopeBase,
                  operation: "reference-fork",
                  status: "failed",
                  inputAccounting: fork?.failureResult?.inputAccounting ?? {
                    limitBytes: 26214400,
                    privateBytes: 0,
                    networkBytes: 0,
                    phase: "proof" as const,
                  },
                  ...(fork?.failureResult?.destinationProjectId
                    ? {
                        destinationProjectId:
                          fork.failureResult.destinationProjectId,
                        partialDestination: "blocked-no-replay" as const,
                      }
                    : {}),
                }
              : {
                  ...envelopeBase,
                  operation: request.capture.operation,
                  status: "interrupted",
                  ...(request.capture.operation ===
                  "reference-conversion-inspect"
                    ? {
                        inspection: {
                          verification: "conversion-readonly-v1" as const,
                          state: "blocked" as const,
                          detail: "verification-incomplete" as const,
                        },
                      }
                    : {}),
                };
        cleanupFailure = new NativeCaptureCommandCleanupRequired(
          envelope,
          operationCode,
          cleanupCode,
          release,
        );
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    } else {
      let warned = false;
      for (;;) {
        try {
          if (dialog && !(await dialog.close()).closed) {
            if (!warned)
              process.stderr.write(
                "PAT helper cleanup is incomplete. This process retains the private project until owned helper exit is observed; no credential result is being delivered.\n",
              );
            warned = true;
            primary ??= "INTERRUPTED";
            await sleep(250);
            continue;
          }
          if (startupCleanup) {
            await startupCleanup();
            startupCleanup = undefined;
          }
          await runtime?.close();
          await validation?.close();
          await offline?.close();
          await fork?.close();
          await forkResult?.close();
          credentials?.close();
          await project?.close();
          guard?.close();
          await installation?.close();
          break;
        } catch {
          primary ??= "INTERRUPTED";
          if (!warned)
            process.stderr.write(
              "Native cleanup failed; ownership is retained for cleanup retry. No successful credential operation is reported.\n",
            );
          warned = true;
          await sleep(250);
        }
      }
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (primary && request.capture && request.project) {
    const checked = validateContract(envelopeKind(request.capture), {
      schemaVersion: "1.0",
      operation: request.capture.operation,
      projectId: request.project,
      requestId: request.capture.requestId,
      status:
        request.capture.operation === "reference-fork" ||
        request.capture.operation === "reference-fork-result"
          ? "failed"
          : primary === "CANCELLED"
            ? "cancelled"
            : primary === "INTERRUPTED"
              ? "interrupted"
              : "failed",
      ...(request.capture.operation === "reference-fork"
        ? {
            inputAccounting: fork?.failureResult?.inputAccounting ?? {
              limitBytes: 26214400,
              privateBytes: 0,
              networkBytes: 0,
              phase: "proof" as const,
            },
            ...(fork?.failureResult?.destinationProjectId
              ? {
                  destinationProjectId: fork.failureResult.destinationProjectId,
                  partialDestination: "blocked-no-replay" as const,
                }
              : {}),
          }
        : {}),
      ...(request.capture.operation === "reference-fork-result"
        ? {
            inputAccounting: forkResult?.failureResult?.inputAccounting ?? {
              limitBytes: 26214400,
              privateBytes: 0,
              networkBytes: 0,
              phase: "proof",
            },
          }
        : {}),
      ...(request.capture.operation === "reference-conversion-inspect"
        ? {
            inspection: {
              verification: "conversion-readonly-v1" as const,
              state: "blocked" as const,
              detail: "verification-incomplete" as const,
            },
          }
        : {}),
      error: {
        code: primary,
        message:
          "Native capture or cleanup did not complete. Inspect the logical request before any retry.",
        retryable: false,
        diagnosticIds: [],
      },
    });
    if (!checked.success) throw new ApplicationError("INTERNAL_ERROR");
    return checked.value;
  }
  return primary
    ? {
        status: primary === "CANCELLED" ? "cancelled" : "failed",
        error: {
          code: primary,
          message:
            "Native capture credential command did not complete; its owned entry may have changed. Use a separately authorized status read.",
        },
      }
    : result;
}
async function main() {
  try {
    const result = await runCaptureCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode =
      result &&
      typeof result === "object" &&
      "status" in result &&
      (result.status === "complete" || result.status === "accepted")
        ? 0
        : result &&
            typeof result === "object" &&
            "status" in result &&
            result.status === "partial"
          ? 4
          : 1;
  } catch (error) {
    if (error instanceof NativeCaptureCommandCleanupRequired) {
      process.stdout.write(`${JSON.stringify(error.result)}\n`);
      process.stderr.write(
        "Native cleanup ownership remains retained. No automatic retry is running; process exit does not prove publication recovery or secret cleanup.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      '{"status":"failed","error":{"code":"INVALID_INPUT","message":"Invalid native capture command."}}\n',
    );
    process.exitCode = 2;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main();
