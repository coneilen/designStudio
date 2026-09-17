import { randomUUID } from "node:crypto";
import {
  ApplicationError,
  type ApplicationResult,
  failure,
  type Invocation,
  matchRoute,
  PROJECT_ID,
  safeError,
} from "@design-studio/application";
import type { Arguments } from "./arguments.js";
import { type DownloadPublisher, dispatchCommand } from "./client.js";

export async function callLocal(
  args: Arguments,
  application: {
    call(request: Invocation, signal?: AbortSignal): Promise<ApplicationResult>;
  },
  publish?: DownloadPublisher,
) {
  if (args.values.values.async)
    throw new ApplicationError("ACTION_REQUIRED", 409);
  async function invoke(
    path: string,
    method: string,
    timeout: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const route = matchRoute(path, method, PROJECT_ID);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await application.call(
        {
          operation: route.route?.operation ?? "openapi",
          projectId: PROJECT_ID,
          requestId: headers["Idempotency-Key"] ?? randomUUID(),
          parameters: route.parameters,
          ...(route.id ? { id: route.id } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(headers["If-Match"] ? { ifMatch: headers["If-Match"] } : {}),
          ...(headers["If-None-Match"]
            ? { ifNoneMatch: headers["If-None-Match"] }
            : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new ApplicationError("DEADLINE_EXCEEDED", 504);
      return result;
    } catch (error) {
      if (controller.signal.aborted)
        throw new ApplicationError("DEADLINE_EXCEEDED", 504);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return dispatchCommand(
    args,
    {
      async json(path, method, timeout, body, headers) {
        try {
          const result = await invoke(path, method, timeout, body, headers);
          if (result.kind !== "json")
            throw new ApplicationError("INVALID_SCHEMA");
          return result.envelope;
        } catch (error) {
          const safe = safeError(error);
          return failure(
            headers?.["Idempotency-Key"] ?? randomUUID(),
            safe.code,
            safe.jobId,
          );
        }
      },
      async receive(path, method, timeout, body, headers, mediaType, parse) {
        const result = await invoke(path, method, timeout, body, headers);
        if (result.kind !== "binary" || result.mediaType !== mediaType)
          throw new ApplicationError("INVALID_SCHEMA");
        return parse(result.bytes);
      },
    },
    publish,
  );
}
