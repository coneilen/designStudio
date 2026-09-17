import { validateContract } from "@design-studio/contracts";
import { ApplicationError } from "./response.js";
import { PROJECT_ID, ROUTES } from "./routes.js";
import type { Invocation } from "./types.js";

export function validateInvocation(request: Invocation): void {
  if (
    !validateContract("JsonValue", request).success ||
    request.projectId !== PROJECT_ID ||
    !validateContract("StableId", request.requestId).success ||
    (request.id !== undefined &&
      !validateContract("StableId", request.id).success)
  )
    throw new ApplicationError("INVALID_INPUT");
  const route = ROUTES.find(
    (candidate) => candidate.operation === request.operation,
  );
  if (!route && request.operation !== "openapi")
    throw new ApplicationError("NOT_FOUND", 404);
  const allowed =
    request.operation === "getDesign"
      ? ["branch"]
      : request.operation === "waitJob"
        ? ["timeoutMs"]
        : request.operation === "getArtifact" ||
            request.operation === "readArtifact"
          ? ["sha256"]
          : [];
  for (const [key, value] of Object.entries(request.parameters)) {
    if (!allowed.includes(key)) throw new ApplicationError("INVALID_INPUT");
    if (key === "branch" && !validateContract("StableId", value).success)
      throw new ApplicationError("INVALID_INPUT");
    if (key === "sha256" && !validateContract("Sha256", value).success)
      throw new ApplicationError("INVALID_INPUT");
    if (
      key === "timeoutMs" &&
      (!/^[1-9][0-9]*$/.test(value) || Number(value) > 30000)
    )
      throw new ApplicationError("INVALID_INPUT");
  }
  if (route && "request" in route) {
    if (!validateContract(route.request, request.body).success)
      throw new ApplicationError("INVALID_INPUT");
    if (!request.ifMatch && !request.ifNoneMatch)
      throw new ApplicationError("ACTION_REQUIRED", 428);
    if (request.ifMatch && request.ifNoneMatch)
      throw new ApplicationError("INVALID_INPUT");
    if (request.operation === "cancelJob") {
      const match = /^"job:([A-Za-z0-9._-]+):(0|[1-9][0-9]*)"$/.exec(
        request.ifMatch ?? "",
      );
      if (
        !match ||
        match[1] !== request.id ||
        !Number.isSafeInteger(Number(match[2]))
      )
        throw new ApplicationError("INVALID_INPUT");
      return;
    }
    if (request.operation === "acceptFixture") {
      const checked = validateContract(
        "FoundationAcceptFixtureRequest",
        request.body,
      );
      if (!checked.success) throw new ApplicationError("INVALID_INPUT");
      if (checked.value.base === null) {
        if (request.ifNoneMatch !== "*" || request.ifMatch)
          throw new ApplicationError("INVALID_INPUT");
      } else if (request.ifMatch !== checked.value.base.ifMatch)
        throw new ApplicationError("INVALID_INPUT");
    } else {
      const checked = validateContract(
        "FoundationRenderSubmissionRequest",
        request.body,
      );
      if (
        !checked.success ||
        request.ifMatch !== checked.value.base.ifMatch ||
        checked.value.revision.id !== checked.value.base.expectedBaseRevision ||
        request.ifMatch !== `"${checked.value.revision.sha256}"`
      )
        throw new ApplicationError("INVALID_INPUT");
    }
  } else if (
    request.body !== undefined ||
    request.ifMatch !== undefined ||
    request.ifNoneMatch !== undefined
  )
    throw new ApplicationError("INVALID_INPUT");
}
