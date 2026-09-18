import type { IncomingMessage } from "node:http";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { ApplicationError } from "./response.js";
export function createHttpSessions(host: string) {
  return new LocalSessionAuthenticator({
    clock: new SystemClock(),
    hosts: [host],
    origins: [`http://${host}`],
  });
}

export function authenticateHttp(
  request: IncomingMessage,
  sessions: LocalSessionAuthenticator,
) {
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    if (!name || seen.has(name))
      throw new ApplicationError("INVALID_INPUT", 400);
    seen.add(name);
  }
  const h = request.headers;
  if (h.authorization === undefined && h.cookie === undefined)
    throw new ApplicationError("AUTH_REQUIRED", 401);
  if (
    h.authorization &&
    [...seen].some((name) => name.startsWith("sec-fetch-"))
  )
    throw new ApplicationError("ORIGIN_FORBIDDEN", 403);
  if (
    h.authorization !== undefined &&
    !/^Bearer [A-Za-z0-9_-]{43}$/.test(h.authorization)
  )
    throw new ApplicationError("AUTH_REQUIRED", 401);
  if (
    h.cookie !== undefined &&
    !/^design_session=[A-Za-z0-9_-]{43}$/.test(h.cookie)
  )
    throw new ApplicationError("AUTH_REQUIRED", 401);
  const single = (name: string) => {
    const value = h[name];
    if (Array.isArray(value)) throw new ApplicationError("INVALID_INPUT", 400);
    return value;
  };
  const origin = single("origin");
  const fetchSite = single("sec-fetch-site");
  const csrf = single("x-csrf-token");
  return sessions.authenticate({
    remoteAddress: request.socket.remoteAddress ?? "",
    host: h.host ?? "",
    method: request.method ?? "",
    ...(h.authorization ? { bearer: h.authorization.slice(7) } : {}),
    ...(h.cookie !== undefined
      ? { cookie: h.cookie.slice("design_session=".length) }
      : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(fetchSite !== undefined ? { fetchSite } : {}),
    ...(csrf !== undefined ? { csrf } : {}),
  });
}
export function browserCookie(credential: string, https: boolean): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new ApplicationError("INVALID_INPUT");
  return `design_session=${credential}; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=300${https ? "; Secure" : ""}`;
}
