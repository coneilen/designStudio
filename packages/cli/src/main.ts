#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import {
  ApplicationError,
  commandHelp,
  describeApi,
  doctor,
  exitCode,
  failure,
  safeError,
  success,
} from "@design-studio/application";
import type { ResponseEnvelope } from "@design-studio/contracts";
import { parseArguments } from "./arguments.js";
import { PrivateChannel } from "./channel.js";
import { usingProject } from "./cleanup.js";
import { callApi } from "./client.js";
import { writeOutput } from "./output.js";

const requestId = randomUUID();
let failureRequestId: string = requestId;
let result: ResponseEnvelope;
let json = process.argv.slice(2).includes("--json");
let wait = false;
let selectedExit: number | undefined;
try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "serve") failureRequestId = "service_stop";
  json = args.values.values.json ?? false;
  wait =
    args.command === "jobs wait" ||
    (args.command === "render" && !args.values.values.async);
  if (
    args.values.values.mode === "api" &&
    args.command !== "help" &&
    args.command !== "version"
  ) {
    if (args.values.values["session-fd"] !== "3")
      throw new ApplicationError("AUTH_REQUIRED", 401);
    const channel = new PrivateChannel(
      new Socket({ fd: 3, readable: true, writable: true }),
    );
    try {
      const value = await channel.read(Math.min(5000, args.timeoutMs));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "credential,kind,port" ||
        value.kind !== "session" ||
        typeof value.port !== "number" ||
        typeof value.credential !== "string"
      )
        throw new ApplicationError("AUTH_REQUIRED", 401);
      const connection = {
        port: value.port,
        credential: value.credential,
      };
      if (
        args.command === "artifacts get" &&
        args.values.values["output-root"]
      ) {
        const { openInstalledProject } = await import(
          "@design-studio/application/installed"
        );
        const project = await openInstalledProject();
        result = await usingProject(project, () =>
          callApi(args, connection, project.publish),
        );
      } else result = await callApi(args, connection);
    } finally {
      channel.close();
    }
  } else
    switch (args.command) {
      case "help":
        result = success(requestId, {
          kind: "help",
          command: args.values.positionals.join(" ") || "designctl",
          usage: commandHelp(args.values.positionals.join(" ")),
          warnings: [],
        });
        break;
      case "version":
        result = success(requestId, {
          kind: "version",
          cliVersion: "1.0.0",
          contractVersion: "1.3.0",
          apiVersion: "v1",
          warnings: [],
        });
        break;
      case "doctor":
        if (args.values.values.mode === "api")
          throw new ApplicationError("AUTH_REQUIRED", 401);
        result = success(requestId, {
          kind: "capabilities",
          capabilities: doctor(),
          warnings: [],
        });
        break;
      case "openapi":
        if (args.values.values.mode === "api")
          throw new ApplicationError("AUTH_REQUIRED", 401);
        result = describeApi(requestId);
        break;
      case "serve": {
        if (args.values.values["control-fd"] !== "3")
          throw new ApplicationError("ACTION_REQUIRED", 409);
        const text = args.values.values.port ?? "0";
        if (!/^(0|[1-9][0-9]*)$/.test(text) || Number(text) > 65535)
          throw new ApplicationError("INVALID_INPUT");
        const service = await import("./service.js");
        result = await service.serve(
          Number(text),
          args.values.values["control-fd"],
        );
        break;
      }
      case "with-session": {
        const child = parseArguments(args.child);
        if (
          ["serve", "with-session", "fixtures init"].includes(child.command) ||
          child.values.values.async
        )
          throw new ApplicationError("INVALID_INPUT");
        json = json || (child.values.values.json ?? false);
        const { launchLocalSession } = await import("./launcher.js");
        const session = await launchLocalSession();
        result = await usingProject(
          {
            close: async () => {
              await session.close();
              return true;
            },
          },
          async () => {
            const output = await session.runCli(args.child);
            selectedExit = output.exitCode;
            return output.envelope;
          },
        );
        break;
      }
      default: {
        if (args.values.values.async)
          throw new ApplicationError("ACTION_REQUIRED", 409);
        const { openInstalledProject } = await import(
          "@design-studio/application/installed"
        );
        const project = await openInstalledProject(
          args.command === "fixtures init",
        );
        result = await usingProject(project, async () => {
          if (args.command === "fixtures init") {
            const report = doctor();
            report.operations.push({
              operation: "fixture-binding",
              availability: "available",
              evidence: "observed",
              limitations: [
                "Explicitly created a new private synthetic fixture project; no approval or handoff was created.",
              ],
            });
            return success(requestId, {
              kind: "capabilities",
              capabilities: report,
              warnings: [],
            });
          } else {
            const { callLocal } = await import("./local.js");
            return callLocal(
              args,
              await project.application(),
              project.publish,
            );
          }
        });
      }
    }
} catch (error) {
  selectedExit = undefined;
  const safe = safeError(error);
  result = failure(failureRequestId, safe.code, safe.jobId);
}
process.exitCode = selectedExit ?? exitCode(result, wait);
try {
  await writeOutput(result, json);
} catch {
  process.exitCode = 1;
}
