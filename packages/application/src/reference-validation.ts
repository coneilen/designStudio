import type {
  ErrorCode,
  FigmaReferenceApproval,
  FigmaReferenceEvidence,
  FigmaReferenceProposal,
  NativeReferenceEnvelope,
  NativeReferenceRecoveryPlanEnvelope,
  OperationContext,
  ReferenceRecoveryPlan,
  RetainedInventoryFailure,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  authorizeOperation,
  ProjectFileSystem,
  type RetainedReferenceInput,
  type RetainedReferenceInspection,
  snapshotOperationContext,
} from "@design-studio/host";
import {
  acquireCaptureWork,
  type CaptureProject,
  type CaptureWork,
} from "@design-studio/project-host";
import {
  type CaptureRecoveryState,
  LocalStore,
  type StoredJob,
} from "@design-studio/storage";
import {
  REFERENCE_HANDLER,
  REFERENCE_LIMITS,
} from "../../figma-capture/dist/reference.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import { nativeCaptureResources } from "./capture-recovery.js";
import {
  NativeCaptureCleanupRequired,
  NativeCaptureStartupCleanupRequired,
} from "./capture-runtime-internal.js";
import {
  DIAGNOSTIC_REFERENCE_HANDLER,
  diagnosticReferenceId,
  diagnosticReferenceProposal,
} from "./reference-diagnostic-proof.js";
import { ReferenceInput } from "./reference-input.js";
import {
  approvalKey,
  ReferenceReader,
  ref,
  referenceIds,
  renewalProposal,
  same,
} from "./reference-proof.js";
import { retainedReferenceStages } from "./reference-publications.js";
import {
  DIAGNOSTIC_APPROVAL_CONFIRMATION,
  REFERENCE_APPROVAL_CONFIRMATION,
} from "./reference-runtime.js";
import { ApplicationError, safeError, unwrap } from "./response.js";

export interface NativeReferenceRecoveryPlanInput {
  operation: "reference-recovery-plan";
  requestId: string;
  expectedJob: string;
}
const callUsage = {
  inputBytes: 0,
  outputBytes: 0,
  externalCalls: 1,
  modelTokens: 0,
  costMicros: 0,
};

