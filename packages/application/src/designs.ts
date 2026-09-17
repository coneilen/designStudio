import {
  type Artifact,
  type Operation,
  type OperationContext,
  type Revision,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import type { FixtureCatalog } from "./catalog.js";
import { fixtureSemantics } from "./fixtures.js";
import { ApplicationError } from "./response.js";
import { PROJECT_ID } from "./routes.js";

export function logicalIdentity(
  actorId: string,
  operation: Operation,
  requestId: string,
) {
  if (
    !validateContract("StableId", actorId).success ||
    !validateContract("StableId", requestId).success
  )
    throw new ApplicationError("INVALID_INPUT");
  const digest = canonicalDigest([
    "fixture-request-v1",
    PROJECT_ID,
    actorId,
    operation,
    requestId,
  ]);
  return { jobId: `job_${digest}`, revisionId: `revision_${digest}` };
}
export function verifyAcceptedRevision(
  catalog: FixtureCatalog,
  revision: Revision,
  context: OperationContext,
  evidence: { artifact: Artifact; bytes: Uint8Array }[],
) {
  if (
    revision.projectId !== PROJECT_ID ||
    revision.actorId !== context.authorization.actorId
  )
    throw new ApplicationError("FORBIDDEN", 403);
  const fixture = fixtureSemantics(
    catalog,
    revision.designId.replace(/^design_/, ""),
  );
  const expected = [
    fixture.contentBytes,
    fixture.resourceBytes,
    fixture.provenanceBytes,
  ];
  const refs = [
    revision.content,
    { id: revision.resources.snapshotId, sha256: revision.resources.sha256 },
    revision.provenance,
  ];
  if (
    canonicalDigest(revision.resources) !==
    canonicalDigest(fixture.design.resources)
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    const bytes = expected[index];
    const actual = evidence.find(
      (entry) => entry.artifact.sha256 === ref?.sha256,
    );
    if (
      !ref ||
      !bytes ||
      !actual ||
      hashBytes(bytes) !== ref.sha256 ||
      hashBytes(actual.bytes) !== ref.sha256 ||
      actual.bytes.length !== bytes.length
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  }
}
