import {
  type Artifact,
  type OperationContext,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import {
  type Authority,
  authorizeOperation,
  ProjectFileSystem,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import type { FixtureProjectBinding } from "@design-studio/project-host";
import {
  type CommandOperation,
  checkCommandOperation,
  snapshotCommandOperation,
} from "./command-lifetime.js";
import { ApplicationError, unwrap } from "./response.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "./routes.js";

interface CompletedDownload {
  command: CommandOperation;
  ownedCommand: CommandOperation;
  artifactDigest: string;
  sourceDigest: string;
  relative: string;
  rootId: "foundation_outputs";
}
// Runtime delivery evidence only: issued by this native publisher after all checks,
// never reconstructed from a callback's artifact, a hash, or persisted output.
const completed = new WeakMap<Artifact, CompletedDownload>();
export function downloadResult(
  artifact: Artifact,
  operation: CommandOperation,
  source: Artifact,
  relative: string,
): Artifact {
  const command = snapshotCommandOperation(operation);
  if (
    !validateContract("Artifact", artifact).success ||
    artifact.sha256 !== source.sha256 ||
    artifact.byteLength !== source.byteLength ||
    artifact.path !== relative ||
    artifact.mediaType !== "application/octet-stream"
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  const proof = completed.get(artifact);
  if (
    proof &&
    proof.command === operation &&
    proof.ownedCommand.deadline === operation.deadline &&
    proof.ownedCommand.requestId === operation.requestId &&
    proof.ownedCommand.signal === operation.signal &&
    proof.ownedCommand.clock === operation.clock &&
    proof.relative === relative &&
    proof.rootId === "foundation_outputs" &&
    proof.artifactDigest === canonicalDigest(artifact) &&
    proof.sourceDigest === canonicalDigest(source)
  ) {
    completed.delete(artifact);
    return artifact;
  }
  if (proof) throw new ApplicationError("FORBIDDEN", 403);
  checkCommandOperation(command);
  return artifact;
}
export async function publishDownload(
  binding: FixtureProjectBinding,
  input: Artifact,
  inputBytes: Uint8Array,
  relative: string,
  originalContext: OperationContext,
  authority: Authority,
  operation: CommandOperation = {
    requestId: originalContext.requestId,
    deadline: originalContext.deadline,
    clock: originalContext.clock,
    signal: originalContext.signal,
  },
): Promise<Artifact> {
  const context = snapshotOperationContext(originalContext);
  const command = snapshotCommandOperation(operation);
  if (
    context.requestId !== command.requestId ||
    context.signal !== command.signal ||
    context.clock !== command.clock ||
    Date.parse(context.deadline) > Date.parse(command.deadline)
  )
    throw new ApplicationError("FORBIDDEN", 403);
  checkCommandOperation(command);
  if (
    !validateContract("Artifact", input).success ||
    !(inputBytes instanceof Uint8Array) ||
    inputBytes.buffer instanceof SharedArrayBuffer ||
    inputBytes.length > context.budget.maxInputBytes
  )
    throw new ApplicationError("INVALID_INPUT");
  const source = structuredClone(input);
  const bytes = inputBytes.slice();
  const request = { artifactRootId: "foundation_outputs", path: relative };
  if (!validateContract("FileRequest", request).success)
    throw new ApplicationError("PATH_FORBIDDEN", 403);
  await binding.recheck();
  checkCommandOperation(command);
  if (
    binding.scope.projectId !== PROJECT_ID ||
    binding.scope.artifactRootId !== ARTIFACT_ROOT ||
    binding.scope.permissionScope !== PERMISSION_SCOPE ||
    context.authorization.actorId !== binding.principal.actorId
  )
    throw new ApplicationError("FORBIDDEN", 403);
  authorizeOperation(
    context,
    {
      projectId: PROJECT_ID,
      resourceKind: "artifact",
      resourceId: request.artifactRootId,
      operation: "write",
    },
    authority,
  );
  if (source.sha256 !== hashBytes(bytes) || source.byteLength !== bytes.length)
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  const files = await ProjectFileSystem.create({
    projectId: PROJECT_ID,
    authority,
    publicationProfile: WINDOWS_PUBLICATION_PROFILE,
    roots: [
      {
        id: request.artifactRootId,
        path: binding.paths.outputs,
        access: "read-write",
        trustedExclusiveAccess: true,
      },
    ],
  });
  let complete = false;
  let staged = false;
  try {
    checkCommandOperation(command);
    staged = true;
    const pending = unwrap(await files.stage(request, bytes, context));
    checkCommandOperation(command);
    const artifact = unwrap(await files.publish(pending, context));
    checkCommandOperation(command);
    unwrap(
      await files.ensurePublicationDurable(
        request.artifactRootId,
        [artifact],
        context,
      ),
    );
    checkCommandOperation(command);
    await binding.recheck();
    checkCommandOperation(command);
    authorizeOperation(
      context,
      {
        projectId: PROJECT_ID,
        resourceKind: "artifact",
        resourceId: request.artifactRootId,
        operation: "write",
      },
      authority,
    );
    checkCommandOperation(command);
    completed.set(artifact, {
      command: operation,
      ownedCommand: command,
      artifactDigest: canonicalDigest(artifact),
      sourceDigest: canonicalDigest(source),
      relative,
      rootId: "foundation_outputs",
    });
    complete = true;
    return artifact;
  } finally {
    // Failed or uncertain stages are retained; close would silently discard their evidence.
    if (complete || !staged) await files.close();
  }
}
