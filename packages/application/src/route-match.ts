import { validateContract } from "@design-studio/contracts";
import { ApplicationError } from "./response.js";
import { PROJECT_ID, ROUTES } from "./routes.js";
export function matchRoute(
  target: string,
  requestMethod: string,
  authorizedProject: string,
) {
  if (
    target.length > 2048 ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[%\\#]/.test(target) ||
    [...target].some((character) => character.charCodeAt(0) <= 32) ||
    /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(target)
  )
    throw new ApplicationError("INVALID_INPUT");
  const url = new URL(target, "http://127.0.0.1");
  const method = requestMethod === "HEAD" ? "GET" : requestMethod;
  let route: (typeof ROUTES)[number] | undefined;
  let id: string | undefined;
  let projectId = PROJECT_ID;
  if (url.pathname !== "/v1/openapi.json") {
    const match = /^\/v1\/projects\/([A-Za-z0-9._-]+)(\/.*)$/.exec(
      url.pathname,
    );
    if (!match?.[1] || !match[2]) throw new ApplicationError("NOT_FOUND", 404);
    projectId = match[1];
    if (projectId !== authorizedProject || projectId !== PROJECT_ID)
      throw new ApplicationError("FORBIDDEN", 403);
    for (const candidate of ROUTES) {
      const parts = new RegExp(
        `^${candidate.path.replace(/\{[^}]+\}/g, "([A-Za-z0-9._-]+)")}$`,
      ).exec(match[2]);
      if (parts && candidate.method === method) {
        route = candidate;
        id = parts[1];
        break;
      }
    }
    if (!route) throw new ApplicationError("NOT_FOUND", 404);
  } else if (method !== "GET") throw new ApplicationError("NOT_FOUND", 404);
  if (id && !validateContract("StableId", id).success)
    throw new ApplicationError("INVALID_INPUT");
  const parameters: Record<string, string> = {};
  const allowed =
    route?.operation === "getDesign"
      ? ["branch"]
      : route?.operation === "waitJob"
        ? ["timeoutMs"]
        : route?.operation === "getArtifact" ||
            route?.operation === "readArtifact"
          ? ["sha256"]
          : [];
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(parameters, key))
      throw new ApplicationError("INVALID_INPUT");
    parameters[key] = value;
  }
  return { route, id, projectId, parameters, method };
}
