import type {
  Artifact,
  FigmaReferenceProposal,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import type { CaptureRecoveryStage } from "@design-studio/host";
import {
  type CaptureRecoveryState,
  originalRecoveryState,
  recoveryKey,
} from "@design-studio/storage";
import { type ReferenceReader, ref, same } from "./reference-proof.js";
import { ApplicationError } from "./response.js";

function authenticatedReferenceDescendant(
  state: CaptureRecoveryState,
  proposal: FigmaReferenceProposal,
): string | undefined {
  const proof = proposal.diagnosticPredecessor;
  if (!proof) return undefined;
  const records = state.jobs.filter((entry) => entry.job.id === proof.jobId);
  const record = records[0];
  const receipts = state.receipts.filter(
    (entry) => entry.receipt.jobId === proof.jobId,
  );
  const entry = receipts[0];
  if (
    records.length !== 1 ||
    !record ||
    receipts.length !== 1 ||
    !entry ||
    canonicalDigest(record) !== proof.recordSha256 ||
    canonicalDigest(entry.receipt) !== proof.receiptSha256 ||
    record.handlerId !== "figma-reference-download-v1" ||
    record.handlerVersion !== "1.0.0" ||
    record.authorityRef !== `reference_${proposal.referencePolicySha256}` ||
    record.requestId !== proof.jobId ||
    record.job.status !== "completed" ||
    record.job.operation !== "reference-download" ||
    record.job.attempt !== 1 ||
    !same(record.job.input, proof.request) ||
    !same(record.resourceKeys, [
      `reference_${proposal.binding.originalJobId}`,
    ]) ||
    entry.scope !==
      JSON.stringify([
        "job-v1",
        proposal.binding.projectId,
        proposal.binding.actorId,
        "reference-download",
        proof.jobId,
      ]) ||
    entry.receipt.projectId !== proposal.binding.projectId ||
    entry.receipt.idempotency.projectId !== proposal.binding.projectId ||
    entry.receipt.idempotency.actorId !== proposal.binding.actorId ||
    entry.receipt.idempotency.operation !== "reference-download" ||
    entry.receipt.idempotency.key !== proof.jobId ||
    !same(record.job.receipt, entry.receipt) ||
    record.finalOutputSha256 !== entry.receipt.idempotency.payloadSha256 ||
    entry.receipt.integrity !== "verified" ||
    entry.receipt.publication !== "atomic" ||
    entry.receipt.outputs.length !== 1 ||
    !entry.receipt.outputs[0] ||
    !same(ref(entry.receipt.outputs[0]), proof.evidence) ||
    !state.artifacts.some((artifact) =>
      same(artifact, entry.receipt.outputs[0]),
    )
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  const inputIds = state.references
    .filter((r) => r.kind === "job-input" && r.owner === proof.jobId)
    .map((r) => r.artifactId)
    .sort();
  const outputIds = state.references
    .filter((r) => r.kind === "job" && r.owner === entry.receipt.id)
    .map((r) => r.artifactId)
    .sort();
  const stages = state.stages.filter((stage) => stage.jobId === proof.jobId);
  if (
    !same(
      inputIds,
      [...new Set([proof.request.id, record.job.resources.snapshotId])].sort(),
    ) ||
    !same(outputIds, [proof.evidence.id]) ||
    stages.length !== 1 ||
    stages.some(
      (stage) =>
        stage.requestId !== record.requestId ||
        stage.attempt !== 1 ||
        stage.fencingToken !== record.generation ||
        !same(stage.staged.artifact, entry.receipt.outputs[0]),
    )
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return proof.jobId;
}

export async function retainedReferenceStages(
  reader: ReferenceReader,
  state: CaptureRecoveryState,
  proposal: FigmaReferenceProposal,
): Promise<CaptureRecoveryStage[]> {
  return (await retainedReferenceInventory(reader, state, proposal)).stages;
}

export async function retainedReferenceInventory(
  reader: ReferenceReader,
  state: CaptureRecoveryState,
  proposal: FigmaReferenceProposal,
): Promise<{
  stages: CaptureRecoveryStage[];
  committedHistoryArtifacts: Artifact[];
}> {
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
    return { stages: [], committedHistoryArtifacts: [] };
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
  const referenceDescendant = authenticatedReferenceDescendant(state, proposal);
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
  const jobs = new Set(
    historic.jobs
      .filter((record) => record.job.id !== referenceDescendant)
      .map((record) => record.job.id),
  );
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
  const historicalArtifacts = historic.artifacts.filter((artifact) =>
    ids.has(artifact.id),
  );
  if (
    canonicalDigest({
      artifacts: historicalArtifacts,
      stages: descriptors,
    }) !== grant.filesystemSha256
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return {
    stages: descriptors,
    committedHistoryArtifacts: historicalArtifacts.filter((artifact) =>
      descriptors.some((stage) => same(stage.artifact, artifact)),
    ),
  };
}
