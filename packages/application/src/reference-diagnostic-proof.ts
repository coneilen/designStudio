import type {
  CommitReceipt,
  FigmaReferenceProposal,
  NativeReferenceEnvelope,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import type { CaptureWork } from "@design-studio/project-host";
import type { StoredJob } from "@design-studio/storage";
import {
  REFERENCE_HANDLER,
  REFERENCE_LIMITATIONS,
  REFERENCE_LIMITS,
} from "../../figma-capture/dist/reference.js";
import { ref, renewalProposal, same } from "./reference-proof.js";
import { ApplicationError } from "./response.js";

export const DIAGNOSTIC_REFERENCE_HANDLER =
  "figma-reference-diagnostic-download-v1";
export function diagnosticReferenceId(
  work: CaptureWork,
  predecessorJob: string,
  receipt: CommitReceipt,
) {
  return `diagnostic_${canonicalDigest(["original-reference-diagnostic-slot-v1", work.project.projectId, predecessorJob, canonicalDigest(receipt)])}`;
}
export function diagnosticReferenceProposal(
  original: NativeReferenceEnvelope,
  record: StoredJob,
  source: FigmaReferenceProposal,
  jobId: string,
  policySha256: string,
): FigmaReferenceProposal {
  const value = original.value;
  const receipt = value?.receipt;
  const evidence = value?.evidence;
  const effect = record.effects[0];
  if (
    value?.phase !== "completed" ||
    !value.consumed ||
    !receipt ||
    !evidence ||
    !value.job ||
    !value.proposal ||
    !value.approval ||
    original.status !== "unavailable" ||
    record.handlerId !== REFERENCE_HANDLER ||
    record.handlerVersion !== "1.0.0" ||
    record.authorityRef !== `reference_${source.referencePolicySha256}` ||
    value.proposal.diagnosticPredecessor ||
    !same(
      value.proposal,
      renewalProposal(
        source,
        value.proposal.approvalGeneration,
        value.proposal.previousApproval,
      ),
    ) ||
    !same(record.job, value.job) ||
    record.job.id !== source.binding.acquisitionId ||
    record.job.operation !== "reference-download" ||
    record.job.status !== "completed" ||
    record.job.outputState !== "partial-inspection" ||
    record.job.error !== undefined ||
    record.requestId !== record.job.id ||
    record.job.attempt !== 1 ||
    record.job.projectId !== source.binding.projectId ||
    record.job.actorId !== source.binding.actorId ||
    !same(record.job.budget, REFERENCE_LIMITS) ||
    !same(record.job.receipt, receipt) ||
    receipt.jobId !== record.job.id ||
    receipt.integrity !== "verified" ||
    receipt.publication !== "atomic" ||
    receipt.outputs.length !== 1 ||
    !receipt.outputs[0] ||
    evidence.referenceStatus !== "unavailable" ||
    evidence.reference !== undefined ||
    evidence.statusCode !== 200 ||
    evidence.errorCode !== "INVALID_INPUT" ||
    evidence.deadline !== record.job.deadline ||
    canonicalDigest(evidence) !== receipt.outputs[0].sha256 ||
    record.usage.externalCalls !== 1 ||
    evidence.usage.externalCalls !== 1 ||
    evidence.usage.dnsQueries !== 1 ||
    record.effects.length !== 1 ||
    !effect ||
    effect.id !== "reference-image-get" ||
    effect.state !== "settled" ||
    effect.reserved.externalCalls !== 1 ||
    effect.actual?.externalCalls !== 1 ||
    !same(effect.reserved, {
      inputBytes: 0,
      outputBytes: 0,
      externalCalls: 1,
      modelTokens: 0,
      costMicros: 0,
    }) ||
    !same(effect.actual, effect.reserved) ||
    !same(evidence.request.binding, source.binding) ||
    !same(evidence.request.approval, value.approval) ||
    canonicalDigest(evidence.request) !== record.job.input.sha256
  )
    throw new ApplicationError("ACTION_REQUIRED");
  const { proofSha256: _proof, ...sourceFacts } = source;
  const facts: Omit<FigmaReferenceProposal, "proofSha256"> = {
    ...sourceFacts,
    binding: { ...source.binding, acquisitionId: jobId },
    approvalGeneration: 0,
    diagnosticPredecessor: {
      jobId: record.job.id,
      recordSha256: canonicalDigest(record),
      receiptSha256: canonicalDigest(receipt),
      request: ref(record.job.input),
      approval: value.approval,
      evidence: ref(receipt.outputs[0]),
      policySha256,
    },
    limitations: [
      ...REFERENCE_LIMITATIONS,
      "One separately consented diagnostic successor; original failure reason remains unknown and all predecessor records remain immutable.",
      "Admission consumes the sole successor slot, including failures; no chaining, automatic GET, URL refresh or version-based reset.",
    ],
  };
  return { ...facts, proofSha256: canonicalDigest(facts) };
}
