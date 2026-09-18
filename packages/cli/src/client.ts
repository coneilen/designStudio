import { createHash } from "node:crypto";
import { request } from "node:http";
import {
  ApplicationError,
  type CommandOperation,
  checkCommandOperation,
  createCommandLifetime,
  describeApi,
  draftWarning,
  PROJECT_ID,
  remainingCommandMs,
  success,
} from "@design-studio/application";
import { downloadResult } from "@design-studio/application/download";
import {
  type Artifact,
  parseContract,
  type ResponseEnvelope,
  validateContract,
} from "@design-studio/contracts";
import type { Arguments } from "./arguments.js";

export interface LocalSession {
  port: number;
  credential: string;
}
export type DownloadPublisher = (
  artifact: Artifact,
  bytes: Uint8Array,
  relative: string,
  operation: CommandOperation,
) => Promise<Artifact>;
export interface CommandConnection {
  json(
    path: string,
    method: string,
    timeout: number,
    body: unknown,
    headers: Record<string, string> | undefined,
    operation: CommandOperation,
  ): Promise<ResponseEnvelope>;
  receive<T>(
    path: string,
    method: string,
    timeout: number,
    body: unknown,
    headers: Record<string, string>,
    mediaType: string,
    parse: (bytes: Uint8Array) => T,
    operation: CommandOperation,
  ): Promise<T>;
}
export async function callApi(
  args: Arguments,
  session: LocalSession,
  publish?: DownloadPublisher,
  signal?: AbortSignal,
): Promise<ResponseEnvelope> {
  if (
    !Number.isInteger(session.port) ||
    session.port < 1 ||
    session.port > 65535 ||
    !/^[A-Za-z0-9_-]{43}$/.test(session.credential)
  )
    throw new ApplicationError("AUTH_REQUIRED", 401);
  return dispatchCommand(
    args,
    {
      json: (path, method, timeout, body, headers, operation) =>
        send(session, path, method, timeout, body, headers, operation),
      receive: (
        path,
        method,
        timeout,
        body,
        headers,
        mediaType,
        parse,
        operation,
      ) =>
        receive(
          session,
          path,
          method,
          timeout,
          body,
          headers,
          mediaType,
          parse,
          operation,
        ),
    },
    publish,
    signal,
  );
}
export async function dispatchCommand(
  args: Arguments,
  connection: CommandConnection,
  publish?: DownloadPublisher,
  signal?: AbortSignal,
): Promise<ResponseEnvelope> {
  const lifetime = createCommandLifetime(args.timeoutMs, signal);
  try {
    return await dispatchWithinOperation(
      args,
      connection,
      lifetime.operation,
      publish,
    );
  } finally {
    lifetime.close();
  }
}
async function dispatchWithinOperation(
  args: Arguments,
  connection: CommandConnection,
  operation: CommandOperation,
  publish?: DownloadPublisher,
): Promise<ResponseEnvelope> {
  const values = args.values.values;
  const remaining = () => remainingCommandMs(operation);
  const prefix = `/v1/projects/${PROJECT_ID}`;
  const requestKey = () => {
    if (
      !values["request-id"] ||
      !validateContract("StableId", values["request-id"]).success
    )
      throw new ApplicationError("INVALID_INPUT");
    return values["request-id"];
  };
  const get = (suffix: string) =>
    connection.json(
      `${prefix}${suffix}`,
      "GET",
      remaining(),
      undefined,
      undefined,
      operation,
    );
  const post = (
    suffix: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    connection.json(
      `${prefix}${suffix}`,
      "POST",
      remaining(),
      body,
      {
        "Idempotency-Key": requestKey(),
        ...headers,
      },
      operation,
    );
  switch (args.command) {
    case "openapi": {
      const description = describeApi("openapi");
      if (!description.success || description.data.kind !== "api-description")
        throw new ApplicationError("INTERNAL_ERROR");
      const expectedHash = description.data.documentSha256;
      return connection.receive(
        "/v1/openapi.json",
        "GET",
        remaining(),
        undefined,
        {},
        "application/json",
        (bytes) => {
          if (createHash("sha256").update(bytes).digest("hex") === expectedHash)
            return description;
          const failure = validateContract(
            "ResponseEnvelope",
            parseContract(
              "JsonValue",
              Buffer.from(bytes).toString("utf8"),
              "json",
            ),
          );
          if (failure.success && !failure.value.success) return failure.value;
          throw new ApplicationError("PROFILE_MISMATCH", 409);
        },
        operation,
      );
    }
    case "doctor":
      return get("/doctor");
    case "designs get":
      return get(
        `/designs/${args.id}?branch=${identifier(values.branch ?? "main")}`,
      );
    case "revisions get":
      return get(`/revisions/${args.id}`);
    case "jobs get":
      return get(`/jobs/${args.id}`);
    case "jobs wait":
      return get(`/jobs/${args.id}/wait?timeoutMs=${args.timeoutMs}`);
    case "jobs cancel":
      if (!values["if-match"]) throw new ApplicationError("INVALID_INPUT");
      return post(
        `/jobs/${args.id}/cancel`,
        {},
        { "If-Match": values["if-match"] },
      );
    case "fixtures accept": {
      const designId = identifier(values.design ?? `design_${args.id}`);
      const base = values.new
        ? null
        : {
            expectedBaseRevision: values["expected-base"],
            ifMatch: values["if-match"],
          };
      const input = parseContract(
        "FoundationAcceptFixtureRequest",
        JSON.stringify({
          fixtureId: args.id,
          branch: values.branch ?? "main",
          base,
        }),
        "json",
      );
      if (values.new && (values["if-match"] || values["expected-base"]))
        throw new ApplicationError("INVALID_INPUT");
      return post(
        `/designs/${designId}/revisions`,
        input,
        input.base
          ? { "If-Match": input.base.ifMatch }
          : { "If-None-Match": "*" },
      );
    }
    case "render": {
      requestKey();
      const selected = await get(
        `/designs/${args.id}?branch=${identifier(values.branch ?? "main")}`,
      );
      if (!selected.success) return selected;
      if (selected.data.kind !== "revision")
        throw new ApplicationError("INVALID_SCHEMA", 502);
      const revision = selected.data.revision;
      const body = {
        revision: { id: revision.id, sha256: revision.content.sha256 },
        base: {
          expectedBaseRevision: revision.id,
          ifMatch: `"${revision.content.sha256}"`,
        },
        mode: values["render-mode"] ?? "strict",
      };
      const accepted = await post(`/designs/${args.id}/render`, body, {
        "If-Match": body.base.ifMatch,
      });
      if (!accepted.success || values.async) return accepted;
      if (accepted.data.kind === "job") return accepted;
      if (accepted.data.kind !== "accepted-job" || !accepted.data.jobId)
        throw new ApplicationError("INVALID_SCHEMA", 502);
      return get(
        `/jobs/${accepted.data.jobId}/wait?timeoutMs=${args.timeoutMs}`,
      );
    }
    case "preview": {
      const response = await get(`/jobs/${args.id}`);
      if (!response.success) return response;
      if (
        response.data.kind !== "job" ||
        response.data.job?.status !== "completed" ||
        !response.data.job.receipt
      )
        throw new ApplicationError("ACTION_REQUIRED");
      const bytes = await connection.receive(
        `${prefix}/jobs/${args.id}/preview`,
        "GET",
        remaining(),
        undefined,
        {},
        "image/png",
        (value) => value,
        operation,
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      const artifact = response.data.job.receipt.outputs.find(
        (value) => value.sha256 === hash && value.byteLength === bytes.length,
      );
      if (!artifact) throw new ApplicationError("ARTIFACT_INTEGRITY", 502);
      return success(response.requestId, {
        kind: "artifact",
        artifact,
        jobId: response.data.job.id,
        status: "completed",
        warnings: [draftWarning()],
      });
    }
    case "artifacts get": {
      if (!values.sha256 || !validateContract("Sha256", values.sha256).success)
        throw new ApplicationError("INVALID_INPUT");
      const output =
        values["output-root"] !== undefined ||
        values["output-relative"] !== undefined;
      if (
        output &&
        (values["output-root"] !== "foundation_outputs" ||
          !values["output-relative"])
      )
        throw new ApplicationError("INVALID_INPUT");
      if (output && !publish) throw new ApplicationError("ACTION_REQUIRED");
      const metadata = await get(
        `/artifacts/${args.id}?sha256=${values.sha256}`,
      );
      if (!metadata.success || !output) return metadata;
      if (
        metadata.data.kind !== "artifact" ||
        !metadata.data.artifact ||
        !publish ||
        !values["output-relative"]
      )
        throw new ApplicationError("INVALID_SCHEMA", 502);
      const source = structuredClone(metadata.data.artifact);
      const bytes = await connection.receive(
        `${prefix}/artifacts/${args.id}/content?sha256=${values.sha256}`,
        "GET",
        remaining(),
        undefined,
        {},
        "application/octet-stream",
        (value) => value,
        operation,
      );
      if (
        createHash("sha256").update(bytes).digest("hex") !== source.sha256 ||
        bytes.length !== source.byteLength
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY", 502);
      checkCommandOperation(operation);
      const artifact = await publish(
        structuredClone(source),
        bytes,
        values["output-relative"],
        operation,
      );
      return success(metadata.requestId, {
        kind: "artifact",
        artifact: downloadResult(
          artifact,
          operation,
          source,
          values["output-relative"],
        ),
        warnings: [],
      });
    }
    default:
      throw new ApplicationError("ACTION_REQUIRED");
  }
}
function identifier(id: string) {
  if (
    !/^[A-Za-z0-9._-]+$/.test(id) ||
    !validateContract("StableId", id).success
  )
    throw new ApplicationError("INVALID_INPUT");
  return id;
}
function send(
  session: LocalSession,
  path: string,
  method: string,
  timeout: number,
  body: unknown,
  extra: Record<string, string> | undefined,
  operation: CommandOperation,
): Promise<ResponseEnvelope> {
  return receive(
    session,
    path,
    method,
    timeout,
    body,
    extra ?? {},
    "application/json",
    (bytes) => {
      const envelope = parseContract(
        "ResponseEnvelope",
        Buffer.from(bytes).toString("utf8"),
        "json",
      );
      if (
        envelope.success &&
        envelope.data.kind === "job" &&
        !validateContract("FoundationVersionedJobResponse", envelope).success
      )
        throw new ApplicationError("INVALID_SCHEMA", 502);
      return envelope;
    },
    operation,
  );
}
function receive<T>(
  session: LocalSession,
  path: string,
  method: string,
  timeout: number,
  body: unknown,
  extra: Record<string, string>,
  mediaType: string,
  parse: (bytes: Uint8Array) => T,
  operation: CommandOperation,
): Promise<T> {
  checkCommandOperation(operation);
  const bytes =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (bytes && bytes.length > 65536) throw new ApplicationError("INPUT_LIMIT");
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(
      {
        host: "127.0.0.1",
        port: session.port,
        path,
        method,
        agent: false,
        signal: operation.signal,
        headers: {
          Authorization: `Bearer ${session.credential}`,
          ...extra,
          ...(bytes
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(bytes.length),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        if (
          (response.headers["content-type"] !== mediaType &&
            !(
              response.headers["content-type"] === "application/json" &&
              (response.statusCode ?? 0) >= 400
            )) ||
          response.headers["content-encoding"] !== undefined
        ) {
          finish(new ApplicationError("INVALID_SCHEMA", 502));
          response.destroy();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 26214400) {
            finish(new ApplicationError("OUTPUT_LIMIT", 502));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          finish(new ApplicationError("TRANSPORT_UNAVAILABLE", 503)),
        );
        response.on("aborted", () =>
          finish(new ApplicationError("TRANSPORT_UNAVAILABLE", 503)),
        );
        response.on("end", () => {
          try {
            const content = Buffer.concat(chunks);
            if (
              mediaType !== "application/json" &&
              response.headers["content-type"] === "application/json"
            ) {
              const failure = parseContract(
                "ResponseEnvelope",
                content.toString("utf8"),
                "json",
              );
              if (!failure.success)
                throw new ApplicationError(
                  failure.error.code,
                  response.statusCode,
                  failure.error.jobId,
                );
              throw new ApplicationError("INVALID_SCHEMA", 502);
            }
            const result = parse(content);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(result);
            }
          } catch (error) {
            finish(
              error instanceof ApplicationError
                ? error
                : new ApplicationError("INVALID_SCHEMA", 502),
            );
          }
        });
      },
    );
    const timer = setTimeout(() => {
      finish(new ApplicationError("DEADLINE_EXCEEDED", 504));
      req.destroy();
    }, timeout);
    function finish(error: ApplicationError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    req.on("error", () =>
      finish(
        operation.signal.aborted
          ? operationError(operation)
          : new ApplicationError("TRANSPORT_UNAVAILABLE", 503),
      ),
    );
    req.end(bytes);
  });
}
function operationError(operation: CommandOperation): ApplicationError {
  try {
    checkCommandOperation(operation);
  } catch (error) {
    if (error instanceof ApplicationError) return error;
  }
  return new ApplicationError("CANCELLED");
}
