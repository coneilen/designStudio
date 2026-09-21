import type {
  ArtifactReference,
  CaptureRecoveryAuthorization,
  FigmaCaptureManifest,
  FigmaCaptureRequest,
  NativeCaptureRecoveryEnvelope,
  OperationContext,
  ResourceSnapshot,
  StagedArtifact,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
  type CapturePolicy,
  normalizeFigmaCaptureRequest,
} from "@design-studio/figma-capture";
import { parseFigmaSelection } from "@design-studio/figma-import";
import {
  type CaptureRecoveryStage,
  type ProjectFileSystem,
  snapshotOperationContext,
} from "@design-studio/host";
import type { CaptureWork } from "@design-studio/project-host";
import {
  type CaptureRecoveryState,
  type LocalStore,
  originalRecoveryState,
  recoveryKey,
  type StorageOptions,
} from "@design-studio/storage";
import { ApplicationError, safeError, unwrap } from "./response.js";

export const CAPTURE_RECOVERY_CONFIRMATION =
  "AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA";
const confirmationText =
  "I acknowledge that the original capture failed and remains failed. Settled effects do not prove successful responses or available quota. Response details, quota, and credential validity may be unknown. I authorize only the displayed next request for the same project, selection, credential reference, and capture policy, subject to unchanged cooldown and safety checks. This records authorization only; it does not capture, retry, reset history, or claim no network effect.";
export interface NativeCaptureRecoveryInput {
  operation: "recover";
  requestId: string;
  failedJobId: string;
  nextRequestId: string;
  expectedProof?: string;
  confirmation?: string;
}
const same = (a: unknown, b: unknown) =>
  canonicalDigest(a) === canonicalDigest(b);
const ref = (artifact: ArtifactReference) => ({
  id: artifact.id,
  sha256: artifact.sha256,
});
export function nativeCaptureResources(projectId: string): ResourceSnapshot {
  return {
    schemaVersion: "1.0",
    id: `resources_${canonicalDigest(projectId)}`,
    projectId,
    components: {
      schemaVersion: "1.0",
      projectId,
      revision: "none",
      definitions: [],
      mappings: [],
    },
    tokens: {
      schemaVersion: "1.0",
      projectId,
      revision: "none",
      collections: [],
      selectedModes: {},
      definitions: [],
      resolved: [],
      adapters: [],
    },
    assets: [],
    fonts: [],
  };
}
type GrantFacts = Omit<
  CaptureRecoveryAuthorization,
  "recordedAt" | "confirmation"
>;

