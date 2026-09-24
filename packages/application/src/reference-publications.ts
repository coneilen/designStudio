import type {
  Artifact,
  FigmaReferenceProposal,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
} from "@design-studio/figma-capture";
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
  verifiedCapture?: object,
): Promise<{
  stages: CaptureRecoveryStage[];
  committedHistoryArtifacts: Artifact[];
  successorCaptureHistoryArtifacts: Artifact[];
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
    return {
      stages: [],
      committedHistoryArtifacts: [],
      successorCaptureHistoryArtifacts: [],
    };
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
  let successorCaptureHistoryArtifacts: Artifact[] = [];
  if (verifiedCapture) {
    const verified = reader.verifiedCaptureOutputs(verifiedCapture, proposal);
    const entries = state.receipts.filter(
      (entry) => entry.receipt.jobId === successor.job.id,
    );
    const entry = entries[0];
    const captured = entry?.receipt;
    const outputIds = state.references
      .filter((r) => r.kind === "job" && r.owner === captured?.id)
      .map((r) => r.artifactId)
      .sort();
    const inputIds = state.references
      .filter((r) => r.kind === "job-input" && r.owner === successor.job.id)
      .map((r) => r.artifactId)
      .sort();
    if (
      state.jobs.filter((r) => r.job.id === successor.job.id).length !== 1 ||
      entries.length !== 1 ||
      !entry ||
      !captured ||
      successor.job.id !== proposal.binding.originalJobId ||
      successor.requestId !== proposal.binding.originalRequestId ||
      successor.job.projectId !== proposal.binding.projectId ||
      successor.job.actorId !== proposal.binding.actorId ||
      successor.handlerId !== CAPTURE_HANDLER_ID ||
      successor.handlerVersion !== CAPTURE_HANDLER_VERSION ||
      successor.authorityRef !== `native_${reader.work.policySha256}` ||
      successor.job.operation !== "capture" ||
      successor.job.status !== "completed" ||
      successor.job.attempt !== 1 ||
      canonicalDigest(successor) !== proposal.binding.originalRecordSha256 ||
      canonicalDigest(captured) !== proposal.binding.originalReceiptSha256 ||
      !same(captured, verified.receipt) ||
      !same(successor.job.receipt, captured) ||
      entry.scope !==
        JSON.stringify([
          "job-v1",
          proposal.binding.projectId,
          proposal.binding.actorId,
          "capture",
          successor.requestId,
        ]) ||
      captured.projectId !== proposal.binding.projectId ||
      captured.jobId !== successor.job.id ||
      captured.idempotency.projectId !== proposal.binding.projectId ||
      captured.idempotency.actorId !== proposal.binding.actorId ||
      captured.idempotency.operation !== "capture" ||
      captured.idempotency.key !== successor.requestId ||
      captured.integrity !== "verified" ||
      captured.publication !== "atomic" ||
      successor.finalOutputSha256 !== captured.idempotency.payloadSha256 ||
      !same(outputIds, captured.outputs.map((a) => a.id).sort()) ||
      !same(
        inputIds,
        [
          ...new Set([
            successor.job.input.id,
            successor.job.resources.snapshotId,
            binding.authorization.id,
          ]),
        ].sort(),
      ) ||
      captured.outputs.some(
        (artifact) =>
          !state.artifacts.some((current) => same(current, artifact)),
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    successorCaptureHistoryArtifacts = verified.artifacts
      .filter((item) => ["metadata", "nodes", "render-map"].includes(item.role))
      .map((item) => item.artifact)
      .filter((artifact) =>
        descriptors.some((stage) => same(stage.artifact, artifact)),
      );
    if (
      successorCaptureHistoryArtifacts.some(
        (artifact) =>
          !captured.outputs.some((output) => same(output, artifact)),
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
  }
  // Prefer the older grant provenance when the exact artifact is proven by both.
  return {
    stages: descriptors,
    committedHistoryArtifacts: historicalArtifacts.filter((artifact) =>
      descriptors.some((stage) => same(stage.artifact, artifact)),
    ),
    successorCaptureHistoryArtifacts: successorCaptureHistoryArtifacts.filter(
      (artifact) =>
        !historicalArtifacts.some((historic) => same(historic, artifact)),
    ),
  };
}
