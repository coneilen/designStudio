import type {
  AuthorizationContext,
  OperationContext,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import { snapshotOperationContext } from "@design-studio/host";
import { doctor } from "./doctor.js";
import { openApiBytes } from "./openapi.js";
import { validateInvocation } from "./requests.js";
import { ApplicationError, success } from "./response.js";
import { PROJECT_ID } from "./routes.js";
import type {
  ApplicationFacade,
  ApplicationResult,
  Invocation,
} from "./types.js";

export interface ApplicationServices {
  capabilities?(): ReturnType<typeof doctor>;
  authorize(
    request: Readonly<Invocation>,
    authorization: AuthorizationContext,
    signal: AbortSignal,
  ): Promise<OperationContext>;
  execute(
    request: Readonly<Invocation>,
    context: OperationContext,
  ): Promise<ApplicationResult>;
}
export function createApplication(
  services: ApplicationServices,
): ApplicationFacade {
  const authorize = services.authorize.bind(services);
  const execute = services.execute.bind(services);
  const capabilities = services.capabilities?.bind(services);
  return {
    async invoke(input, authorization, signal) {
      if (
        !validateContract("JsonValue", input).success ||
        input.projectId !== PROJECT_ID ||
        authorization.projectId !== PROJECT_ID ||
        !validateContract("StableId", input.requestId).success ||
        (input.id !== undefined &&
          !validateContract("StableId", input.id).success)
      )
        throw new ApplicationError("FORBIDDEN", 403);
      const request = Object.freeze(structuredClone(input));
      const context = snapshotOperationContext(
        await authorize(request, authorization, signal),
      );
      if (
        context.projectId !== request.projectId ||
        context.requestId !== request.requestId ||
        context.authorization.actorId !== authorization.actorId ||
        context.signal !== signal ||
        context.clock.now() >= Date.parse(context.deadline) ||
        signal.aborted
      )
        throw new ApplicationError("FORBIDDEN", 403);
      validateInvocation(request);
      if (request.operation === "doctor")
        return {
          kind: "json",
          envelope: success(request.requestId, {
            kind: "capabilities",
            capabilities: capabilities ? capabilities() : doctor(),
            warnings: [],
          }),
        };
      if (request.operation === "openapi")
        return {
          kind: "binary",
          mediaType: "application/json",
          bytes: openApiBytes(),
        };
      const result = await execute(request, context);
      if (result.kind === "json") {
        if (
          !validateContract("ResponseEnvelope", result.envelope).success ||
          (result.envelope.success &&
            result.envelope.data.kind === "job" &&
            !validateContract("FoundationVersionedJobResponse", result.envelope)
              .success)
        )
          throw new ApplicationError("INTERNAL_ERROR", 500);
      } else if (result.bytes.byteLength > context.budget.maxOutputBytes)
        throw new ApplicationError("OUTPUT_LIMIT", 500);
      return structuredClone(result);
    },
  };
}
