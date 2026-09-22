import type { FigmaReferenceProposal } from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import type { CaptureRecoveryStage } from "@design-studio/host";
import {
  type CaptureRecoveryState,
  originalRecoveryState,
  recoveryKey,
} from "@design-studio/storage";
import { type ReferenceReader, ref, same } from "./reference-proof.js";
import { ApplicationError } from "./response.js";

export async function retainedReferenceStages(
  reader: ReferenceReader,
  state: CaptureRecoveryState,
  proposal: FigmaReferenceProposal,
): Promise<CaptureRecoveryStage[]> {
  const successor = state.jobs.find(
    (record) => record.job.id === proposal.binding.originalJobId,
  );
  if (
    !successor ||
    canonicalDigest(successor) !== proposal.binding.originalRecordSha256
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  const binding = successor.submission.captureRecovery;
  const pending = state.stages.filter((stage) => {
    const owner = state.jobs.find((record) => record.job.id === stage.jobId);
    const receipt = state.receipts.find(
      (entry) => entry.receipt.jobId === stage.jobId,
    )?.receipt;
    if (owner?.job.status !== "completed") return true;
    if (
      !receipt ||
      !same(owner.job.receipt, receipt) ||
      stage.requestId !== owner.requestId ||
      stage.attempt !== owner.job.attempt ||
      stage.fencingToken !== owner.generation ||
      !receipt.outputs.some((artifact) => same(artifact, stage.staged.artifact))
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    return false;
  });
  if (!binding) {
    if (pending.length) throw new ApplicationError("ACTION_REQUIRED");
    return [];
  }
  const key = recoveryKey(binding.originalJobId);
  const receipts = state.receipts.filter(
    (entry) => entry.receipt.jobId === key,
  );
  const receipt = receipts[0]?.receipt;
  if (
    receipts.length !== 1 ||
    !receipt ||
    receipt.outputs.length !== 1 ||
    !same(
      ref(receipt.outputs[0] ?? binding.authorization),
      binding.authorization,
    )
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  const grant = await reader.contract(
    "CaptureRecoveryAuthorization",
    binding.authorization,
  );
  const original = state.jobs.find(
    (record) => record.job.id === binding.originalJobId,
  );
  if (
    !original ||
    canonicalDigest(original) !== grant.originalRecordSha256 ||
    canonicalDigest(grant) !== binding.authorization.sha256 ||
    grant.proposal.projectId !== proposal.binding.projectId ||
    grant.proposal.actorId !== proposal.binding.actorId ||
    grant.proposal.originalJobId !== original.job.id ||
    grant.proposal.originalRequestId !== original.requestId ||
    grant.proposal.nextJobId !== successor.job.id ||
    grant.proposal.nextRequestId !== successor.requestId ||
    grant.artifactRootId !== reader.work.project.artifactRootId ||
    grant.permissionScope !== reader.work.permissionScope ||
    grant.basePolicySha256 !== reader.work.policySha256 ||
    canonicalDigest(grant.nextRequest) !== successor.job.input.sha256 ||
    original.job.status !== "failed" ||
    original.job.attempt !== 1 ||
    ![1, 3].includes(original.generation)
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  // This validates the immutable successor/control protection graph without invoking
  // recovery issuance or its current credential-journal authority.
  const historic = originalRecoveryState(
    state,
    {
      authorization: grant,
      artifact: binding.authorization,
      receipt,
    },
    canonicalDigest,
  );
  let lease: string | undefined;
  let host: string | undefined;
  const descriptors = pending.map((stage) => {
    if (
      stage.jobId !== original.job.id ||
      stage.requestId !== original.requestId ||
      stage.artifactRootId !== grant.artifactRootId ||
      stage.attempt !== 1 ||
      stage.fencingToken !== 1 ||
      stage.disposition !==
        (original.generation === 3 ? "recovery-needed" : "retained") ||
      (lease !== undefined &&
        (stage.leaseId !== lease || stage.hostInstanceId !== host))
    )
      throw new ApplicationError("ACTION_REQUIRED");
    lease = stage.leaseId;
    host = stage.hostInstanceId;
    return {
      stagingId: stage.stagingId,
      artifact: stage.staged.artifact,
      jobId: stage.jobId,
      requestId: stage.requestId,
    };
  });
  // Only the protected closure of the remaining immutable jobs can prove this
  // historical inventory. New ordinary conversion/approval receipts remain
  // validated in the current graph but cannot assert historical membership.
  const jobs = new Set(historic.jobs.map((record) => record.job.id));
  const owners = new Set(
    historic.receipts
      .filter((entry) => jobs.has(entry.receipt.jobId))
      .map((entry) => entry.receipt.id),
  );
  const ids = new Set(
    historic.references
      .filter(
        (entry) =>
          (entry.kind === "job-input" && jobs.has(entry.owner)) ||
          (entry.kind === "job" && owners.has(entry.owner)),
      )
      .map((entry) => entry.artifactId),
  );
  if (
    canonicalDigest({
      artifacts: historic.artifacts.filter((artifact) => ids.has(artifact.id)),
      stages: descriptors,
    }) !== grant.filesystemSha256
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return descriptors;
}
