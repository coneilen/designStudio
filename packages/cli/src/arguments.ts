import { parseArgs } from "node:util";
import {
  ApplicationError,
  COMMANDS,
  type Command,
  PROJECT_ID,
} from "@design-studio/application";
import { validateContract } from "@design-studio/contracts";

const options = {
  json: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
  project: { type: "string" },
  mode: { type: "string" },
  "timeout-ms": { type: "string" },
  branch: { type: "string" },
  design: { type: "string" },
  "expected-base": { type: "string" },
  "if-match": { type: "string" },
  new: { type: "boolean" },
  "request-id": { type: "string" },
  "render-mode": { type: "string" },
  async: { type: "boolean" },
  sha256: { type: "string" },
  "output-root": { type: "string" },
  "output-relative": { type: "string" },
  "session-fd": { type: "string" },
  "control-fd": { type: "string" },
  port: { type: "string" },
} as const;
export interface Arguments {
  command: Command;
  id?: string;
  values: ReturnType<typeof valuesFor>;
  timeoutMs: number;
  child: string[];
}
function valuesFor(argv: string[]) {
  return parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
}
export function parseArguments(argv: string[]): Arguments {
  try {
    const separator = argv.indexOf("--");
    const child = separator >= 0 ? argv.slice(separator + 1) : [];
    const parsed = valuesFor(separator >= 0 ? argv.slice(0, separator) : argv);
    const seen = new Set<string>();
    for (const token of parsed.tokens)
      if (token.kind === "option") {
        if (seen.has(token.name)) throw new Error();
        seen.add(token.name);
      }
    const p = parsed.positionals;
    const two = `${p[0]} ${p[1]}`;
    const named =
      COMMANDS.find((candidate) => candidate === two) ??
      COMMANDS.find((candidate) => candidate === p[0]);
    if (
      parsed.values.help &&
      p.length > 0 &&
      (!named || p.length !== (named.includes(" ") ? 2 : 1))
    )
      throw new Error();
    const command = parsed.values.help
      ? "help"
      : parsed.values.version
        ? "version"
        : named;
    if (!command) throw new Error();
    const count = command.includes(" ")
      ? 2
      : parsed.values.help || parsed.values.version
        ? parsed.values.help
          ? p.length
          : 0
        : 1;
    const takesId = [
      "fixtures accept",
      "designs get",
      "revisions get",
      "render",
      "jobs get",
      "jobs wait",
      "jobs cancel",
      "artifacts get",
      "preview",
    ].includes(command);
    if (p.length !== count + (takesId ? 1 : 0)) throw new Error();
    const id = takesId ? p[count] : undefined;
    if (id !== undefined && !validateContract("StableId", id).success)
      throw new Error();
    if (
      parsed.values.project !== undefined &&
      parsed.values.project !== PROJECT_ID
    )
      throw new Error();
    if (
      parsed.values.mode !== undefined &&
      !["local", "api"].includes(parsed.values.mode)
    )
      throw new Error();
    if (
      parsed.values["render-mode"] !== undefined &&
      !["strict", "inspection"].includes(parsed.values["render-mode"])
    )
      throw new Error();
    const timeoutText = parsed.values["timeout-ms"] ?? "30000";
    if (!/^[1-9][0-9]*$/.test(timeoutText)) throw new Error();
    const timeoutMs = Number(timeoutText);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 30000)
      throw new Error();
    if (command !== "with-session" && separator >= 0) throw new Error();
    if (command === "with-session" && child.length === 0) throw new Error();
    const shared = ["json", "project", "mode", "timeout-ms"];
    const permitted: Partial<Record<Command, string[]>> = {
      "fixtures accept": [
        "design",
        "branch",
        "expected-base",
        "if-match",
        "new",
        "request-id",
      ],
      "designs get": ["branch"],
      render: ["branch", "render-mode", "async", "request-id"],
      "jobs cancel": ["if-match", "request-id"],
      "artifacts get": ["sha256", "output-root", "output-relative"],
      serve: ["port", "control-fd"],
      help: ["help"],
      version: ["version"],
    };
    for (const key of seen)
      if (
        !shared.includes(key) &&
        !permitted[command]?.includes(key) &&
        !(key === "session-fd" && parsed.values.mode === "api")
      )
        throw new Error();
    const values = parsed.values;
    if (
      ["fixtures accept", "render", "jobs cancel"].includes(command) &&
      !validateContract("StableId", values["request-id"]).success
    )
      throw new Error();
    if (
      values.branch !== undefined &&
      !validateContract("StableId", values.branch).success
    )
      throw new Error();
    if (command === "fixtures accept") {
      if (values.new) {
        if (values["expected-base"] || values["if-match"]) throw new Error();
      } else if (
        !validateContract("ExpectedBase", {
          expectedBaseRevision: values["expected-base"],
          ifMatch: values["if-match"],
        }).success
      )
        throw new Error();
    }
    if (command === "jobs cancel") {
      const match = /^"job:([A-Za-z0-9._-]+):([1-9][0-9]*)"$/.exec(
        values["if-match"] ?? "",
      );
      if (!match || match[1] !== id || !Number.isSafeInteger(Number(match[2])))
        throw new Error();
    }
    if (command === "artifacts get") {
      if (!validateContract("Sha256", values.sha256).success) throw new Error();
      if (
        (values["output-root"] !== undefined ||
          values["output-relative"] !== undefined) &&
        (values["output-root"] !== "foundation_outputs" ||
          !validateContract("RelativePath", values["output-relative"]).success)
      )
        throw new Error();
    }
    return { command, ...(id ? { id } : {}), values: parsed, timeoutMs, child };
  } catch {
    throw new ApplicationError("INVALID_INPUT");
  }
}
