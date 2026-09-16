import { isIP } from "node:net";
import type { OperationContext } from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import ipaddr from "ipaddr.js";
import { AssetError, bound, fail, sha256, validateLimits } from "./core.js";

export interface RemoteResponse {
  status: number;
  peerAddress: string;
  location?: string;
  contentLength?: number;
  contentEncoding?: string;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

export interface RemoteDependencies {
  allowedOrigins: readonly string[];
  authorize(context: OperationContext, origin: string): Promise<void>;
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  /** Must connect only to address; verify TLS for serverName, do not redirect, decompress or use proxies. */
  transport(
    request: { url: string; address: string; serverName: string },
    signal: AbortSignal,
  ): Promise<RemoteResponse>;
}

export function publicAddress(address: string): boolean {
  if (!isIP(address) || address.includes("%")) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast") return false;
  // IPv6 must be currently allocated global unicast, not transition/NAT64/tunneling space.
  if (parsed.kind() === "ipv6" && !parsed.match(ipaddr.parseCIDR("2000::/3")))
    return false;
  return true;
}

export function checkContext(context: OperationContext): void {
  const { signal: _signal, clock: _clock, ...request } = context;
  if (!validateContract("OperationRequestContext", request).success)
    fail("INVALID_CONTEXT", "Invalid operation context");
  validateLimits(context.budget);
  if (context.signal.aborted) fail("CANCELLED", "Operation cancelled");
  const now = context.clock.now();
  if (!Number.isFinite(now)) fail("INVALID_CONTEXT", "Invalid injected clock");
  if (Date.parse(context.authorization.expiresAt) <= now)
    fail(
      "AUTH_EXPIRED",
      "Current authorization is required, including offline reads",
    );
  if (Date.parse(context.deadline) <= now)
    fail("DEADLINE", "Operation deadline exceeded");
  if (context.authorization.projectId !== context.projectId)
    fail("PROJECT_SCOPE", "Authorization project mismatch");
}

function urlFor(value: string, origins: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("REMOTE_URL", "Invalid remote URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !origins.includes(url.origin) ||
    url.hostname.endsWith(".") ||
    (isIP(url.hostname.replace(/^\[|\]$/gu, "")) &&
      !publicAddress(url.hostname.replace(/^\[|\]$/gu, "")))
  ) {
    fail("REMOTE_URL", "Remote URL origin, scheme or authority is prohibited");
  }
  return url;
}

export async function fetchRemote(
  value: string,
  context: OperationContext,
  dependencies: RemoteDependencies,
) {
  checkContext(context);
  if (context.authorization.egress === "deny")
    fail("EGRESS_DENIED", "External asset retrieval is disabled");
  const limits = { ...context.budget };
  const started = context.clock.now();
  const checkpoint = () => {
    checkContext(context);
    bound(
      "DURATION",
      Math.ceil(context.clock.now() - started),
      limits.maxDurationMs,
    );
  };
  const origins = [...dependencies.allowedOrigins];
  const duration = Math.min(
    limits.maxDurationMs,
    Date.parse(context.deadline) - context.clock.now(),
    Date.parse(context.authorization.expiresAt) - context.clock.now(),
  );
  bound("DURATION", duration, 2_147_483_647);
  const controller = new AbortController();
  let response: RemoteResponse | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: AssetError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectAbort(
      new AssetError({
        code: "CANCELLED",
        message: "Remote retrieval cancelled",
      }),
    );
  };
  context.signal.addEventListener("abort", cancel, { once: true });
  const awaitBounded = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, interrupted]);
  try {
    timer = setTimeout(() => {
      controller.abort();
      rejectAbort(
        new AssetError({
          code: "DEADLINE",
          message: "Remote retrieval deadline exceeded",
        }),
      );
    }, duration);
    let next = value;
    for (let calls = 1; ; calls++) {
      checkpoint();
      const url = urlFor(next, origins);
      bound("EXTERNAL_CALLS", calls, limits.maxExternalCalls);
      await awaitBounded(dependencies.authorize(context, url.origin));
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      const addresses = isIP(hostname)
        ? [hostname]
        : await awaitBounded(dependencies.resolve(hostname, controller.signal));
      if (
        !addresses.length ||
        addresses.length > 64 ||
        !addresses.every(publicAddress)
      )
        fail(
          "REMOTE_DNS",
          "DNS must resolve exclusively to public destinations",
        );
      const address = addresses[0];
      if (!address) fail("REMOTE_DNS", "DNS returned no address");
      const pending = dependencies
        .transport(
          { url: url.href, address, serverName: hostname },
          controller.signal,
        )
        .then((result) => {
          if (controller.signal.aborted) {
            result.close();
            fail("CANCELLED", "Late transport response discarded");
          }
          return result;
        });
      response = await awaitBounded(pending);
      if (
        !publicAddress(response.peerAddress) ||
        ipaddr.parse(response.peerAddress).toNormalizedString() !==
          ipaddr.parse(address).toNormalizedString()
      )
        fail(
          "REMOTE_PEER",
          "Connected peer differs from pinned DNS destination",
        );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location)
          fail("REMOTE_REDIRECT", "Redirect is missing a destination");
        try {
          next = new URL(response.location, url).href;
        } catch {
          fail("REMOTE_URL", "Invalid redirect URL");
        }
        response.close();
        response = undefined;
        continue;
      }
      if (response.status === 401 || response.status === 403)
        fail("REMOTE_AUTH", "Source authorization denied; no cached fallback");
      if (response.status !== 200)
        fail("REMOTE_STATUS", "Remote response is not a complete asset");
      if (response.contentEncoding && response.contentEncoding !== "identity")
        fail(
          "REMOTE_ENCODING",
          "HTTP content compression is outside the bounded transport profile",
        );
      if (response.contentLength !== undefined)
        bound("INPUT_BYTES", response.contentLength, limits.maxInputBytes);
      const chunks: Buffer[] = [];
      let length = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      for (;;) {
        const chunk = await awaitBounded(iterator.next());
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          fail("REMOTE_BODY", "Transport must yield bytes");
        length += chunk.value.byteLength;
        bound("INPUT_BYTES", length, limits.maxInputBytes);
        bound("OUTPUT_BYTES", length, limits.maxOutputBytes);
        chunks.push(Buffer.from(chunk.value));
        checkpoint();
      }
      if (
        response.contentLength !== undefined &&
        response.contentLength !== length
      )
        fail("REMOTE_TRUNCATED", "Response length does not match header");
      checkpoint();
      const bytes = Buffer.concat(chunks, length);
      return { bytes, sha256: sha256(bytes), externalCalls: calls };
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    fail("REMOTE_IO", "Remote transport failed");
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener("abort", cancel);
    controller.abort();
    response?.close();
  }
}