/** Native-only composition: the public factory accepts no override for this controller. */
export class CaptureRecovery {
  private active: NativeCaptureRecoveryInput | FigmaCaptureRequest | undefined;
  private readonly inspections = new WeakMap<
    OperationContext["authorization"],
    string
  >();
  private readonly reads = new WeakMap<
    OperationContext["authorization"],
    { bytes: number }
  >();
  private readonly issuances = new WeakMap<
    OperationContext["authorization"],
    {
      grant: CaptureRecoveryAuthorization;
      stage: StagedArtifact;
    }
  >();
  constructor(
    private readonly work: CaptureWork,
    private readonly files: ProjectFileSystem,
    private readonly store: LocalStore,
    private readonly selectionPolicy: (url: string) => CapturePolicy,
  ) {}
  private identity(requestId: string) {
    return `capture_${canonicalDigest([this.work.project.projectId, this.work.actorId, requestId])}`;
  }
  activate(request: FigmaCaptureRequest) {
    this.active = structuredClone(request);
  }
  clear() {
    this.active = undefined;
  }
  async authorize(context: OperationContext) {
    await this.work.current();
    if (
      !this.active ||
      !this.work.policy.verify(context.authorization) ||
      context.projectId !== this.work.project.projectId ||
      context.authorization.actorId !== this.work.actorId ||
      context.clock !== this.work.policy.clock ||
      ("operation" in this.active && context.authorization.egress !== "deny") ||
      context.signal.aborted ||
      context.clock.now() >= Date.parse(context.deadline)
    )
      throw new ApplicationError("FORBIDDEN");
    await this.work.recoveryAuthority();
  }
  async authorizeInspection(
    stages: readonly CaptureRecoveryStage[],
    context: OperationContext,
  ) {
    await this.authorize(context);
    if (this.inspections.get(context.authorization) !== canonicalDigest(stages))
      throw new ApplicationError("FORBIDDEN");
  }
  readonly storage: NonNullable<StorageOptions["captureRecovery"]> = {
    authorize: (context) => this.authorize(context),
    verify: async (evidence, state, context) => {
      await this.authorize(context);
      const grant = evidence.authorization;
      const active = this.active;
      if (!active) throw new ApplicationError("FORBIDDEN");
      if ("operation" in active) {
        if (
          grant.proposal.originalJobId !== active.failedJobId ||
          grant.proposal.originalRequestId !== active.requestId ||
          grant.proposal.nextRequestId !== active.nextRequestId ||
          (active.expectedProof !== undefined &&
            active.expectedProof !== grant.proposal.proofSha256)
        )
          throw new ApplicationError("CONFLICT");
      } else if (
        !same(active, grant.nextRequest) ||
        context.jobId !== active.captureId ||
        context.requestId !== grant.proposal.nextRequestId
      ) {
        throw new ApplicationError("CONFLICT");
      }
      const original = originalRecoveryState(state, evidence, canonicalDigest);
      const facts = await this.facts(
        grant.proposal.originalRequestId,
        grant.proposal.originalJobId,
        grant.proposal.nextRequestId,
        original,
        context,
        state,
      );
      if (!same(facts, this.factsOnly(grant)))
        throw new ApplicationError("CONFLICT");
      await this.authorize(context);
    },
    verifyIssuance: async (grant, state, context) => {
      const proof = this.issuances.get(context.authorization);
      if (!proof || !same(proof.grant, grant))
        throw new ApplicationError("FORBIDDEN");
      const facts = await this.facts(
        grant.proposal.originalRequestId,
        grant.proposal.originalJobId,
        grant.proposal.nextRequestId,
        state,
        context,
        state,
        proof.stage,
      );
      if (!same(facts, this.factsOnly(grant)))
        throw new ApplicationError("CONFLICT");
      await this.authorize(context);
    },
  };
  private factsOnly(grant: CaptureRecoveryAuthorization): GrantFacts {
    const {
      recordedAt: _recordedAt,
      confirmation: _confirmation,
      ...facts
    } = grant;
    return facts;
  }
  private async readJson(
    reference: ArtifactReference,
    state: CaptureRecoveryState,
    context: OperationContext,
  ): Promise<unknown> {
    const artifact = state.artifacts.find((item) =>
      same(ref(item), ref(reference)),
    );
    if (
      !artifact ||
      artifact.byteLength > 262144 ||
      !state.references.some(
        (item) =>
          item.kind === "job" &&
          item.artifactId === artifact.id &&
          state.receipts.some(
            (entry) =>
              entry.receipt.id === item.owner &&
              entry.receipt.outputs.some((output) => same(output, artifact)),
          ),
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const budget = this.reads.get(context.authorization);
    if (!budget) throw new ApplicationError("FORBIDDEN");
    budget.bytes += artifact.byteLength;
    if (
      budget.bytes >
      Math.min(context.budget.maxInputBytes, context.budget.maxOutputBytes)
    )
      throw new ApplicationError("INPUT_LIMIT");
    const bytes = unwrap(
      await this.files.read(
        {
          artifactRootId: this.work.project.artifactRootId,
          path: artifact.path,
        },
        context,
      ),
    );
    try {
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      }
      if (canonicalDigest(value) !== reference.sha256)
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      return value;
    } finally {
      bytes.fill(0);
    }
  }
  private cooldown(manifest: FigmaCaptureManifest, context: OperationContext) {
    if (
      manifest.retry === "retry-after-unknown" ||
      (!manifest.nextEligibleAt &&
        manifest.observations.some(
          (item) => item.statusCode === 429 || item.outcome === "rate-limited",
        ))
    )
      throw new ApplicationError("ACTION_REQUIRED");
    if (
      manifest.nextEligibleAt &&
      Date.parse(manifest.nextEligibleAt) > context.clock.now()
    )
      throw new ApplicationError("RATE_LIMITED");
  }
  private async facts(
    originalRequestId: string,
    originalJobId: string,
    nextRequestId: string,
    state: CaptureRecoveryState,
    supplied: OperationContext,
    physicalState = state,
    issuanceStage?: StagedArtifact,
  ): Promise<GrantFacts> {
    await this.authorize(supplied);
    const { project, actorId, policy } = this.work;
    const authority = await this.work.recoveryAuthority();
    const original = state.jobs.find(
      (record) => record.job.id === originalJobId,
    );
    if (
      !original ||
      originalJobId !== this.identity(originalRequestId) ||
      original.requestId !== originalRequestId ||
      original.job.actorId !== actorId ||
      original.job.projectId !== project.projectId ||
      original.job.status !== "failed" ||
      original.job.operation !== "capture" ||
      original.job.attempt !== 1 ||
      original.handlerId !== CAPTURE_HANDLER_ID ||
      original.handlerVersion !== CAPTURE_HANDLER_VERSION ||
      original.authorityRef !== `native_${this.work.policySha256}` ||
      original.restoredLease ||
      original.job.lease ||
      original.resources.length ||
      original.finalOutputSha256 ||
      original.job.receipt ||
      original.usage.externalCalls < 1 ||
      original.usage.externalCalls > 4 ||
      original.effects.length !== original.usage.externalCalls ||
      original.effects.some(
        (effect, index) =>
          effect.id !== `figma_http_${index + 1}` ||
          !["settled", "no-effect"].includes(effect.state) ||
          effect.reserved.externalCalls !== 1 ||
          (effect.state === "settled" && effect.actual?.externalCalls !== 1),
      ) ||
      originalRequestId === nextRequestId ||
      state.jobs.some(
        (record) => record.job.id === this.identity(nextRequestId),
      ) ||
      state.receipts.some((entry) => entry.receipt.jobId === originalJobId) ||
      state.jobs.some(
        (record) =>
          record.job.actorId !== actorId ||
          record.job.projectId !== project.projectId ||
          [
            "queued",
            "running",
            "retry-wait",
            "cancel-requested",
            "interrupted",
          ].includes(record.job.status),
      ) ||
      state.resources.some((resource) => resource.state !== "released")
    )
      throw new ApplicationError("ACTION_REQUIRED");
    if (
      original.job.nextEligibleAttempt &&
      Date.parse(original.job.nextEligibleAttempt) > policy.clock.now()
    )
      throw new ApplicationError("RATE_LIMITED");
    if (
      original.job.error?.code === "RATE_LIMITED" &&
      !original.job.nextEligibleAttempt
    )
      throw new ApplicationError("ACTION_REQUIRED");
    const context = await policy.issue({
      jobId: supplied.jobId ?? originalJobId,
      requestId: supplied.requestId,
      signal: supplied.signal,
      deadline: supplied.deadline,
      jobReads: state.jobs.map((record) => record.job.id),
      output: true,
    });
    const readBudget = { bytes: 0 };
    this.reads.set(context.authorization, readBudget);
    const parsed = validateContract(
      "FigmaCaptureRequest",
      await this.readJson(original.job.input, state, context),
    );
    if (!parsed.success) throw new ApplicationError("ARTIFACT_INTEGRITY");
    const request = parsed.value;
    const selected = this.selectionPolicy(request.selectionUrl);
    const sourceKey = `capture_source_${canonicalDigest([
      project.projectId,
      selected.fileKey,
      project.reference,
    ])}`;
    if (
      request.captureId !== originalJobId ||
      request.projectId !== project.projectId ||
      request.policyId !== selected.id ||
      request.policySha256 !== canonicalDigest(selected) ||
      !same(original.resourceKeys, [sourceKey]) ||
      !state.resources.some(
        (resource) =>
          resource.key === sourceKey &&
          resource.generation === original.generation &&
          resource.state === "released",
      ) ||
      !same(request.credential, project.reference) ||
      !same(request, normalizeFigmaCaptureRequest(request, selected))
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    if (
      original.job.resources.sha256 !==
        canonicalDigest(nativeCaptureResources(project.projectId)) ||
      !same(
        await this.readJson(
          {
            id: original.job.resources.snapshotId,
            sha256: original.job.resources.sha256,
          },
          state,
          context,
        ),
        nativeCaptureResources(project.projectId),
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    for (const record of state.jobs) {
      if (
        record.job.id === originalJobId ||
        record.handlerId !== CAPTURE_HANDLER_ID ||
        record.usage.externalCalls === 0
      )
        continue;
      const prior = validateContract(
        "FigmaCaptureRequest",
        await this.readJson(record.job.input, state, context),
      );
      if (!prior.success) throw new ApplicationError("ARTIFACT_INTEGRITY");
      if (
        parseFigmaSelection(prior.value.selectionUrl).fileKey !==
          selected.fileKey ||
        !same(prior.value.credential, project.reference)
      )
        continue;
      const receipt = state.receipts.find(
        (entry) => entry.receipt.jobId === record.job.id,
      )?.receipt;
      if (
        record.job.status !== "completed" ||
        !receipt ||
        !same(record.job.receipt, receipt)
      )
        throw new ApplicationError("ACTION_REQUIRED");
      const last = receipt.outputs.at(-1);
      if (!last) throw new ApplicationError("ARTIFACT_INTEGRITY");
      const result = validateContract(
        "FigmaCaptureResult",
        await this.readJson(last, state, context),
      );
      if (
        !result.success ||
        result.value.captureId !== record.job.id ||
        result.value.projectId !== project.projectId
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      const manifest = validateContract(
        "FigmaCaptureManifest",
        await this.readJson(result.value.manifest, state, context),
      );
      if (
        !manifest.success ||
        manifest.value.captureId !== record.job.id ||
        manifest.value.projectId !== project.projectId ||
        !same(manifest.value.request, record.job.input)
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      this.cooldown(manifest.value, context);
    }
    const descriptors: CaptureRecoveryStage[] = state.stages.flatMap(
      (stage) => {
        if (stage.jobId !== originalJobId) {
          const owner = state.jobs.find(
            (record) => record.job.id === stage.jobId,
          );
          const receipt = state.receipts.find(
            (entry) => entry.receipt.jobId === stage.jobId,
          )?.receipt;
          if (
            owner?.job.status !== "completed" ||
            !receipt ||
            !same(owner.job.receipt, receipt) ||
            stage.requestId !== owner.requestId ||
            stage.attempt !== owner.job.attempt ||
            stage.fencingToken !== owner.generation ||
            !receipt.outputs.some((artifact) =>
              same(artifact, stage.staged.artifact),
            )
          )
            throw new ApplicationError("ACTION_REQUIRED");
          return [];
        }
        if (
          stage.jobId !== originalJobId ||
          stage.requestId !== originalRequestId ||
          stage.artifactRootId !== project.artifactRootId ||
          stage.attempt !== 1 ||
          stage.fencingToken !== original.generation ||
          !["retained", "recovery-needed"].includes(stage.disposition)
        )
          throw new ApplicationError("ACTION_REQUIRED");
        return [
          {
            stagingId: stage.stagingId,
            artifact: stage.staged.artifact,
            jobId: stage.jobId,
            requestId: stage.requestId,
          },
        ];
      },
    );
    if (issuanceStage)
      descriptors.push({
        stagingId: issuanceStage.stagingId,
        artifact: issuanceStage.artifact,
        jobId: recoveryKey(originalJobId),
        requestId: recoveryKey(originalJobId),
      });
    const remaining =
      Math.min(context.budget.maxInputBytes, context.budget.maxOutputBytes) -
      readBudget.bytes;
    if (remaining < 1) throw new ApplicationError("INPUT_LIMIT");
    const inspectionContext = snapshotOperationContext({
      ...context,
      budget: {
        ...context.budget,
        maxInputBytes: remaining,
        maxOutputBytes: remaining,
      },
    });
    this.inspections.set(context.authorization, canonicalDigest(descriptors));
    let inspection: Awaited<
      ReturnType<ProjectFileSystem["inspectCaptureRecovery"]>
    >;
    try {
      inspection = await this.files.inspectCaptureRecovery(
        descriptors,
        inspectionContext,
      );
    } finally {
      this.inspections.delete(context.authorization);
    }
    const inspected = unwrap(inspection);
    try {
      if (!same(inspected.artifacts, physicalState.artifacts))
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      for (const stage of inspected.stages) {
        if (stage.descriptor.stagingId === issuanceStage?.stagingId) continue;
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(stage.bytes),
          );
        } catch {
          // Raw retained provider bodies need not be JSON; they prove no quota fact.
          continue;
        }
        if (
          value &&
          typeof value === "object" &&
          "format" in value &&
          value.format === "figma-rest-capture-v1"
        ) {
          const manifest = validateContract("FigmaCaptureManifest", value);
          if (
            !manifest.success ||
            canonicalDigest(value) !== stage.descriptor.artifact.sha256 ||
            manifest.value.captureId !== originalJobId ||
            manifest.value.projectId !== project.projectId ||
            !same(manifest.value.request, original.job.input) ||
            manifest.value.policySha256 !== request.policySha256
          )
            throw new ApplicationError("ARTIFACT_INTEGRITY");
          this.cooldown(manifest.value, context);
        }
      }
      const nextRequest = {
        ...request,
        captureId: this.identity(nextRequestId),
      };
      const facts = {
        schemaVersion: "1.0" as const,
        artifactRootId: project.artifactRootId,
        permissionScope: this.work.permissionScope,
        basePolicySha256: this.work.policySha256,
        recoveryPolicySha256: authority.policySha256,
        credentialSha256: authority.credentialSha256,
        originalRecordSha256: canonicalDigest(original),
        storageSha256: canonicalDigest(state),
        filesystemSha256: canonicalDigest({
          artifacts: state.artifacts,
          stages: descriptors.filter(
            (stage) => stage.stagingId !== issuanceStage?.stagingId,
          ),
        }),
        nextRequest,
        nextResources: nativeCaptureResources(project.projectId),
        resourceStates: state.resources
          .filter((item) => original.resourceKeys.includes(item.key))
          .map((item) => ({
            key: item.key,
            generation: item.generation,
            state: "released" as const,
            jobId: null,
            leaseId: null,
            fencingToken: null,
          })),
      };
      const proposal = {
        schemaVersion: "1.0" as const,
        projectId: project.projectId,
        actorId,
        originalRequestId,
        originalJobId,
        nextRequestId,
        nextJobId: nextRequest.captureId,
        originalVersion: original.rowVersion,
        originalGeneration: original.generation,
        externalCalls: original.usage.externalCalls,
        responseEvidence: "unknown" as const,
        quotaEvidence: "unknown" as const,
        credentialValidity: "unknown" as const,
      };
      await this.authorize(supplied);
      if (!same(authority, await this.work.recoveryAuthority()))
        throw new ApplicationError("CONFLICT");
      return {
        ...facts,
        proposal: {
          ...proposal,
          proofSha256: canonicalDigest({ ...facts, proposal }),
        },
      };
    } finally {
      for (const stage of inspected.stages) stage.bytes.fill(0);
    }
  }
  async execute(
    input: NativeCaptureRecoveryInput,
    signal: AbortSignal,
  ): Promise<NativeCaptureRecoveryEnvelope> {
    const base = {
      schemaVersion: "1.0" as const,
      operation: "recover" as const,
      projectId: this.work.project.projectId,
      requestId: validateContract("StableId", input.requestId).success
        ? input.requestId
        : "capture_recovery",
    };
    this.active = structuredClone(input);
    try {
      if (
        input.operation !== "recover" ||
        Object.keys(input).some(
          (key) =>
            ![
              "operation",
              "requestId",
              "failedJobId",
              "nextRequestId",
              "expectedProof",
              "confirmation",
            ].includes(key),
        ) ||
        ![input.requestId, input.failedJobId, input.nextRequestId].every(
          (id) => validateContract("StableId", id).success,
        ) ||
        input.failedJobId !== this.identity(input.requestId) ||
        input.nextRequestId === input.requestId ||
        (input.confirmation === undefined) !==
          (input.expectedProof === undefined) ||
        (input.confirmation !== undefined &&
          (input.confirmation !== CAPTURE_RECOVERY_CONFIRMATION ||
            !validateContract("Sha256", input.expectedProof).success))
      )
        throw new ApplicationError("INVALID_INPUT");
      await this.work.recoveryAuthority();
      const key = recoveryKey(input.failedJobId);
      const context = await this.work.policy.issue({
        jobId: key,
        requestId: key,
        jobReads: [input.failedJobId],
        signal,
        output: true,
      });
      const existing = unwrap(
        await this.store.jobs.getCaptureRecovery(input.failedJobId, context),
      );
      if (existing) {
        const state = unwrap(await this.store.captureRecoveryState(context));
        return {
          ...base,
          status: "complete",
          value: {
            phase: "authorized",
            proposal: existing.authorization.proposal,
            consumed: state.jobs.some(
              (record) =>
                record.job.id === existing.authorization.proposal.nextJobId,
            ),
            confirmationText,
            authorization: existing.artifact,
            receiptId: existing.receipt.id,
          },
        };
      }
      const state = unwrap(await this.store.captureRecoveryState(context));
      const facts = await this.facts(
        input.requestId,
        input.failedJobId,
        input.nextRequestId,
        state,
        context,
      );
      if (input.confirmation === undefined)
        return {
          ...base,
          status: "complete",
          value: {
            phase: "proposed",
            proposal: facts.proposal,
            consumed: false,
            confirmationText,
          },
        };
      if (input.expectedProof !== facts.proposal.proofSha256)
        throw new ApplicationError("CONFLICT");
      const grant: CaptureRecoveryAuthorization = {
        ...facts,
        recordedAt: new Date(context.clock.now()).toISOString(),
        confirmation: CAPTURE_RECOVERY_CONFIRMATION,
      };
      const bytes = canonicalBytes(grant);
      if (bytes.length > 65536) throw new ApplicationError("INPUT_LIMIT");
      const stage = unwrap(await this.store.stage(bytes, context));
      this.issuances.set(context.authorization, { grant, stage });
      try {
        const receipt = unwrap(
          await this.store.commitCaptureRecovery(grant, stage, context),
        );
        const artifact = receipt.outputs[0];
        if (!artifact) throw new ApplicationError("ARTIFACT_INTEGRITY");
        return {
          ...base,
          status: "complete",
          value: {
            phase: "authorized",
            proposal: facts.proposal,
            consumed: false,
            confirmationText,
            authorization: ref(artifact),
            receiptId: receipt.id,
          },
        };
      } finally {
        this.issuances.delete(context.authorization);
      }
    } catch (error) {
      const code = safeError(error).code;
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
            "Capture recovery was not confirmed; no automatic capture or retry.",
          retryable: false,
          diagnosticIds: [],
        },
      };
    } finally {
      this.clear();
    }
  }
}
