import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationError } from "@design-studio/application";
import {
  NativeCaptureCleanupRequired,
  type NativeCaptureInput,
  type NativeCaptureRuntime,
  NativeCaptureStartupCleanupRequired,
  openNativeCapture,
} from "@design-studio/application/capture";
import {
  type ErrorCode,
  type NativeCaptureEnvelope,
  validateContract,
} from "@design-studio/contracts";
import {
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
interface NativeArguments {
  command:
    | "help"
    | "project-create"
    | Action
    | "figma-capture"
    | "figma-inspect"
    | "figma-convert"
    | "figma-artifact";
  project?: string;
  reference?: string;
  expires?: string;
  capture?: NativeCaptureInput;
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
    if (!verb || !["capture", "inspect", "convert", "artifact"].includes(verb))
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
          ...(verb === "capture" ? ["--url"] : []),
          ...(verb === "artifact" ? ["--role", "--output"] : []),
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
    private readonly envelope: NativeCaptureEnvelope,
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
  get result(): NativeCaptureEnvelope {
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
      ],
      limitation:
        "Native entry needs an independently approved capture release. Setup/update display an app-owned masked Figma PAT dialog; status reads one owned vault entry; remove deletes only the explicitly confirmed entry. Capture allows at most four calls in 30 seconds. The default empty download-origin policy yields a partial result before CDN contact. Inspection is private metadata only; explicit artifact output stays in the owned private project. Conversion is an unapproved draft, never render-readiness.",
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
      runtime = await openNativeCapture(project);
      result = await runtime.execute(request.capture, abort.signal);
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
        await project?.close();
        guard?.close();
        await installation?.close();
      };
      try {
        await release();
      } catch (error) {
        const prior = validateContract("NativeCaptureEnvelope", result);
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
        const envelope: NativeCaptureEnvelope = {
          schemaVersion: "1.0",
          operation: request.capture.operation,
          projectId: request.project,
          requestId: request.capture.requestId,
          status: "interrupted",
          error: {
            code: "INTERRUPTED",
            message: cleanupMessage(operationCode, cleanupCode),
            retryable: false,
            diagnosticIds: [],
          },
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
    const checked = validateContract("NativeCaptureEnvelope", {
      schemaVersion: "1.0",
      operation: request.capture.operation,
      projectId: request.project,
      requestId: request.capture.requestId,
      status:
        primary === "CANCELLED"
          ? "cancelled"
          : primary === "INTERRUPTED"
            ? "interrupted"
            : "failed",
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
