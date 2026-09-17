import {
  type Artifact,
  type OperationContext,
  validateContract,
} from "@design-studio/contracts";
import { hashBytes } from "@design-studio/design-ir";
import {
  type Authority,
  authorizeOperation,
  ProjectFileSystem,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import type { FixtureProjectBinding } from "@design-studio/project-host";
import { ApplicationError, unwrap } from "./response.js";
import { ARTIFACT_ROOT, PERMISSION_SCOPE, PROJECT_ID } from "./routes.js";

export async function publishDownload(
  binding: FixtureProjectBinding,
  input: Artifact,
  inputBytes: Uint8Array,
  relative: string,
  originalContext: OperationContext,
  authority: Authority,
): Promise<Artifact> {
  const context = snapshotOperationContext(originalContext);
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
    const pending = unwrap(await files.stage(request, bytes, context));
    staged = true;
    const artifact = unwrap(await files.publish(pending, context));
    unwrap(
      await files.ensurePublicationDurable(
        request.artifactRootId,
        [artifact],
        context,
      ),
    );
    await binding.recheck();
    complete = true;
    return artifact;
  } finally {
    // Failed or uncertain stages are retained; close would silently discard their evidence.
    if (complete || !staged) await files.close();
  }
}
