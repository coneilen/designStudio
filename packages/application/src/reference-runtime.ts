import type {
  AuthorizationContext,
  CommitReceipt,
  ErrorCode,
  FigmaReferenceApproval,
  FigmaReferenceRequest,
  NativeReferenceEnvelope,
  OperationContext,
  ReferenceDiagnostic,
  ResourceSnapshot,
} from "@design-studio/contracts";
import {
  referenceDiagnosticFields,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import type {
  CaptureRecoveryStage,
  ProjectFileSystem,
} from "@design-studio/host";
import {
  createJobService,
  type JobService,
  type TrustedJobHandler,
} from "@design-studio/jobs";
import type { CaptureWork } from "@design-studio/project-host";
import type {
  JobStorageOptions,
  LocalStore,
  StoredJob,
} from "@design-studio/storage";
import {
  acquireReference,
  REFERENCE_HANDLER,
  REFERENCE_LIMITS,
  REFERENCE_ORIGIN,
  ReferenceBudget,
} from "../../figma-capture/dist/reference.js";
import { nativeCaptureResources } from "./capture-recovery.js";
import type { RecoveryDecisions } from "./recovery.js";
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
import { ApplicationError, safeError, unwrap } from "./response.js";

export const REFERENCE_APPROVAL_CONFIRMATION = "APPROVE-ONE-SELECTED-REFERENCE";
export const REFERENCE_DOWNLOAD_CONFIRMATION =
  "DOWNLOAD-ONE-APPROVED-REFERENCE";
export interface NativeReferenceInput {
  operation: NativeReferenceEnvelope["operation"];
  requestId: string;
  origin?: string;
  expectedProof?: string;
  expectedApproval?: string;
  confirmation?: string;
}
type Prepared = Awaited<ReturnType<typeof acquireReference>>;
export class NativeReference {
  private input: ReferenceInput | undefined;
  reserveRead(bytes: number) {
    this.input?.reserveRead(bytes);
  }
  private readonly inspections = new WeakMap<
    AuthorizationContext,
    { reader: ReferenceReader; stages: string | undefined }
  >();
  async authorizeInspection(
    context: OperationContext,
    stages?: readonly CaptureRecoveryStage[],
  ) {
    const proof = this.inspections.get(context.authorization);
    if (
      !proof ||
      context.projectId !== proof.reader.context.projectId ||
      context.jobId !== proof.reader.context.jobId ||
      context.requestId !== proof.reader.context.requestId ||
      context.signal !== proof.reader.context.signal ||
      context.clock !== proof.reader.context.clock ||
      context.deadline !== proof.reader.context.deadline ||
      (stages !== undefined && proof.stages !== canonicalDigest(stages))
    )
      throw new ApplicationError("FORBIDDEN");
    await proof.reader.check();
  }
  private service: JobService | undefined;
  private primaryFailure: ErrorCode | undefined;
  private immediateDiagnostic: ReferenceDiagnostic | undefined;
  private immediateCode: ErrorCode | undefined;
  get operationFailure() {
    return this.primaryFailure;
  }
  get retainsService() {
    return this.service !== undefined;
  }
  private prepared:
    | { value: Prepared; context: OperationContext; record: StoredJob }
    | undefined;
  constructor(
    private readonly work: CaptureWork,
    private readonly files: ProjectFileSystem,
    private readonly store: LocalStore,
    private readonly recovery: RecoveryDecisions,
  ) {}
  async close() {
    if (this.service) {
      unwrap(await this.service.stop());
      this.service = undefined;
    }
    this.prepared = undefined;
  }
  readonly verifyCompletion: JobStorageOptions["verifyCompletion"] = async (
    record,
    completion,
    artifacts,
    context,
  ) => {
    const saved = this.prepared;
    await this.work.current();
    if (
      !saved ||
      !this.work.policy.verify(context.authorization) ||
      saved.context.authorization !== context.authorization ||
      saved.context.signal !== context.signal ||
      saved.context.clock !== context.clock ||
      saved.context.deadline !== context.deadline ||
      saved.record.job.id !== record.job.id ||
      context.jobId !== record.job.id ||
      context.requestId !== record.requestId ||
      record.handlerId !== REFERENCE_HANDLER ||
      record.job.operation !== "reference-download" ||
      record.job.status !== "running" ||
      record.job.attempt !== 1 ||
      record.job.lease?.id !== saved.record.job.lease?.id ||
      !same(record.job.input, saved.record.job.input) ||
      !same(context.budget, saved.context.budget) ||
      record.effects.some(
        (e) => e.state !== "settled" && e.state !== "no-effect",
      ) ||
      !same(completion, {
        outputs: saved.value.outputs,
        outputState:
          saved.value.evidence.referenceStatus === "complete"
            ? "complete"
            : "partial-inspection",
        diagnosticIds: [],
      }) ||
      artifacts.length !== saved.value.outputs.length
    )
      throw new ApplicationError("FORBIDDEN");
    for (const [index, entry] of artifacts.entries()) {
      const expected = saved.value.outputs[index]?.artifact;
      if (
        !expected ||
        !same(entry.artifact, expected) ||
        hashBytes(entry.bytes) !== expected.sha256 ||
        entry.bytes.length !== expected.byteLength
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
    }
    await this.work.current();
  };
  private async existing(jobId: string, context: OperationContext) {
    const page = unwrap(
      await this.store.jobs.discoverOwned({ jobId, limit: 1 }, context),
    );
    if (page.nextCursor || page.descriptors.length > 1)
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    return page.descriptors.length
      ? unwrap(await this.store.jobs.get(jobId, context))
      : undefined;
  }
  private async settledPublications(
    reader: ReferenceReader,
    proposal: FigmaReferenceApproval["proposal"],
  ) {
    const proof = { reader, stages: undefined as string | undefined };
    this.inspections.set(reader.context.authorization, proof);
    try {
      const state = unwrap(
        await this.store.referencePublicationState(reader.context),
      );
      const descriptors = await retainedReferenceStages(
        reader,
        state,
        proposal,
      );
      proof.stages = canonicalDigest(descriptors);
      const inspected = unwrap(
        await this.files.inspectReferencePublications(
          descriptors,
          reader.context,
        ),
      );
      try {
        if (!same(inspected.artifacts, state.artifacts))
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        if (reader.bytes > REFERENCE_LIMITS.maxInputBytes)
          throw new ApplicationError("INPUT_LIMIT");
        const after = unwrap(
          await this.store.referencePublicationState(reader.context),
        );
        if (!same(after, state)) throw new ApplicationError("CONFLICT");
        await reader.check();
      } finally {
        for (const stage of inspected.stages) stage.bytes.fill(0);
      }
    } finally {
      this.inspections.delete(reader.context.authorization);
    }
  }
  private async cooldowns(
    context: OperationContext,
    reader: ReferenceReader,
    fileKey: string,
  ) {
    let cursor: { createdAt: string; id: string } | undefined;
    const ids = new Set<string>();
    do {
      const page = unwrap(
        await this.store.jobs.discoverOwned(
          {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          context,
        ),
      );
      for (const item of page.descriptors) {
        if (ids.size >= 1000 || ids.has(item.jobId))
          throw new ApplicationError("INPUT_LIMIT");
        ids.add(item.jobId);
        // Only published results attest an actual cooldown; unknown old effects are not recast as responses.
        if (item.status !== "completed" || !item.outputs.length) continue;
        const last = item.outputs.at(-1);
        if (!last) continue;
        if (item.handlerId === "figma-rest-selected-frame") {
          const request = await reader.contract(
            "FigmaCaptureRequest",
            item.input,
          );
          if (!same(request.credential, this.work.project.reference)) continue;
          const result = await reader.contract("FigmaCaptureResult", last);
          const manifest = await reader.contract(
            "FigmaCaptureManifest",
            result.manifest,
          );
          if (manifest.selection.fileKey !== fileKey) continue;
          if (manifest.retry === "retry-after-unknown")
            throw new ApplicationError("ACTION_REQUIRED");
          if (
            manifest.nextEligibleAt &&
            context.clock.now() < Date.parse(manifest.nextEligibleAt)
          )
            throw new ApplicationError("RATE_LIMITED");
        } else if (item.handlerId === REFERENCE_HANDLER) {
          const evidence = await reader.contract(
            "FigmaReferenceEvidence",
            last,
          );
          if (evidence.request.binding.fileKey !== fileKey) continue;
          if (evidence.retry === "retry-after-unknown")
            throw new ApplicationError("ACTION_REQUIRED");
          if (
            evidence.nextEligibleAt &&
            context.clock.now() < Date.parse(evidence.nextEligibleAt)
          )
            throw new ApplicationError("RATE_LIMITED");
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async execute(
    input: NativeReferenceInput,
    signal: AbortSignal,
  ): Promise<NativeReferenceEnvelope> {
    const ownsInput = !this.input;
    this.input ??= new ReferenceInput();
    const inputBudget = this.input;
    const base = {
      schemaVersion: "1.0" as const,
      operation: input.operation,
      projectId: this.work.project.projectId,
      requestId: validateContract("StableId", input.requestId).success
        ? input.requestId
        : "reference_invalid",
    };
    let reader: ReferenceReader | undefined;
    try {
      if (this.service || !this.work.referenceAuthority)
        throw new ApplicationError("FORBIDDEN");
      this.primaryFailure = undefined;
      this.immediateDiagnostic = undefined;
      this.immediateCode = undefined;
      const fields =
        input.operation === "reference-approve"
          ? ["origin", "expectedProof", "confirmation"]
          : input.operation === "reference-download"
            ? ["expectedApproval", "confirmation"]
            : [];
      if (
        ![
          "reference-plan",
          "reference-approve",
          "reference-download",
          "reference-inspect",
        ].includes(input.operation) ||
        !validateContract("StableId", input.requestId).success ||
        Object.keys(input).some(
          (k) => !["operation", "requestId", ...fields].includes(k),
        ) ||
        (input.operation === "reference-approve" &&
          (input.origin !== REFERENCE_ORIGIN ||
            !validateContract("Sha256", input.expectedProof).success ||
            input.confirmation !== REFERENCE_APPROVAL_CONFIRMATION)) ||
        (input.operation === "reference-download" &&
          (!validateContract("Sha256", input.expectedApproval).success ||
            input.confirmation !== REFERENCE_DOWNLOAD_CONFIRMATION))
      )
        throw new ApplicationError("INVALID_INPUT");
      await this.work.referenceAuthority();
      const ids = referenceIds(this.work, input.requestId);
      const policy = this.work.policy;
      const context = await policy.issue({
        jobId: ids.approval,
        requestId: ids.approval,
        jobReads: [
          ids.original,
          ids.job,
          ...Array.from({ length: 32 }, (_, i) => approvalKey(ids.job, i)),
        ],
        output: true,
        signal,
      });
      reader = new ReferenceReader(
        this.work,
        this.store,
        this.files,
        context,
        inputBudget,
      );
      const loaded = await reader.proposal(input.requestId);
      let proposal = loaded.proposal;
      const old = await this.existing(ids.job, context);
      let approvalReceipt: CommitReceipt | null = null;
      let approval: FigmaReferenceApproval | undefined;
      let request: FigmaReferenceRequest | undefined;
      let resources: ResourceSnapshot | undefined;
      const resourcesHash = canonicalDigest(
        nativeCaptureResources(this.work.project.projectId),
      );
      const resourceRef = {
        id: `sha256_${resourcesHash}`,
        sha256: resourcesHash,
      };
      const approvalValue = async () => {
        if (
          approvalReceipt?.outputs.length !== 2 ||
          approvalReceipt.jobId !==
            approvalKey(ids.job, proposal.approvalGeneration) ||
          approvalReceipt.integrity !== "verified" ||
          approvalReceipt.publication !== "atomic"
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const [a, r] = approvalReceipt.outputs;
        if (!a || !r) throw new ApplicationError("ARTIFACT_INTEGRITY");
        if (!reader) throw new ApplicationError("FORBIDDEN");
        approval = await reader.contract("FigmaReferenceApproval", a);
        request = await reader.contract("FigmaReferenceRequest", r);
        resources = await reader.contract("ResourceSnapshot", resourceRef);
        if (
          !same(approval.proposal, proposal) ||
          canonicalDigest(approval) !== a.sha256 ||
          !same(request, {
            schemaVersion: "1.0",
            binding: proposal.binding,
            approval: ref(a),
          }) ||
          canonicalDigest(request) !== r.sha256 ||
          !same(
            resources,
            nativeCaptureResources(this.work.project.projectId),
          ) ||
          canonicalDigest(resources) !== resourceRef.sha256 ||
          Date.parse(approval.expiresAt) <= Date.parse(approval.recordedAt) ||
          Date.parse(approval.expiresAt) >
            Date.parse(approval.recordedAt) + 300000 ||
          (proposal.urlExpiresAt &&
            Date.parse(approval.expiresAt) > Date.parse(proposal.urlExpiresAt))
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        return { approval: ref(a), expiresAt: approval.expiresAt };
      };
      let approved: Awaited<ReturnType<typeof approvalValue>> | undefined;
      let gap = false;
      for (let generation = 0; generation < 32; generation++) {
        const found = unwrap(
          await this.store.getReceipt(
            approvalKey(ids.job, generation),
            context,
          ),
        );
        if (!found) {
          gap = true;
          continue;
        }
        if (gap) throw new ApplicationError("ARTIFACT_INTEGRITY");
        const previous = approval;
        proposal = renewalProposal(
          loaded.proposal,
          generation,
          approved?.approval,
        );
        approvalReceipt = found;
        approved = await approvalValue();
        if (
          previous &&
          approval &&
          Date.parse(previous.expiresAt) > Date.parse(approval.recordedAt)
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
      }
      if (
        input.operation === "reference-download" &&
        (!approved || approved.approval.sha256 !== input.expectedApproval)
      )
        throw new ApplicationError("CONFLICT");
      if (old) {
        if (
          input.operation === "reference-approve" &&
          input.expectedProof !== proposal.proofSha256
        )
          throw new ApplicationError("CONFLICT");
        if (!request || !approvalReceipt)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const r = approvalReceipt.outputs[1];
        if (
          !r ||
          old.handlerId !== REFERENCE_HANDLER ||
          old.handlerVersion !== "1.0.0" ||
          old.authorityRef !== `reference_${proposal.referencePolicySha256}` ||
          old.job.operation !== "reference-download" ||
          old.job.id !== ids.job ||
          old.requestId !== ids.job ||
          !same(old.job.input, ref(r)) ||
          old.job.actorId !== this.work.actorId ||
          old.job.attempt > 1 ||
          !same(old.job.budget, REFERENCE_LIMITS)
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const receipt = unwrap(
          await this.store.jobs.getJobReceipt(ids.job, context),
        );
        if (old.job.status === "completed") {
          if (
            !receipt ||
            !same(old.job.receipt, receipt) ||
            old.job.attempt !== 1 ||
            receipt.integrity !== "verified" ||
            receipt.publication !== "atomic" ||
            old.effects.some(
              (e) => e.state !== "settled" && e.state !== "no-effect",
            )
          )
            throw new ApplicationError("ARTIFACT_INTEGRITY");
          const last = receipt.outputs.at(-1);
          if (!last) throw new ApplicationError("ARTIFACT_INTEGRITY");
          const evidence = await reader.contract(
            "FigmaReferenceEvidence",
            last,
          );
          if (
            !same(evidence.request, request) ||
            receipt.outputs.length !== (evidence.reference ? 2 : 1) ||
            (evidence.reference &&
              !same(
                ref(receipt.outputs[0] ?? last),
                evidence.reference.artifact,
              ))
          )
            throw new ApplicationError("ARTIFACT_INTEGRITY");
          return {
            ...base,
            referenceDiagnostic: evidence.referenceDiagnostic ?? {
              stage: "legacy",
              reason: "legacy-unknown",
              mimeClass: "not-observed",
            },
            status:
              evidence.referenceStatus === "complete"
                ? "complete"
                : evidence.referenceStatus === "partial"
                  ? "partial"
                  : "unavailable",
            value: {
              phase: "completed",
              consumed: true,
              proposal,
              ...approved,
              job: old.job,
              evidence,
              receipt,
            },
          };
        }
        return {
          ...base,
          status: "interrupted",
          value: {
            phase: "admitted",
            consumed: true,
            proposal,
            ...approved,
            job: old.job,
          },
          error: {
            code: "ACTION_REQUIRED",
            message:
              "The one reference acquisition was admitted and cannot be replayed. Effects and retained stages require review; no retry or new capture is authorized.",
            retryable: false,
            diagnosticIds: [],
          },
        };
      }
      if (
        approval &&
        approved &&
        context.clock.now() >= Date.parse(approval.expiresAt) &&
        (input.operation === "reference-plan" ||
          (input.operation === "reference-approve" &&
            input.expectedProof !== proposal.proofSha256))
      ) {
        if (proposal.approvalGeneration >= 31)
          throw new ApplicationError("ACTION_REQUIRED");
        proposal = renewalProposal(
          loaded.proposal,
          proposal.approvalGeneration + 1,
          approved.approval,
        );
        approvalReceipt = null;
        approval = undefined;
        request = undefined;
        resources = undefined;
        approved = undefined;
      }
      if (
        input.operation === "reference-approve" &&
        input.expectedProof !== proposal.proofSha256
      )
        throw new ApplicationError("CONFLICT");
      if (
        input.operation === "reference-plan" ||
        input.operation === "reference-inspect"
      )
        return {
          ...base,
          status: "complete",
          value: {
            phase: approved ? "approved" : "proposed",
            consumed: false,
            proposal,
            ...approved,
          },
        };
      if (input.operation === "reference-approve") {
        if (approved)
          return {
            ...base,
            status: "complete",
            value: {
              phase: "approved",
              consumed: false,
              proposal,
              ...approved,
            },
          };
        const now = context.clock.now();
        const end = Math.min(
          now + 300000,
          proposal.urlExpiresAt ? Date.parse(proposal.urlExpiresAt) : Infinity,
        );
        if (end <= now) throw new ApplicationError("ACTION_REQUIRED");
        await this.settledPublications(reader, proposal);
        const grant: FigmaReferenceApproval = {
          schemaVersion: "1.0",
          proposal,
          confirmation: REFERENCE_APPROVAL_CONFIRMATION,
          recordedAt: new Date(now).toISOString(),
          expiresAt: new Date(end).toISOString(),
        };
        const grantBytes = canonicalBytes(grant);
        if (grantBytes.length > 65536)
          throw new ApplicationError("INPUT_LIMIT");
        const key = approvalKey(ids.job, proposal.approvalGeneration);
        const issuance = await policy.issue({
          jobId: key,
          requestId: key,
          signal,
          deadline: context.deadline,
        });
        const stagedApproval = unwrap(
          await this.store.stage(grantBytes, issuance),
        );
        const stagedRequest = unwrap(
          await this.store.stage(
            canonicalBytes({
              schemaVersion: "1.0",
              binding: proposal.binding,
              approval: ref(stagedApproval.artifact),
            } satisfies FigmaReferenceRequest),
            issuance,
          ),
        );
        unwrap(await this.store.verify(resourceRef, context));
        await reader.check();
        approvalReceipt = unwrap(
          await this.store.commit([stagedApproval, stagedRequest], issuance),
        );
        approved = await approvalValue();
        return {
          ...base,
          status: "complete",
          value: { phase: "approved", consumed: false, proposal, ...approved },
        };
      }
      if (!approval || !request || !resources || !approvalReceipt || !approved)
        throw new ApplicationError("ACTION_REQUIRED");
      if (context.clock.now() >= Date.parse(approval.expiresAt))
        throw new ApplicationError("ACTION_REQUIRED");
      await this.cooldowns(context, reader, proposal.binding.fileKey);
      await this.settledPublications(reader, proposal);
      const deadline = new Date(
        Math.min(Date.parse(context.deadline), Date.parse(approval.expiresAt)),
      ).toISOString();
      const jobContext = await policy.issue({
        jobId: ids.job,
        requestId: ids.job,
        signal,
        deadline,
        jobReads: [ids.original, ids.approval],
        reference: { sourceId: ids.job },
      });
      const fixedRequest = structuredClone(request);
      const localInputBytes = reader.bytes;
      const jobInput = approvalReceipt.outputs[1];
      const snapshot = unwrap(await this.store.verify(resourceRef, context));
      if (!jobInput || !snapshot)
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      const handler: TrustedJobHandler = {
        id: REFERENCE_HANDLER,
        version: "1.0.0",
        operation: "reference-download",
        run: async (execution) => {
          const record = execution.record;
          if (
            record.job.id !== ids.job ||
            record.requestId !== ids.job ||
            record.job.attempt !== 1 ||
            record.effects.length ||
            record.usage.externalCalls ||
            !same(record.job.input, ref(jobInput)) ||
            execution.context.deadline !== deadline
          )
            throw new ApplicationError("FORBIDDEN");
          await this.work.referenceAuthority?.();
          const budget = new ReferenceBudget(
            execution.context,
            ids.job,
            this.work.project.artifactRootId,
            policy.verify,
            localInputBytes,
            inputBudget,
          );
          try {
            const value = await acquireReference(
              fixedRequest,
              loaded.url,
              execution,
              budget,
            );
            this.prepared = {
              value,
              context: execution.context,
              record: structuredClone(record),
            };
            return {
              kind: "complete",
              completion: {
                outputs: value.outputs,
                outputState:
                  value.evidence.referenceStatus === "complete"
                    ? "complete"
                    : "partial-inspection",
                diagnosticIds: [],
              },
            };
          } catch (error) {
            this.immediateDiagnostic =
              referenceDiagnosticFields(error).referenceDiagnostic;
            this.immediateCode = safeError(error).code;
            throw error;
          } finally {
            await budget.close();
          }
        },
      };
      this.service = createJobService({
        projectId: this.work.project.projectId,
        repository: this.store.jobs,
        clock: policy.clock,
        artifactRootId: this.work.project.artifactRootId,
        ownerId: `owner_${ids.job}`,
        handlers: [handler],
        executionAuthority: {
          verify: policy.verify,
          observe: (s) =>
            policy.issue({
              jobId: ids.job,
              requestId: ids.job,
              signal: s,
              parentSignal: signal,
              deadline,
            }),
          issue: async (record, s) => {
            if (record.job.id !== ids.job || record.job.deadline !== deadline)
              throw new ApplicationError("FORBIDDEN");
            return policy.issue({
              jobId: ids.job,
              requestId: ids.job,
              signal: s,
              parentSignal: signal,
              deadline,
              reference: { sourceId: ids.job },
            });
          },
        },
        recoveryAuthority: {
          issue: async (record, s) => {
            if (record.job.id !== ids.job)
              throw new ApplicationError("FORBIDDEN");
            const ctx = await policy.issue({
              jobId: ids.job,
              requestId: ids.job,
              signal: s,
            });
            this.recovery.register(record, ctx);
            return ctx;
          },
          decide: (record, facts, ctx) =>
            this.recovery.decide(record, facts, ctx),
        },
      });
      try {
        unwrap(
          await this.service.submit(
            {
              id: ids.job,
              operation: "reference-download",
              input: ref(jobInput),
              resources: {
                snapshotId: snapshot.id,
                sha256: snapshot.sha256,
                componentRegistryRevision: "none",
                tokenRegistryRevision: "none",
                selectedModes: {},
              },
              handlerId: REFERENCE_HANDLER,
              handlerVersion: "1.0.0",
              authorityRef: `reference_${proposal.referencePolicySha256}`,
              resourceKeys: [`reference_${ids.original}`],
              deadline,
              budget: { ...REFERENCE_LIMITS },
            },
            jobContext,
          ),
        );
        unwrap(await this.service.start());
        unwrap(await this.service.waitForAttempt(ids.job, jobContext));
      } catch (error) {
        this.primaryFailure = signal.aborted
          ? "CANCELLED"
          : safeError(error).code;
        throw error;
      } finally {
        await this.close();
      }
      await reader.close();
      reader = undefined;
      if (this.immediateCode)
        throw new ApplicationError(
          this.immediateCode,
          400,
          undefined,
          this.immediateDiagnostic,
        );
      return this.execute(
        { operation: "reference-inspect", requestId: input.requestId },
        signal,
      ).then((result) => ({ ...result, operation: input.operation }));
    } catch (error) {
      const safe = safeError(error);
      const code = safe.code;
      return {
        ...base,
        status:
          code === "CANCELLED"
            ? "cancelled"
            : code === "INTERRUPTED"
              ? "interrupted"
              : "failed",
        error: {
          code,
          message:
            "Reference operation was not confirmed. Inspect the original request; no URL refresh, capture, or automatic retry is authorized.",
          retryable: false,
          diagnosticIds: [],
          ...referenceDiagnosticFields(
            safe.referenceDiagnostic
              ? safe
              : {
                  referenceDiagnostic: this.immediateDiagnostic,
                },
          ),
        },
      };
    } finally {
      await reader?.close();
      if (ownsInput && !this.service) this.input = undefined;
    }
  }
}
