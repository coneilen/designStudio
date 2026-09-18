import {
  type Artifact,
  DEFAULT_BUDGETS,
  validateContract,
} from "@design-studio/contracts";
import type {
  FixtureInstallationLease,
  FixtureProjectBinding,
  FixtureProjectRegistry,
} from "@design-studio/project-host";
import {
  type CommandOperation,
  checkCommandOperation,
  snapshotCommandOperation,
} from "./command-lifetime.js";
import { publishDownload } from "./download.js";
import { createFixturePolicy } from "./policy.js";
import { ApplicationError } from "./response.js";

export async function publishInstalledDownload(
  installation: Pick<FixtureInstallationLease, "recheck">,
  registry: Pick<FixtureProjectRegistry, "currentPrincipal">,
  project: FixtureProjectBinding,
  artifact: Artifact,
  inputBytes: Uint8Array,
  relative: string,
  originalOperation: CommandOperation,
): Promise<Artifact> {
  const operation = snapshotCommandOperation(originalOperation);
  checkCommandOperation(operation);
  if (
    !validateContract("Artifact", artifact).success ||
    !(inputBytes instanceof Uint8Array) ||
    inputBytes.buffer instanceof SharedArrayBuffer ||
    inputBytes.byteLength !== artifact.byteLength ||
    inputBytes.byteLength > DEFAULT_BUDGETS.maxInputBytes
  )
    throw new ApplicationError("INVALID_INPUT");
  const source = structuredClone(artifact);
  const bytes = inputBytes.slice();
  await installation.recheck();
  checkCommandOperation(operation);
  const policy = createFixturePolicy({
    clock: operation.clock,
    expectedActor: project.principal.actorId,
    currentActor: async () => {
      checkCommandOperation(operation);
      await project.recheck();
      checkCommandOperation(operation);
      return registry.currentPrincipal().actorId;
    },
    onRevoked: () => {},
  });
  try {
    const context = await policy.issue({
      requestId: operation.requestId,
      deadline: operation.deadline,
      signal: operation.signal,
      grants: [
        {
          resourceKind: "artifact",
          resourceId: "foundation_outputs",
          operations: ["read", "write"],
        },
      ],
    });
    checkCommandOperation(operation);
    return await publishDownload(
      project,
      source,
      bytes,
      relative,
      context,
      policy.verify,
      originalOperation,
    );
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      error.code === "CANCELLED" &&
      operation.signal.aborted
    )
      checkCommandOperation(operation);
    throw error;
  } finally {
    policy.revoke();
  }
}
