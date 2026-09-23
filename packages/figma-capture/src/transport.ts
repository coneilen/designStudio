import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import tls from "node:tls";
import { debuglog } from "node:util";
import { publicAddress, sameAddress } from "@design-studio/assets";
import { HostBoundaryError } from "@design-studio/host";
import { type CaptureBudget, fail, type ImageBudget } from "./boundary.js";

// Unlike the process default trust store, this is fixed by the approved Node release.
const bundledAuthorities = Object.freeze([...tls.rootCertificates]);
const trustOverride =
  /(?:^|[\s"'])--(?:use-(?:openssl|system)-ca|openssl-(?:config|shared-config))(?:[=\s"']|$)/;
export type ApiOperation = "metadata" | "nodes" | "reference-render";
export interface HttpCapture {
  status: number;
  bytes: Buffer;
  mediaType?: string;
}
export class CaptureHttpError extends HostBoundaryError {
  constructor(
    code: ConstructorParameters<typeof HostBoundaryError>[0],
    readonly status?: number,
    readonly retryAfter?: string,
    readonly requestIssued?: boolean,
  ) {
    super(
      code,
      "Bounded Figma response was unavailable or invalid; sensitive details withheld.",
    );
  }
}
function safeRuntime(): void {
  if (
    ["http", "https", "tls", "net"].some((name) => debuglog(name).enabled) ||
    process.execArgv.some(
      (arg) =>
        /^(--tls-keylog|--inspect|--use-env-proxy)/.test(
          arg.replaceAll("_", "-"),
        ) || trustOverride.test(arg.replaceAll("_", "-")),
    ) ||
    trustOverride.test((process.env.NODE_OPTIONS ?? "").replaceAll("_", "-")) ||
    [
      "NODE_EXTRA_CA_CERTS",
      "NODE_USE_SYSTEM_CA",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "OPENSSL_CONF",
    ].some((name) => process.env[name] !== undefined) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.SSLKEYLOGFILE ||
    (process.env.NODE_USE_ENV_PROXY && process.env.NODE_USE_ENV_PROXY !== "0")
  )
    fail(
      "POLICY_FAILED",
      "Capture forbids transport debugging, TLS overrides and proxy routing.",
    );
}
function headers(message: IncomingMessage): {
  length?: number;
  retryAfter?: string;
  mediaType?: string;
} {
  if (message.rawHeaders.length % 2 || message.rawHeaders.length > 128)
    throw new CaptureHttpError("INPUT_LIMIT");
  const values = new Map<string, string[]>();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index]?.toLowerCase();
    const value = message.rawHeaders[index + 1];
    if (!name || value === undefined)
      throw new CaptureHttpError("INVALID_INPUT");
    const entries = values.get(name) ?? [];
    entries.push(value);
    values.set(name, entries);
  }
  const single = (name: string) => {
    const found = values.get(name);
    if (found && found.length !== 1)
      throw new CaptureHttpError("INVALID_INPUT");
    return found?.[0];
  };
  const length = single("content-length");
  const transfer = single("transfer-encoding");
  const encoding = single("content-encoding");
  if (
    (length !== undefined && transfer !== undefined) ||
    (transfer !== undefined && transfer.toLowerCase() !== "chunked") ||
    (encoding !== undefined && encoding.toLowerCase() !== "identity") ||
    values.has("trailer") ||
    message.httpVersion !== "1.1" ||
    (length === undefined && transfer === undefined)
  )
    throw new CaptureHttpError("INVALID_INPUT");
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]{0,8})$/.test(length) ||
      !Number.isSafeInteger(Number(length)))
  )
    throw new CaptureHttpError("INPUT_LIMIT");
  const retryAfter = single("retry-after");
  const type = single("content-type")?.split(";")[0]?.trim().toLowerCase();
  return {
    ...(length === undefined ? {} : { length: Number(length) }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(type === undefined
      ? {}
      : {
          mediaType: [
            "application/json",
            "image/png",
            "application/octet-stream",
            "binary/octet-stream",
          ].includes(type)
            ? type
            : "other",
        }),
  };
}
/** Not a public configurable transport: API targets and authenticated headers are constructed here. */
export class FigmaHttpsTransport {
  api(
    operation: ApiOperation,
    version: string | undefined,
    secret: Uint8Array,
    budget: CaptureBudget,
  ): Promise<HttpCapture> {
    if (
      !(secret instanceof Uint8Array) ||
      secret.buffer instanceof SharedArrayBuffer ||
      secret.length < 1 ||
      secret.length > 4096 ||
      secret.some((byte) => byte < 33 || byte > 126)
    )
      fail("AUTH_REQUIRED", "The configured credential is not a bounded PAT.");
    const { fileKey, nodeId } = budget.policy;
    let url: URL;
    if (operation === "metadata")
      url = new URL(`https://api.figma.com/v1/files/${fileKey}/meta`);
    else {
      if (!version || version.length > 160)
        fail("INVALID_INPUT", "Pinned source version is required.");
      url = new URL(
        operation === "nodes"
          ? `https://api.figma.com/v1/files/${fileKey}/nodes`
          : `https://api.figma.com/v1/images/${fileKey}`,
      );
      url.searchParams.set("ids", nodeId);
      url.searchParams.set("version", version);
      if (operation === "nodes") url.searchParams.set("geometry", "paths");
      else {
        url.searchParams.set("format", "png");
        url.searchParams.set("scale", "1");
        url.searchParams.set("contents_only", "true");
        url.searchParams.set("use_absolute_bounds", "true");
      }
    }
    return this.read(
      url,
      operation === "nodes" ? budget.context.budget.maxInputBytes : 262144,
      budget,
      secret,
    );
  }
  image(input: string, budget: ImageBudget): Promise<HttpCapture> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      fail("INVALID_INPUT", "Reference image URL is invalid.");
    }
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.endsWith(".") ||
      !budget.policy.imageOrigins.includes(url.origin)
    )
      fail(
        "ACTION_REQUIRED",
        "Reference origin is not independently approved.",
      );
    return this.read(url, budget.context.budget.maxInputBytes, budget);
  }
  private async read(
    url: URL,
    maximum: number,
    budget: ImageBudget,
    secret?: Uint8Array,
  ): Promise<HttpCapture> {
    safeRuntime();
    budget.check();
    budget.dnsQuery();
    let address: string;
    try {
      // lookup has no cancellation wrapper: keep the original work owned through settlement.
      const found = await lookup(url.hostname, { all: true, verbatim: true });
      budget.check();
      if (
        !found.length ||
        found.length > 64 ||
        found.some((entry) => !publicAddress(entry.address))
      )
        throw new CaptureHttpError("POLICY_FAILED");
      const first = found[0];
      if (!first) throw new CaptureHttpError("PROVIDER_UNAVAILABLE");
      address = first.address;
    } catch (error) {
      budget.check();
      if (error instanceof CaptureHttpError)
        throw new CaptureHttpError(error.code, undefined, undefined, false);
      throw new CaptureHttpError(
        "PROVIDER_UNAVAILABLE",
        undefined,
        undefined,
        false,
      );
    }
    budget.check();
    safeRuntime();
    const socket = tls.connect({
      host: address,
      port: 443,
      servername: url.hostname,
      rejectUnauthorized: true,
      ca: [...bundledAuthorities],
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    });
    let agent: https.Agent | undefined;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let status: number | undefined;
    let retryAfter: string | undefined;
    let mediaType: string | undefined;
    let expectedLength: number | undefined;
    let problem: HostBoundaryError | undefined;
    let issued = false;
    let handedOff = false;
    let responseSeen = false;
    let bodyEnded = false;
    let requestClosed = false;
    let bodyBytes = 0;
    let receivedBytes = 0;
    let chunks: Buffer[] = [];
    let requestDone: Promise<void> | undefined;
    let writeDone: Promise<void> | undefined;
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    const mark = (error: unknown) => {
      problem ??=
        error instanceof HostBoundaryError
          ? new HostBoundaryError(
              error.code,
              "Capture transport failed; details withheld.",
            )
          : new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter);
      response?.destroy();
      socket.destroy();
    };
    const abort = () =>
      mark(
        new CaptureHttpError(
          budget.signal.reason instanceof HostBoundaryError
            ? budget.signal.reason.code
            : "CANCELLED",
          status,
          retryAfter,
        ),
      );
    socket.on("error", () =>
      mark(new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter)),
    );
    socket.on("data", (bytes: Buffer) => {
      try {
        budget.receive(bytes.length);
        receivedBytes += bytes.length;
        if (!issued) throw new CaptureHttpError("INVALID_INPUT");
      } catch (error) {
        mark(error);
      }
    });
    budget.signal.addEventListener("abort", abort, { once: true });
    try {
      if (budget.signal.aborted) abort();
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", () => resolve());
        socket.once("close", () =>
          reject(problem ?? new CaptureHttpError("PROVIDER_UNAVAILABLE")),
        );
      });
      budget.check();
      const verifyPeer = () => {
        budget.check();
        safeRuntime();
        if (
          socket.destroyed ||
          !socket.authorized ||
          !socket.remoteAddress ||
          !publicAddress(socket.remoteAddress) ||
          !sameAddress(socket.remoteAddress, address) ||
          tls.checkServerIdentity(url.hostname, socket.getPeerCertificate()) ||
          (socket.alpnProtocol && socket.alpnProtocol !== "http/1.1")
        )
          throw new CaptureHttpError("FORBIDDEN");
      };
      verifyPeer();
      agent = new https.Agent({
        keepAlive: false,
        maxSockets: 1,
        maxCachedSessions: 0,
      });
      agent.createConnection = (_options, callback) => {
        try {
          if (handedOff) throw new CaptureHttpError("FORBIDDEN");
          handedOff = true;
          verifyPeer();
          if (
            _options.host !== url.hostname ||
            Number(_options.port) !== 443 ||
            (_options.servername !== undefined &&
              _options.servername !== url.hostname)
          )
            throw new CaptureHttpError("FORBIDDEN");
          issued = true;
          return socket;
        } catch (error) {
          mark(error);
          if (callback)
            queueMicrotask(() =>
              callback(problem ?? new CaptureHttpError("FORBIDDEN"), socket),
            );
          return undefined;
        }
      };
      // The maintained Node parser needs a transient header string; never construct it before the final gate.
      verifyPeer();
      const requestHeaders: Record<string, string> = {
        Accept: secret ? "application/json" : "image/png",
        "Accept-Encoding": "identity",
        Connection: "close",
      };
      if (secret) {
        if (url.origin !== "https://api.figma.com")
          throw new CaptureHttpError("FORBIDDEN");
        requestHeaders["X-Figma-Token"] = Buffer.from(
          secret.buffer,
          secret.byteOffset,
          secret.byteLength,
        ).toString("ascii");
      }
      request = https.request(url, {
        agent,
        method: "GET",
        maxHeaderSize: 16384,
        headers: requestHeaders,
      });
      delete requestHeaders["X-Figma-Token"];
      request.maxHeadersCount = 0;
      requestDone = new Promise<void>((resolve) =>
        request?.once("close", () => {
          requestClosed = true;
          resolve();
        }),
      );
      request.on("information", () =>
        mark(new CaptureHttpError("INVALID_INPUT")),
      );
      request.on("error", () =>
        mark(new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter)),
      );
      request.on("response", (message) => {
        message.on("error", () =>
          mark(
            new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter),
          ),
        );
        message.on("aborted", () =>
          mark(
            new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter),
          ),
        );
        try {
          budget.check();
          if (responseSeen || message.socket !== socket)
            throw new CaptureHttpError("INVALID_INPUT");
          responseSeen = true;
          response = message;
          const metadata = headers(message);
          status = message.statusCode;
          retryAfter = metadata.retryAfter;
          mediaType = metadata.mediaType;
          expectedLength = metadata.length;
          if (status !== 200) {
            mark(
              new CaptureHttpError(
                status === 429
                  ? "RATE_LIMITED"
                  : status === 401
                    ? "AUTH_REQUIRED"
                    : status === 403
                      ? "FORBIDDEN"
                      : "RESOURCE_UNRESOLVED",
                status,
                retryAfter,
              ),
            );
            return;
          }
          if (
            expectedLength !== undefined &&
            expectedLength >
              Math.min(
                maximum,
                budget.context.budget.maxInputBytes - budget.body,
              )
          )
            throw new CaptureHttpError("INPUT_LIMIT", status);
          message.on("data", (bytes: Buffer) => {
            try {
              budget.check();
              budget.decoded(bytes.length);
              bodyBytes += bytes.length;
              if (
                bodyBytes > maximum ||
                (expectedLength !== undefined && bodyBytes > expectedLength)
              )
                throw new CaptureHttpError("INPUT_LIMIT", status);
              chunks.push(Buffer.from(bytes));
            } catch (error) {
              mark(error);
            }
          });
          message.once("end", () => {
            try {
              budget.check();
              if (
                !message.complete ||
                message.rawTrailers.length !== 0 ||
                (expectedLength !== undefined && bodyBytes !== expectedLength)
              )
                throw new CaptureHttpError("INVALID_INPUT", status);
              bodyEnded = true;
            } catch (error) {
              mark(error);
            }
          });
        } catch (error) {
          mark(error);
        }
      });
      budget.check();
      writeDone = new Promise<void>((resolve) =>
        request?.end((error?: Error | null) => {
          if (error)
            mark(
              new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter),
            );
          resolve();
        }),
      );
      await requestDone;
      budget.check();
      await closed;
      budget.check();
      if (problem) throw new CaptureHttpError(problem.code, status, retryAfter);
      if (
        !requestClosed ||
        !bodyEnded ||
        !responseSeen ||
        status !== 200 ||
        !receivedBytes
      )
        throw new CaptureHttpError("PROVIDER_UNAVAILABLE", status, retryAfter);
      const bytes = Buffer.concat(chunks, bodyBytes);
      return { status, bytes, ...(mediaType ? { mediaType } : {}) };
    } catch (error) {
      budget.check();
      if (error instanceof CaptureHttpError)
        throw new CaptureHttpError(error.code, status, retryAfter, issued);
      if (error instanceof HostBoundaryError)
        throw new CaptureHttpError(error.code, status, retryAfter, issued);
      throw new CaptureHttpError(
        "PROVIDER_UNAVAILABLE",
        status,
        retryAfter,
        issued,
      );
    } finally {
      budget.signal.removeEventListener("abort", abort);
      request?.destroy();
      socket.destroy();
      agent?.destroy();
      await writeDone;
      await requestDone;
      await closed;
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
    }
  }
}
