import type {
  Artifact,
  ArtifactReference,
  CaptureRecoveryAuthorization,
  CommitReceipt,
} from "@design-studio/contracts";
import type {
  StoredJob,
  StoredJobResource,
  StoredJobStage,
} from "./job-types.js";
import { StorageError } from "./types.js";

export interface CaptureRecoveryState {
  jobs: StoredJob[];
  resources: StoredJobResource[];
  stages: StoredJobStage[];
  artifacts: Artifact[];
  receipts: { scope: string; receipt: CommitReceipt }[];
  references: { kind: string; owner: string; artifactId: string }[];
  otherSha256: string;
}
export interface CaptureRecoveryEvidence {
  authorization: CaptureRecoveryAuthorization;
  artifact: ArtifactReference;
  receipt: CommitReceipt;
}
export const recoveryKey = (jobId: string) => `recovery_${jobId}`;
type Digest = (value: unknown) => string;
function fail(): never {
  throw new StorageError("INTEGRITY", "Capture recovery evidence changed.");
}
const reference = (artifact: ArtifactReference) => ({
  id: artifact.id,
  sha256: artifact.sha256,
});

/** Only exact protected control/seed graphs and the bound successor are projected out. */
export function originalRecoveryState(
  state: CaptureRecoveryState,
  evidence: CaptureRecoveryEvidence,
  digest: Digest,
): CaptureRecoveryState {
  const { authorization: grant, artifact, receipt } = evidence;
  const { proposal } = grant;
  const control = recoveryKey(proposal.originalJobId);
  const expectedScope = (id: string) =>
    JSON.stringify([proposal.projectId, proposal.actorId, "write", id]);
  const seed = `seed_${digest([proposal.nextJobId, grant.nextRequest])}`;
  const ownArtifacts = new Set<string>();
  const ownReceipts = new Set<string>();
  const assertReceipt = (
    entry: CaptureRecoveryState["receipts"][number],
    id: string,
    hashes: string[],
  ) => {
    const saved = entry.receipt;
    if (
      entry.scope !== expectedScope(id) ||
      saved.projectId !== proposal.projectId ||
      saved.jobId !== id ||
      saved.idempotency.projectId !== proposal.projectId ||
      saved.idempotency.actorId !== proposal.actorId ||
      saved.idempotency.operation !== "write" ||
      saved.idempotency.key !== id ||
      saved.integrity !== "verified" ||
      saved.publication !== "atomic" ||
      saved.outputs.length !== hashes.length ||
      saved.outputs.some(
        (output, index) =>
          output.sha256 !== hashes[index] ||
          output.id !== `sha256_${output.sha256}` ||
          output.path !== `blobs/${output.sha256}` ||
          !state.artifacts.some((item) => digest(item) === digest(output)),
      )
    )
      fail();
    const protectedIds = state.references
      .filter((item) => item.kind === "job" && item.owner === saved.id)
      .map((item) => item.artifactId)
      .sort();
    if (
      digest(protectedIds) !==
      digest([...new Set(saved.outputs.map((output) => output.id))].sort())
    )
      fail();
    ownReceipts.add(saved.id);
    for (const output of saved.outputs) ownArtifacts.add(output.id);
  };
  const controls = state.receipts.filter(
    (entry) => entry.scope === expectedScope(control),
  );
  if (
    controls.length !== 1 ||
    digest(controls[0]?.receipt) !== digest(receipt) ||
    receipt.outputs.length !== 1 ||
    digest(reference(receipt.outputs[0] ?? fail())) !== digest(artifact) ||
    artifact.sha256 !== digest(grant)
  )
    fail();
  assertReceipt(controls[0] ?? fail(), control, [artifact.sha256]);
  const seeds = state.receipts.filter(
    (entry) => entry.scope === expectedScope(seed),
  );
  if (seeds.length > 1) fail();
  for (const entry of seeds)
    assertReceipt(entry, seed, [
      digest(grant.nextRequest),
      digest(grant.nextResources),
    ]);
  const successor = state.jobs.find(
    (record) => record.job.id === proposal.nextJobId,
  );
  const original = state.jobs.find(
    (record) => record.job.id === proposal.originalJobId,
  );
  if (!original || digest(original) !== grant.originalRecordSha256) fail();
  if (successor) {
    const expectedInput = {
      id: `sha256_${digest(grant.nextRequest)}`,
      sha256: digest(grant.nextRequest),
    };
    const expectedResources = {
      snapshotId: `sha256_${digest(grant.nextResources)}`,
      sha256: digest(grant.nextResources),
      componentRegistryRevision: "none",
      tokenRegistryRevision: "none",
      selectedModes: {},
    };
    if (
      seeds.length !== 1 ||
      successor.job.projectId !== proposal.projectId ||
      successor.job.actorId !== proposal.actorId ||
      successor.requestId !== proposal.nextRequestId ||
      successor.job.operation !== "capture" ||
      successor.handlerId !== original.handlerId ||
      successor.handlerVersion !== original.handlerVersion ||
      successor.authorityRef !== original.authorityRef ||
      successor.job.attempt > 1 ||
      successor.job.budget.maxAttempts !== 1 ||
      successor.job.budget.maxExternalCalls > 4 ||
      digest(successor.resourceKeys) !== digest(original.resourceKeys) ||
      digest(successor.job.input) !== digest(expectedInput) ||
      digest(successor.job.resources) !== digest(expectedResources) ||
      digest(successor.submission.captureRecovery) !==
        digest({
          originalJobId: proposal.originalJobId,
          authorization: artifact,
        })
    )
      fail();
    const inputIds = state.references
      .filter(
        (item) =>
          item.kind === "job-input" && item.owner === proposal.nextJobId,
      )
      .map((item) => item.artifactId)
      .sort();
    if (
      digest(inputIds) !==
      digest(
        [
          ...new Set([
            expectedInput.id,
            expectedResources.snapshotId,
            artifact.id,
          ]),
        ].sort(),
      )
    )
      fail();
    const completed = state.receipts.filter(
      (entry) => entry.receipt.jobId === successor.job.id,
    );
    if (successor.job.status === "completed") {
      const entry = completed[0] ?? fail();
      const saved = entry.receipt;
      if (
        completed.length !== 1 ||
        entry.scope !==
          JSON.stringify([
            "job-v1",
            proposal.projectId,
            proposal.actorId,
            "capture",
            proposal.nextRequestId,
          ]) ||
        !successor.job.receipt ||
        digest(successor.job.receipt) !== digest(saved) ||
        successor.finalOutputSha256 !== saved.idempotency.payloadSha256 ||
        saved.idempotency.key !== proposal.nextRequestId ||
        saved.idempotency.projectId !== proposal.projectId ||
        saved.idempotency.actorId !== proposal.actorId ||
        saved.idempotency.operation !== "capture" ||
        successor.effects.some(
          (effect) => !["settled", "no-effect"].includes(effect.state),
        ) ||
        !saved.outputs.length ||
        saved.outputs.some(
          (output) =>
            !state.artifacts.some((item) => digest(item) === digest(output)),
        )
      )
        fail();
      const protectedIds = state.references
        .filter((item) => item.kind === "job" && item.owner === saved.id)
        .map((item) => item.artifactId)
        .sort();
      if (
        digest(protectedIds) !==
        digest([...new Set(saved.outputs.map((item) => item.id))].sort())
      )
        fail();
      const stages = state.stages.filter(
        (stage) => stage.jobId === successor.job.id,
      );
      if (
        stages.length !== saved.outputs.length ||
        stages.some(
          (stage) =>
            stage.requestId !== proposal.nextRequestId ||
            stage.attempt !== 1 ||
            stage.fencingToken !== successor.generation ||
            !saved.outputs.some(
              (output) => digest(output) === digest(stage.staged.artifact),
            ),
        )
      )
        fail();
      ownReceipts.add(saved.id);
      for (const output of saved.outputs) ownArtifacts.add(output.id);
    } else if (
      completed.length ||
      state.stages.some((stage) => stage.jobId === successor.job.id)
    ) {
      // No authority to adopt an incomplete successor's retained publications.
      fail();
    }
  }
  const resources = state.resources.map((resource) => {
    const prior = grant.resourceStates.find(
      (item) => item.key === resource.key,
    );
    if (!prior || digest(resource) === digest(prior)) return resource;
    if (
      successor?.job.attempt !== 1 ||
      resource.generation !== prior.generation + 1 ||
      !successor.resourceKeys.includes(resource.key)
    )
      fail();
    if (
      resource.state === "held"
        ? resource.jobId !== successor.job.id ||
          resource.leaseId !== successor.job.lease?.id ||
          resource.fencingToken !== successor.job.lease?.fencingToken ||
          !successor.resources.some(
            (item) =>
              item.key === resource.key &&
              item.generation === resource.generation,
          )
        : resource.state !== "released" ||
          resource.jobId !== null ||
          resource.leaseId !== null ||
          resource.fencingToken !== null ||
          !["failed", "completed", "cancelled"].includes(successor.job.status)
    )
      fail();
    return prior;
  });
  const references = state.references.filter(
    (item) =>
      !(item.kind === "job" && ownReceipts.has(item.owner)) &&
      !(
        successor &&
        item.kind === "job-input" &&
        item.owner === successor.job.id
      ),
  );
  return {
    ...state,
    jobs: state.jobs.filter((record) => record !== successor),
    stages: state.stages.filter((stage) => stage.jobId !== successor?.job.id),
    resources,
    receipts: state.receipts.filter(
      (entry) => !ownReceipts.has(entry.receipt.id),
    ),
    references,
    artifacts: state.artifacts.filter(
      (item) =>
        !ownArtifacts.has(item.id) ||
        references.some((entry) => entry.artifactId === item.id),
    ),
  };
}
