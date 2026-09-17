import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { parseContract, validateContract } from "@design-studio/contracts";
import type { LocalSessionAuthenticator } from "@design-studio/host";
import { authenticateHttp } from "./http-auth.js";
import { validateInvocation } from "./requests.js";
import { ApplicationError, failure, safeError } from "./response.js";
import { matchRoute } from "./route-match.js";
import type {
  ApplicationFacade,
  ApplicationResult,
  Invocation,
} from "./types.js";

const JSON_LIMIT = 65536;
export async function listenHttp(
  application: ApplicationFacade,
  makeSessions: (host: string) => LocalSessionAuthenticator,
  port = 0,
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ApplicationError("INVALID_INPUT");
  let authenticator: LocalSessionAuthenticator | undefined;
  let active = 0;
  let stopping = false;
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const server = createServer(
    {
      maxHeaderSize: 16384,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("checkContinue", (req, res) => {
    void handle(req, res);
  });
  server.on("checkExpectation", (req, res) => {
    void handle(req, res);
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController();
    const traceId = randomUUID();
    let requestId: string = traceId;
    let admitted = false;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      controller.abort();
      if (!response.headersSent && !response.destroyed) {
        respond(
          response,
          {
            kind: "json",
            status: 504,
            envelope: failure(requestId, "DEADLINE_EXCEEDED"),
          },
          request.method === "HEAD",
          traceId,
        );
        response.once("finish", () => request.destroy());
      } else request.destroy();
    };
    const timer = setTimeout(expire, 30000);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    request.once("aborted", () => controller.abort());
    controllers.add(controller);
    try {
      if (stopping || active >= 8 || !authenticator)
        throw new ApplicationError("PROVIDER_UNAVAILABLE", 503);
      const authorization = authenticateHttp(request, authenticator);
      active++;
      admitted = true;
      const h = request.headers;
      if (h["transfer-encoding"] !== undefined || h.expect !== undefined)
        throw new ApplicationError("INVALID_INPUT", 400);
      if (h["content-encoding"] !== undefined)
        throw new ApplicationError("INVALID_INPUT", 415);
      const length =
        h["content-length"] === undefined ? 0 : Number(h["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0)
        throw new ApplicationError("INVALID_INPUT");
      if (length > JSON_LIMIT) throw new ApplicationError("INPUT_LIMIT", 413);
      const target = request.url ?? "";
      const { route, id, projectId, parameters, method } = matchRoute(
        target,
        request.method ?? "",
        authorization.projectId,
      );
      let body: unknown;
      let ifMatch: string | undefined;
      let ifNoneMatch: string | undefined;
      if (method === "POST") {
        const key = h["idempotency-key"];
        if (
          typeof key !== "string" ||
          !validateContract("StableId", key).success
        )
          throw new ApplicationError("ACTION_REQUIRED", 428);
        requestId = key;
        ifMatch = typeof h["if-match"] === "string" ? h["if-match"] : undefined;
        ifNoneMatch =
          typeof h["if-none-match"] === "string"
            ? h["if-none-match"]
            : undefined;
        if (!ifMatch && !ifNoneMatch)
          throw new ApplicationError("ACTION_REQUIRED", 428);
        if (ifMatch && ifNoneMatch) throw new ApplicationError("INVALID_INPUT");
        if (route?.operation === "cancelJob") {
          if (
            !ifMatch ||
            !new RegExp(`^"job:${id}:(0|[1-9][0-9]*)"$`).test(ifMatch)
          )
            throw new ApplicationError("INVALID_INPUT");
        } else if (
          ifMatch
            ? !/^"[a-f0-9]{64}"$/.test(ifMatch)
            : ifNoneMatch !== "*" || route?.operation !== "acceptFixture"
        )
          throw new ApplicationError("INVALID_INPUT");
        if (h["content-type"] !== "application/json")
          throw new ApplicationError("INVALID_INPUT", 415);
        bodyTimer = setTimeout(expire, 5000);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > JSON_LIMIT)
            throw new ApplicationError("INPUT_LIMIT", 413);
          chunks.push(buffer);
        }
        clearTimeout(bodyTimer);
        if (!route || !("request" in route))
          throw new ApplicationError("INVALID_INPUT");
        try {
          body = parseContract(
            route.request,
            Buffer.concat(chunks).toString("utf8"),
            "json",
          );
        } catch {
          throw new ApplicationError("INVALID_INPUT");
        }
      } else if (length !== 0) throw new ApplicationError("INVALID_INPUT");
      const invocation: Invocation = {
        operation: route?.operation ?? "openapi",
        projectId,
        requestId,
        parameters,
        ...(id ? { id } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(ifMatch ? { ifMatch } : {}),
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
      };
      validateInvocation(invocation);
      const result = await application.invoke(
        invocation,
        authorization,
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new ApplicationError("DEADLINE_EXCEEDED", 504);
      respond(response, result, request.method === "HEAD", traceId);
    } catch (error) {
      const safe = safeError(error);
      if (!response.destroyed && !response.headersSent)
        respond(
          response,
          {
            kind: "json",
            envelope: failure(requestId, safe.code, safe.jobId),
            status: safe.httpStatus,
          },
          request.method === "HEAD",
          traceId,
        );
    } finally {
      clearTimeout(timer);
      if (bodyTimer) clearTimeout(bodyTimer);
      controllers.delete(controller);
      if (admitted) active--;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new ApplicationError("INTERNAL_ERROR");
  }
  try {
    authenticator = makeSessions(`127.0.0.1:${address.port}`);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    port: address.port,
    authenticator,
    async close() {
      stopping = true;
      for (const controller of controllers) controller.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
function respond(
  response: ServerResponse,
  result: ApplicationResult,
  head: boolean,
  traceId: string,
) {
  const bytes =
    result.kind === "json"
      ? Buffer.from(`${JSON.stringify(result.envelope)}\n`)
      : Buffer.from(result.bytes);
  if (bytes.length > 26214400) throw new ApplicationError("OUTPUT_LIMIT", 500);
  response.writeHead(result.kind === "json" ? (result.status ?? 200) : 200, {
    "Content-Type":
      result.kind === "json" ? "application/json" : result.mediaType,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "X-Request-Trace": traceId,
    Connection: "close",
    ...(result.etag ? { ETag: result.etag } : {}),
    ...(result.kind === "binary" && result.draft
      ? { "X-Design-Approval": "unapproved" }
      : {}),
    ...(result.kind === "binary" &&
    result.mediaType === "application/octet-stream"
      ? { "Content-Disposition": 'attachment; filename="artifact.bin"' }
      : {}),
  });
  response.end(head ? undefined : bytes);
}