async function approvedRequest(
  reader: ReferenceReader,
  jobId: string,
  source: FigmaReferenceProposal,
  record: StoredJob,
  confirmation: FigmaReferenceApproval["confirmation"],
) {
  let approval: FigmaReferenceApproval | undefined;
  let approved: { id: string; sha256: string } | undefined;
  let requestReference: { id: string; sha256: string } | undefined;
  let gap = false;
  let current = source;
  for (let generation = 0; generation < 32; generation++) {
    const key = approvalKey(jobId, generation);
    const receipt = unwrap(await reader.store.getReceipt(key, reader.context));
    if (!receipt) {
      gap = true;
      continue;
    }
    if (
      gap ||
      receipt.jobId !== key ||
      receipt.integrity !== "verified" ||
      receipt.publication !== "atomic" ||
      receipt.outputs.length !== 2
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const [a, r] = receipt.outputs;
    if (!a || !r) throw new ApplicationError("ARTIFACT_INTEGRITY");
    const prior = approval;
    current = renewalProposal(source, generation, approved);
    approval = await reader.contract("FigmaReferenceApproval", a);
    const request = await reader.contract("FigmaReferenceRequest", r);
    if (
      !same(approval.proposal, current) ||
      approval.confirmation !== confirmation ||
      canonicalDigest(approval) !== a.sha256 ||
      !same(request, {
        schemaVersion: "1.0",
        binding: current.binding,
        approval: ref(a),
      }) ||
      canonicalDigest(request) !== r.sha256 ||
      (prior &&
        Date.parse(prior.expiresAt) > Date.parse(approval.recordedAt)) ||
      Date.parse(approval.expiresAt) <= Date.parse(approval.recordedAt) ||
      Date.parse(approval.expiresAt) >
        Date.parse(approval.recordedAt) + 300000 ||
      (current.urlExpiresAt &&
        Date.parse(approval.expiresAt) > Date.parse(current.urlExpiresAt))
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    approved = ref(a);
    requestReference = ref(r);
  }
  if (!approval || !approved) throw new ApplicationError("EVIDENCE_MISSING");
  const request = await reader.contract(
    "FigmaReferenceRequest",
    record.job.input,
  );
  const resources = nativeCaptureResources(reader.work.project.projectId);
  if (
    !same(record.job.input, requestReference) ||
    !same(request, {
      schemaVersion: "1.0",
      binding: current.binding,
      approval: approved,
    }) ||
    canonicalDigest(request) !== record.job.input.sha256 ||
    record.job.resources.sha256 !== canonicalDigest(resources) ||
    record.job.resources.snapshotId !==
      `sha256_${canonicalDigest(resources)}` ||
    !same(
      await reader.contract("ResourceSnapshot", {
        id: record.job.resources.snapshotId,
        sha256: record.job.resources.sha256,
      }),
      resources,
    )
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return { approval, approved, proposal: current, request };
}

function retainedDiagnostic(
  state: CaptureRecoveryState,
  record: StoredJob,
  work: CaptureWork,
  context: OperationContext,
) {
  const stages = state.stages.filter((s) => s.jobId === record.job.id);
  const effect = record.effects[0];
  const lease = record.job.lease;
  if (
    record.job.status !== "interrupted" ||
    record.job.attempt !== 1 ||
    record.inputRevision ||
    record.submission.inputRevision ||
    record.submission.captureRecovery ||
    record.job.receipt ||
    record.finalOutputSha256 ||
    record.restoredLease ||
    record.effects.length !== 1 ||
    !effect ||
    effect.id !== "reference-image-get" ||
    effect.state !== "settled" ||
    !same(effect.reserved, callUsage) ||
    !same(effect.actual, callUsage) ||
    record.usage.externalCalls !== 1 ||
    record.usage.modelTokens !== 0 ||
    record.usage.costMicros !== 0 ||
    state.receipts.some((r) => r.receipt.jobId === record.job.id) ||
    stages.length !== 2 ||
    !lease ||
    ![lease.fencingToken, lease.fencingToken + 1].includes(record.generation) ||
    context.clock.now() < Date.parse(lease.expiresAt) ||
    context.clock.now() < Date.parse(record.job.deadline) ||
    record.resources.length !== 1 ||
    record.resourceKeys.length !== 1
  )
    throw new ApplicationError("ACTION_REQUIRED");
  const reservation = record.resources[0];
  const resource = state.resources.find((r) => r.key === reservation?.key);
  if (
    !reservation ||
    !resource ||
    resource.state !== "quarantined" ||
    resource.jobId !== record.job.id ||
    resource.leaseId !== lease.id ||
    resource.fencingToken !== lease.fencingToken ||
    resource.generation !== reservation.generation ||
    reservation.key !== record.resourceKeys[0]
  )
    throw new ApplicationError("ACTION_REQUIRED");
  let host: string | undefined;
  for (const stage of stages) {
    if (
      stage.requestId !== record.requestId ||
      stage.artifactRootId !== work.project.artifactRootId ||
      stage.attempt !== 1 ||
      stage.leaseId !== lease.id ||
      stage.fencingToken !== lease.fencingToken ||
      stage.disposition !== "recovery-needed" ||
      stage.stagingId !== stage.staged.stagingId ||
      (host !== undefined && host !== stage.hostInstanceId)
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    host = stage.hostInstanceId;
  }
  const bytes = stages.reduce((n, s) => n + s.staged.artifact.byteLength, 0);
  if (record.usage.inputBytes !== bytes || record.usage.outputBytes !== bytes)
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  return stages.map((stage) => ({
    stagingId: stage.stagingId,
    jobId: stage.jobId,
    requestId: stage.requestId,
    artifact: stage.staged.artifact,
  }));
}

async function validateBytes(
  inspection: RetainedReferenceInspection,
  reader: ReferenceReader,
  record: StoredJob,
  approved: Awaited<ReturnType<typeof approvedRequest>>,
) {
  const candidates: { evidence: FigmaReferenceEvidence; index: number }[] = [];
  for (const [index, target] of inspection.targets.entries()) {
    const bytes = target.bytes;
    if (!bytes || bytes.length > 65536) continue;
    // PNG bytes are not evidence; JSON candidates still require the complete closed contract.
    if (bytes[0] !== 0x7b) continue;
    const evidence = parseContract(
      "FigmaReferenceEvidence",
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "json",
      { maxInputBytes: 65536 },
    );
    if (canonicalDigest(evidence) !== target.descriptor.artifact.sha256)
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    candidates.push({ evidence, index });
  }
  if (candidates.length !== 1 || !candidates[0])
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  const { evidence, index } = candidates[0];
  const image = inspection.targets[1 - index];
  const json = inspection.targets[index];
  const reference = evidence.reference;
  if (
    !image?.bytes ||
    !json?.bytes ||
    !reference ||
    !same(evidence.request, approved.request) ||
    !same(reference.artifact, ref(image.descriptor.artifact)) ||
    !same(reference.bounds, approved.proposal.binding.bounds) ||
    reference.scale !== 1 ||
    evidence.statusCode !== 200 ||
    evidence.errorCode ||
    evidence.retry ||
    evidence.nextEligibleAt ||
    evidence.referenceDiagnostic?.stage !== "png" ||
    evidence.referenceDiagnostic.reason !== "validated" ||
    !["png", "generic-binary"].includes(
      evidence.referenceDiagnostic.mimeClass,
    ) ||
    evidence.referenceStatus === "unavailable" ||
    evidence.deadline !== record.job.deadline ||
    Date.parse(evidence.startedAt) < Date.parse(approved.approval.recordedAt) ||
    Date.parse(evidence.startedAt) >= Date.parse(approved.approval.expiresAt) ||
    Date.parse(evidence.startedAt) < Date.parse(record.createdAt) ||
    Date.parse(evidence.endedAt) < Date.parse(evidence.startedAt) ||
    Date.parse(evidence.endedAt) > Date.parse(evidence.deadline) ||
    evidence.usage.externalCalls !== 1 ||
    evidence.usage.dnsQueries !== 1 ||
    evidence.usage.networkBodyBytes !== image.bytes.length ||
    evidence.usage.networkReceivedBytes < image.bytes.length ||
    evidence.usage.persistedBytes !== image.bytes.length + json.bytes.length
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  await reader.check();
  const decoded = await reader.png(image.bytes);
  const missing: string[] = [];
  if (
    decoded.width !== reference.bounds.width ||
    decoded.height !== reference.bounds.height
  )
    missing.push("reference-dimensions-mismatch");
  if (decoded.colorSpace !== "srgb") missing.push("reference-color-unknown");
  if (
    reference.pixelWidth !== decoded.width ||
    reference.pixelHeight !== decoded.height ||
    reference.colorSpace !== decoded.colorSpace ||
    !same(evidence.missing, missing) ||
    evidence.referenceStatus !== (missing.length ? "partial" : "complete")
  )
    throw new ApplicationError("ARTIFACT_INTEGRITY");
  await reader.check();
  return { evidence, decoded, evidenceIndex: index };
}

/** Separate composition: no writable storage, scheduler, publication or transport capability. */
export async function openNativeReferenceValidation(project: CaptureProject) {
  const work = acquireCaptureWork(project);
  let files: ProjectFileSystem | undefined;
  let store: LocalStore | undefined;
  let databasePin:
    | Awaited<
        ReturnType<NonNullable<CaptureWork["pinReferenceValidationDatabase"]>>
      >
    | undefined;
  let reader: ReferenceReader | undefined;
  let inspection: RetainedReferenceInspection | undefined;
  let expectedInspection: RetainedReferenceInput | undefined;
  let input: ReferenceInput | undefined;
  let active = false;
  let closed = false;
  let cleanupRequired = false;
  let primaryFailure: ErrorCode | undefined;
  let primaryError: unknown;
  const denied = async (): Promise<never> => {
    throw new ApplicationError("FORBIDDEN");
  };
  const authorize = async (context: OperationContext) => {
    if (
      !active ||
      !reader ||
      context.authorization !== reader.context.authorization ||
      context.signal !== reader.context.signal ||
      context.clock !== reader.context.clock ||
      context.deadline !== reader.context.deadline ||
      context.jobId !== reader.context.jobId ||
      context.requestId !== reader.context.requestId
    )
      throw new ApplicationError("FORBIDDEN");
    await reader.check();
  };
  const finishInspection = async () => {
    const errors: unknown[] = [];
    try {
      inspection?.close();
      inspection = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await reader?.close();
      reader = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      files?.closeRetainedProofReads();
    } catch (error) {
      errors.push(error);
    }
    if (!inspection && !reader) expectedInspection = undefined;
    return errors;
  };
  const close = async () => {
    if (closed) return;
    if (active) throw new ApplicationError("INTERRUPTED");
    cleanupRequired = true;
    const errors = await finishInspection();
    try {
      await databasePin?.check();
    } catch (error) {
      errors.push(error);
    }
    try {
      store?.close();
      store = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (!store) {
      try {
        await databasePin?.check();
      } catch (error) {
        errors.push(error);
      }
      try {
        databasePin?.close();
        databasePin = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await files?.closePreservingStages();
      files = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      cleanupRequired = true;
      const failure = new NativeCaptureCleanupRequired(
        primaryFailure ?? "INTERRUPTED",
        safeError(errors[0]).code,
        close,
        [],
      );
      failure.cause = new AggregateError(
        errors,
        "Read-only close did not settle.",
      );
      throw failure;
    }
    try {
      work.close();
    } catch (error) {
      const failure = new NativeCaptureCleanupRequired(
        primaryFailure ?? "INTERRUPTED",
        safeError(error).code,
        close,
        [],
      );
      failure.cause = error;
      throw failure;
    }
    input = undefined;
    closed = true;
  };
  try {
    if (
      !work.referenceValidationAuthority ||
      !work.pinReferenceValidationEntry ||
      !work.pinReferenceValidationDatabase
    )
      throw new ApplicationError("FORBIDDEN");
    await work.referenceValidationAuthority();
    databasePin = await work.pinReferenceValidationDatabase();
    initializeImmutableSqlite(work.sqliteBinding);
    files = await ProjectFileSystem.create({
      projectId: project.projectId,
      authority: work.policy.verify,
      reserveRead: (bytes) => input?.reserveRead(bytes),
      budgetLimits: REFERENCE_LIMITS,
      roots: [
        {
          id: project.artifactRootId,
          path: project.paths.artifacts,
          access: "read",
          managedBlobs: true,
          trustedExclusiveAccess: true,
        },
        {
          id: work.policy.outputRoot,
          path: project.paths.outputs,
          access: "read",
          trustedExclusiveAccess: true,
        },
      ],
      retainedReferenceInspection: {
        artifactRootId: project.artifactRootId,
        outputRootId: work.policy.outputRoot,
        authorize: async (supplied, context) => {
          await authorize(context);
          if (!expectedInspection || !same(expectedInspection, supplied))
            throw new ApplicationError("FORBIDDEN");
        },
        pin: work.pinReferenceValidationEntry.bind(work),
      },
    });
    const fs = files;
    store = await LocalStore.open({
      access: "read-only",
      databasePath: project.paths.database,
      readonlySnapshot: databasePin,
      nativeBinding: work.sqliteBinding,
      projectId: project.projectId,
      artifactRootId: project.artifactRootId,
      permissionScope: work.permissionScope,
      snapshotOperationContext,
      canonicalBytes,
      attestLocalDatabase: work.attestDatabase.bind(work),
      fileSystem: {
        read: fs.read.bind(fs),
        stage: denied,
        publish: denied,
        discard: denied,
      },
      referenceInspection: { authorize },
      authorize: async (context, scope) => {
        await work.current();
        await work.referenceValidationAuthority?.();
        if (scope.operation !== "read") throw new ApplicationError("FORBIDDEN");
        authorizeOperation(
          context,
          scope.resourceKind === "artifact"
            ? { ...scope, resourceId: project.artifactRootId }
            : scope,
          work.policy.verify,
        );
      },
      ensurePublicationDurable: denied,
      ensureDatabaseBackupDurable: denied,
      verifyRevision: denied,
      assessApproval: denied,
      authorizeRestore: denied,
      authorizeRetention: denied,
      canDiscardStage: denied,
      maintenance: { inventory: denied, removeBlob: denied },
      jobs: {
        clock: work.policy.clock,
        limits: REFERENCE_LIMITS,
        discovery: { authorizeOwner: authorize },
        verifyCompletion: denied,
        authorizeRecovery: denied,
      },
    });
  } catch (error) {
    try {
      await close();
    } catch {
      throw new NativeCaptureStartupCleanupRequired(close);
    }
    throw error;
  }
  const db = store;
  const fs = files;
  return {
    close,
    async execute(
      supplied: NativeReferenceRecoveryPlanInput,
      signal: AbortSignal,
    ): Promise<NativeReferenceRecoveryPlanEnvelope> {
      if (closed || active || cleanupRequired)
        throw new ApplicationError("FORBIDDEN");
      const owned = Object.freeze(structuredClone(supplied));
      active = true;
      primaryFailure = undefined;
      primaryError = undefined;
      input = new ReferenceInput();
      let reason: NativeReferenceRecoveryPlanEnvelope["reason"] =
        "invalid-input";
      const base = {
        schemaVersion: "1.0" as const,
        operation: "reference-recovery-plan" as const,
        projectId: project.projectId,
        requestId: owned.requestId,
      };
      let result: NativeReferenceRecoveryPlanEnvelope;
      let cleanupFailure: NativeCaptureCleanupRequired | undefined;
      let finalContext: OperationContext | undefined;
      let inventoryFailure: RetainedInventoryFailure | undefined;
      try {
        if (
          Object.keys(owned).sort().join(",") !==
            "expectedJob,operation,requestId" ||
          owned.operation !== "reference-recovery-plan" ||
          !validateContract("StableId", owned.requestId).success ||
          !validateContract("Sha256", owned.expectedJob).success
        )
          throw new ApplicationError("INVALID_INPUT");
        reason = "authority-denied";
        const policySha256 = await work.referenceValidationAuthority?.();
        if (!policySha256 || !databasePin)
          throw new ApplicationError("FORBIDDEN");
        await databasePin?.check();
        const ids = referenceIds(work, owned.requestId);
        const deadline = new Date(
          work.policy.clock.now() + 30000,
        ).toISOString();
        const issue = async (jobId: string, jobReads: string[]) => {
          await reader?.close();
          const context = await work.policy.issueReferenceValidation({
            jobId,
            requestId: owned.requestId,
            jobReads,
            deadline,
            signal,
          });
          finalContext = context;
          reader = new ReferenceReader(
            work,
            db,
            fs,
            context,
            input ?? new ReferenceInput(),
            true,
            true,
          );
          return reader;
        };
        let proof = await issue(ids.approval, [ids.original, ids.job]);
        reason = "source-metadata-invalid";
        const predecessorMetadata = unwrap(
          await db.referenceJobMetadata(ids.job, proof.context),
        );
        if (!predecessorMetadata?.receipt)
          throw new ApplicationError("EVIDENCE_MISSING");
        const jobId = diagnosticReferenceId(
          work,
          ids.job,
          predecessorMetadata.receipt,
        );
        proof = await issue(ids.approval, [
          ids.original,
          ids.job,
          jobId,
          ...[ids.job, jobId].flatMap((id) =>
            Array.from({ length: 32 }, (_, n) => approvalKey(id, n)),
          ),
        ]);
        reason = "job-changed";
        const metadata = unwrap(
          await db.referenceJobMetadata(jobId, proof.context),
        );
        if (
          !metadata ||
          canonicalDigest(metadata.record.job) !== owned.expectedJob
        )
          throw new ApplicationError("CONFLICT");
        reason = "ineligible-job";
        const state = unwrap(await db.referencePublicationState(proof.context));
        const record = state.jobs.find((r) => r.job.id === jobId);
        if (
          !record ||
          !same(record, metadata.record) ||
          metadata.receipt ||
          record.handlerId !== DIAGNOSTIC_REFERENCE_HANDLER ||
          record.handlerVersion !== "1.0.0" ||
          record.authorityRef !==
            `diagnostic_${await work.diagnosticAuthority?.()}` ||
          record.job.id !== jobId ||
          record.requestId !== jobId ||
          record.job.operation !== "reference-download" ||
          record.job.projectId !== project.projectId ||
          record.job.actorId !== work.actorId ||
          !same(record.resourceKeys, [`diagnostic_${ids.job}`]) ||
          !same(record.job.budget, REFERENCE_LIMITS)
        )
          throw new ApplicationError("ACTION_REQUIRED");
        const targets = retainedDiagnostic(state, record, work, proof.context);
        if (
          !same(
            metadata.stages,
            state.stages.filter((s) => s.jobId === jobId),
          )
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        reason = "source-proof-invalid";
        const source = await proof.proposal(owned.requestId);
        const predecessor = unwrap(await db.jobs.get(ids.job, proof.context));
        const receipt = unwrap(
          await db.jobs.getJobReceipt(ids.job, proof.context),
        );
        if (
          !receipt ||
          !same(predecessor, predecessorMetadata.record) ||
          !same(receipt, predecessorMetadata.receipt) ||
          predecessor.handlerId !== REFERENCE_HANDLER
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const original = await approvedRequest(
          proof,
          ids.job,
          source.proposal,
          predecessor,
          REFERENCE_APPROVAL_CONFIRMATION,
        );
        const originalEvidence = receipt.outputs[0];
        if (!originalEvidence) throw new ApplicationError("EVIDENCE_MISSING");
        const evidence = await proof.contract(
          "FigmaReferenceEvidence",
          originalEvidence,
        );
        const originalEnvelope: NativeReferenceEnvelope = {
          schemaVersion: "1.0",
          operation: "reference-inspect",
          projectId: project.projectId,
          requestId: owned.requestId,
          status: "unavailable",
          value: {
            phase: "completed",
            consumed: true,
            proposal: original.proposal,
            approval: original.approved,
            job: predecessor.job,
            receipt,
            evidence,
          },
        };
        const proposal = diagnosticReferenceProposal(
          originalEnvelope,
          predecessor,
          source.proposal,
          jobId,
          (await work.diagnosticAuthority?.()) ?? "",
        );
        const approved = await approvedRequest(
          proof,
          jobId,
          proposal,
          record,
          DIAGNOSTIC_APPROVAL_CONFIRMATION,
        );
        reason = "inventory-invalid";
        const history = await retainedReferenceStages(
          proof,
          {
            ...state,
            jobs: state.jobs.filter((r) => r.job.id !== jobId),
            stages: state.stages.filter((s) => s.jobId !== jobId),
          },
          proposal,
        );
        expectedInspection = { artifacts: state.artifacts, targets, history };
        input.phase = "inspection";
        const inspected = await fs.inspectRetainedReference(
          expectedInspection,
          proof.context,
        );
        if (
          inspected.status !== "complete" &&
          inspected.status !== "partial" &&
          inspected.status !== "cancelled" &&
          inspected.inventoryFailure
        ) {
          const diagnostic = validateContract(
            "RetainedInventoryFailure",
            inspected.inventoryFailure,
          );
          if (diagnostic.success)
            inventoryFailure = structuredClone(diagnostic.value);
        }
        inspection = unwrap(inspected);
        if (
          inspection.targets.some(
            (t) => t.publication === "known-pair-native-read-blocked",
          )
        ) {
          reason = "known-pair-native-read-blocked";
          throw new ApplicationError("ACTION_REQUIRED");
        }
        reason = "evidence-invalid";
        const validated = await validateBytes(
          inspection,
          proof,
          record,
          approved,
        );
        reason = "state-changed";
        await inspection.check();
        if (
          !same(
            state,
            unwrap(await db.referencePublicationState(proof.context)),
          )
        )
          throw new ApplicationError("CONFLICT");
        await databasePin?.check();
        await proof.check();
        const projectedStage = (
          index: number,
          role: "evidence" | "reference",
        ): ReferenceRecoveryPlan["stages"][number] => {
          const target = inspection?.targets[index];
          if (
            !target ||
            target.publication === "known-pair-native-read-blocked"
          )
            throw new ApplicationError("FORBIDDEN");
          return {
            role,
            sha256: target.descriptor.artifact.sha256,
            byteLength: target.descriptor.artifact.byteLength,
            disposition: "recovery-needed",
            publication: target.publication,
          };
        };
        const facts: Omit<ReferenceRecoveryPlan, "proofSha256"> = {
          verification: "retained-bytes",
          eligibility: "eligible-for-recovery-review",
          consumed: true,
          historicalStatus: "interrupted",
          jobId,
          jobSha256: owned.expectedJob,
          stateSha256: canonicalDigest(state),
          identitySha256: canonicalDigest([
            inspection.identitySha256,
            databasePin.identitySha256,
          ]),
          sourceSha256: proposal.binding.source.sha256,
          approvalSha256: approved.approved.sha256,
          policySha256,
          referenceStatus:
            validated.evidence.referenceStatus === "complete"
              ? "complete"
              : "partial",
          pixelWidth: validated.decoded.width,
          pixelHeight: validated.decoded.height,
          colorSpace: validated.decoded.colorSpace,
          stages: [
            projectedStage(validated.evidenceIndex, "evidence"),
            projectedStage(1 - validated.evidenceIndex, "reference"),
          ],
        };
        result = {
          ...base,
          status: "complete",
          value: { ...facts, proofSha256: canonicalDigest(facts) },
        };
        await proof.check();
      } catch (error) {
        const failure = safeError(error);
        primaryError = error;
        primaryFailure = failure.code;
        result = {
          ...base,
          status: failure.code === "CANCELLED" ? "cancelled" : "failed",
          reason:
            failure.code === "INPUT_LIMIT"
              ? "input-limit"
              : failure.code === "CANCELLED"
                ? "cancelled"
                : failure.code === "DEADLINE_EXCEEDED"
                  ? "deadline-exceeded"
                  : reason,
          error: {
            code: failure.code,
            message:
              "Retained-byte validation did not establish an eligible recovery plan.",
            retryable: false,
            diagnosticIds: [],
          },
          ...(failure.code !== "CANCELLED" && inventoryFailure
            ? { inventoryFailure }
            : {}),
        };
      } finally {
        const errors = await finishInspection();
        active = false;
        if (errors.length || fs.hasRetainedReadClosures) {
          cleanupRequired = true;
          const failure = new NativeCaptureCleanupRequired(
            primaryFailure ?? "INTERRUPTED",
            errors.length ? safeError(errors[0]).code : "INTERRUPTED",
            close,
            [],
          );
          failure.cause = new AggregateError(
            [...(primaryError ? [primaryError] : []), ...errors],
            `Read-only validation cleanup failed during ${reason}.`,
          );
          cleanupFailure = failure;
        }
      }
      if (cleanupFailure) throw cleanupFailure;
      if (
        result.status === "complete" &&
        (signal.aborted ||
          (finalContext &&
            finalContext.clock.now() >= Date.parse(finalContext.deadline)))
      ) {
        result = {
          ...base,
          status: signal.aborted ? "cancelled" : "failed",
          reason: signal.aborted ? "cancelled" : "deadline-exceeded",
          error: {
            code: signal.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED",
            message:
              "Retained validation did not finish within its active operation.",
            retryable: false,
            diagnosticIds: [],
          },
        };
      }
      result.inputAccounting = input.snapshot();
      const checked = validateContract(
        "NativeReferenceRecoveryPlanEnvelope",
        result,
      );
      if (!checked.success || canonicalBytes(result).length > 8192)
        throw new ApplicationError("INTERNAL_ERROR");
      return checked.value;
    },
  };
}
