import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ApplicationError } from "@design-studio/application";
import { type ErrorCode, validateContract } from "@design-studio/contracts";
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
  command: "help" | "project-create" | Action;
  project?: string;
  reference?: string;
  expires?: string;
}
export function parseCaptureArguments(
  argv: readonly string[],
): NativeArguments {
  const args = [...argv];
  if (args.length === 0 || (args.length === 1 && args[0] === "--help"))
    return { command: "help" };
  if (
    args.length > 12 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 256)
  )
    throw new ApplicationError("INVALID_INPUT");
  const [area, verb] = args;
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
      ],
      limitation:
        "Native entry needs an independently approved capture release. Setup/update display an app-owned masked Figma PAT dialog; status reads one owned vault entry; remove deletes only the explicitly confirmed entry. No network capture is enabled.",
    };
  let installation: CaptureInstallationLease | undefined;
  let guard: { close(): void } | undefined;
  let project: CaptureProject | undefined;
  let credentials:
    | Awaited<ReturnType<typeof openCaptureCredentials>>
    | undefined;
  let dialog: PatDialogRun | undefined;
  let startupCleanup: (() => Promise<void>) | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let result: unknown;
  let primary: ErrorCode | undefined;
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
    } else {
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
            request.command,
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
    if (error instanceof CaptureStartupCleanupRequired)
      startupCleanup = error.close;
  } finally {
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
      result.status === "complete"
        ? 0
        : 1;
  } catch {
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
