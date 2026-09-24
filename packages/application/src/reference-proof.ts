import type {
  ArtifactReference,
  CommitReceipt,
  ContractName,
  ContractTypes,
  FigmaCaptureManifest,
  FigmaReferenceProposal,
  JsonObject,
  JsonValue,
  OperationContext,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
  CAPTURE_LIMITS,
} from "@design-studio/figma-capture";
import { parseFigmaSelection } from "@design-studio/figma-import";
import { OperationGuard, type ProjectFileSystem } from "@design-studio/host";
import type { CaptureWork } from "@design-studio/project-host";
import type { LocalStore } from "@design-studio/storage";
import {
  decodeReference,
  parseCaptureJson,
} from "../../figma-capture/dist/decode.js";
import {
  REFERENCE_LIMITATIONS,
  REFERENCE_LIMITS,
  REFERENCE_ORIGIN,
  referenceUrl,
} from "../../figma-capture/dist/reference.js";
import type { ReferenceInput } from "./reference-input.js";
import { ApplicationError, unwrap } from "./response.js";

export const ref = (value: ArtifactReference): ArtifactReference => ({
  id: value.id,
  sha256: value.sha256,
});
export const same = (a: unknown, b: unknown) =>
  canonicalDigest(a) === canonicalDigest(b);
export const approvalKey = (job: string, generation: number) =>
  generation === 0 ? `approval_${job}` : `approval_${job}_${generation}`;
export function renewalProposal(
  proposal: FigmaReferenceProposal,
  generation: number,
  previousApproval?: ArtifactReference,
): FigmaReferenceProposal {
  const {
    proofSha256: _proof,
    previousApproval: _previous,
    ...base
  } = proposal;
  const facts = {
    ...base,
    approvalGeneration: generation,
    ...(previousApproval ? { previousApproval } : {}),
  };
  return { ...facts, proofSha256: canonicalDigest(facts) };
}
const object = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
export function referenceIds(work: CaptureWork, requestId: string) {
  const original = `capture_${canonicalDigest([work.project.projectId, work.actorId, requestId])}`;
  const job = `reference_${canonicalDigest([work.project.projectId, work.actorId, original, "selected-reference-v1"])}`;
  return { original, job, approval: `approval_${job}` };
}
export class ReferenceReader {
  private closed = false;
  private readonly verifiedCaptures = new WeakMap<
    object,
    {
      binding: FigmaReferenceProposal["binding"];
      receipt: CommitReceipt;
      artifacts: FigmaCaptureManifest["artifacts"];
    }
  >();
  get bytes() {
    return this.input.privateBytes;
  }
  private readonly guard: OperationGuard;
  private readonly watch: ReturnType<OperationGuard["watch"]>;
  constructor(
    readonly work: CaptureWork,
    readonly store: LocalStore,
    readonly files: ProjectFileSystem,
    readonly context: OperationContext,
    readonly input: ReferenceInput,
    readonly diagnostic = false,
    readonly retainedValidation = false,
  ) {
    this.guard = new OperationGuard(
      context,
      {
        projectId: work.project.projectId,
        resourceKind: "artifact",
        resourceId: work.project.artifactRootId,
        operation: "read",
      },
      work.policy.verify,
      undefined,
      CAPTURE_LIMITS,
    );
    this.watch = this.guard.watch();
  }
  async check() {
    this.guard.check();
    await this.work.current();
    this.guard.check();
    if (!this.work.referenceAuthority) throw new ApplicationError("FORBIDDEN");
    const digest = await this.work.referenceAuthority();
    if (this.diagnostic) {
      if (!this.work.diagnosticAuthority)
        throw new ApplicationError("FORBIDDEN");
      await this.work.diagnosticAuthority();
    }
    if (this.retainedValidation) {
      if (!this.work.referenceValidationAuthority)
        throw new ApplicationError("FORBIDDEN");
      await this.work.referenceValidationAuthority();
    }
    this.guard.check();
    return digest;
  }
  private async read(reference: ArtifactReference, maximum = 262144) {
    await this.check();
    const priorLimit = this.input.maximumFileBytes;
    this.input.maximumFileBytes = maximum;
    try {
      const { artifact, bytes } = unwrap(
        await this.store.readVerified(ref(reference), this.context),
      );
      try {
        await this.check();
        if (artifact.byteLength > maximum)
          throw new ApplicationError("INPUT_LIMIT");
        if (
          bytes.length !== artifact.byteLength ||
          hashBytes(bytes) !== reference.sha256
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        return bytes;
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    } finally {
      this.input.maximumFileBytes = priorLimit;
    }
  }
  async json(reference: ArtifactReference, maximum = 262144) {
    const bytes = await this.read(reference, maximum);
    try {
      const forbidden = () => {
        throw new ApplicationError("FORBIDDEN");
      };
      return await parseCaptureJson(bytes, {
        context: this.context,
        signal: this.watch.signal,
        policy: { imageOrigins: [] },
        body: 0,
        check: () => this.guard.check(),
        dnsQuery: forbidden,
        receive: forbidden,
        decoded: forbidden,
      });
    } finally {
      bytes.fill(0);
    }
  }
  async contract<K extends ContractName>(
    kind: K,
    reference: ArtifactReference,
    maximum = 262144,
  ): Promise<ContractTypes[K]> {
    if (maximum > 262144) {
      const parsed = validateContract(
        kind,
        await this.json(reference, maximum),
      );
      if (!parsed.success) throw new ApplicationError("ARTIFACT_INTEGRITY");
      return parsed.value;
    }
    const bytes = await this.read(reference);
    try {
      const value = parseContract(
        kind,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        "json",
        { maxInputBytes: 262144 },
      );
      await this.check();
      return value;
    } finally {
      bytes.fill(0);
    }
  }
  async close() {
    this.closed = true;
    await this.watch.close();
  }
  verifiedCaptureOutputs(token: object, proposal: FigmaReferenceProposal) {
    this.guard.check();
    const verified = this.verifiedCaptures.get(token);
    if (this.closed || !this.work.isCurrent() || !verified)
      throw new ApplicationError("FORBIDDEN");
    const originalAcquisition =
      proposal.diagnosticPredecessor?.jobId ?? proposal.binding.acquisitionId;
    if (
      proposal.diagnosticPredecessor &&
      proposal.binding.acquisitionId !==
        `diagnostic_${canonicalDigest([
          "original-reference-diagnostic-slot-v1",
          verified.binding.projectId,
          originalAcquisition,
          proposal.diagnosticPredecessor.receiptSha256,
        ])}`
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    if (
      !same(verified.binding, {
        ...proposal.binding,
        acquisitionId: originalAcquisition,
      })
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    return structuredClone(verified);
  }
  async png(bytes: Uint8Array) {
    await this.check();
    const forbidden = () => {
      throw new ApplicationError("FORBIDDEN");
    };
    const result = await decodeReference(bytes, {
      context: this.context,
      signal: this.watch.signal,
      policy: { imageOrigins: [] },
      body: 0,
      check: () => this.guard.check(),
      dnsQuery: forbidden,
      receive: forbidden,
      decoded: forbidden,
    });
    await this.check();
    return result;
  }
  async proposal(requestId: string): Promise<{
    proposal: FigmaReferenceProposal;
    url: string;
    verifiedCapture: object;
  }> {
    const supplement = await this.check();
    const { original, job } = referenceIds(this.work, requestId);
    const record = unwrap(await this.store.jobs.get(original, this.context));
    // get already verifies the receipt's exact protected outputs under this context.
    const receipt = record.job.receipt;
    if (
      record.job.id !== original ||
      record.requestId !== requestId ||
      record.job.projectId !== this.work.project.projectId ||
      record.job.actorId !== this.work.actorId ||
      record.handlerId !== CAPTURE_HANDLER_ID ||
      record.handlerVersion !== CAPTURE_HANDLER_VERSION ||
      record.authorityRef !== `native_${this.work.policySha256}` ||
      record.job.operation !== "capture" ||
      record.job.status !== "completed" ||
      record.job.attempt !== 1 ||
      !receipt ||
      receipt.integrity !== "verified" ||
      receipt.publication !== "atomic" ||
      record.effects.some(
        (e) => e.state !== "settled" && e.state !== "no-effect",
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const request = await this.contract(
      "FigmaCaptureRequest",
      record.job.input,
    );
    const selected = parseFigmaSelection(request.selectionUrl);
    const policy = {
      id: `native_${this.work.policySha256}`,
      projectId: this.work.project.projectId,
      sourceId: `figma_${canonicalDigest([this.work.project.projectId, selected])}`,
      artifactRootId: this.work.project.artifactRootId,
      ...selected,
      credential: this.work.project.reference,
      imageOrigins: [...this.work.imageOrigins],
    };
    if (
      canonicalDigest(request) !== record.job.input.sha256 ||
      request.captureId !== original ||
      request.projectId !== policy.projectId ||
      request.policyId !== policy.id ||
      request.policySha256 !== canonicalDigest(policy) ||
      !same(request.credential, this.work.project.reference)
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const resultRef = receipt.outputs.at(-1);
    if (!resultRef) throw new ApplicationError("EVIDENCE_MISSING");
    const member = (reference: ArtifactReference) => {
      const found = receipt.outputs.filter((a) => same(ref(a), ref(reference)));
      if (found.length !== 1 || !found[0])
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      return found[0];
    };
    const result = await this.contract("FigmaCaptureResult", resultRef);
    const manifest = await this.contract(
      "FigmaCaptureManifest",
      member(result.manifest),
    );
    if (
      result.captureId !== original ||
      result.projectId !== policy.projectId ||
      manifest.captureId !== original ||
      manifest.projectId !== policy.projectId ||
      manifest.policyId !== policy.id ||
      manifest.policySha256 !== canonicalDigest(policy) ||
      !same(manifest.request, record.job.input) ||
      !same(manifest.selection, selected) ||
      !same(result.source ?? null, manifest.source ?? null) ||
      result.completeness !== manifest.completeness ||
      result.referenceStatus !== manifest.referenceStatus ||
      record.job.outputState !==
        (result.completeness === "complete"
          ? "complete"
          : "partial-inspection") ||
      receipt.outputs.length !== manifest.artifacts.length + 2 ||
      new Set(manifest.artifacts.map((a) => a.role)).size !==
        manifest.artifacts.length ||
      !manifest.source ||
      !manifest.sourceVersion ||
      manifest.reference ||
      manifest.referenceStatus !== "unavailable" ||
      manifest.artifacts.some((a) => a.role === "reference")
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    for (const item of manifest.artifacts)
      if (!same(member(item.artifact), item.artifact))
        throw new ApplicationError("ARTIFACT_INTEGRITY");
    const role = (name: "nodes" | "render-map" | "source") => {
      const item = manifest.artifacts.find((a) => a.role === name);
      if (!item) throw new ApplicationError("EVIDENCE_MISSING");
      return member(item.artifact);
    };
    if (!same(ref(role("source")), manifest.source))
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const source = await this.contract(
      "SourceSnapshot",
      role("source"),
      REFERENCE_LIMITS.maxInputBytes,
    );
    if (
      source.projectId !== policy.projectId ||
      source.identity.transport !== "figma-rest" ||
      source.identity.fileKey !== selected.fileKey ||
      source.identity.nodeId !== selected.nodeId ||
      source.identity.sourceVersion !== manifest.sourceVersion ||
      source.consistency.guarantee !== "version-pinned" ||
      source.completeness !== manifest.completeness ||
      !source.artifacts.some((a) => same(a, role("nodes"))) ||
      !source.artifacts.some((a) => same(a, role("render-map")))
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    for (const operation of ["nodes", "reference-render"] as const) {
      const observation = manifest.observations.filter(
        (o) => o.operation === operation,
      );
      const sources = source.requests.filter((o) => o.operation === operation);
      if (
        observation.length !== 1 ||
        sources.length !== 1 ||
        observation[0]?.outcome !== "complete" ||
        sources[0]?.outcome !== "complete" ||
        observation[0]?.requestedVersion !== manifest.sourceVersion ||
        sources[0]?.requestedVersion !== manifest.sourceVersion ||
        sources[0]?.versionSupport !== "pinned" ||
        (observation[0]?.returnedVersion !== undefined &&
          observation[0].returnedVersion !== manifest.sourceVersion)
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
    }
    const nodes = await this.json(
      role("nodes"),
      REFERENCE_LIMITS.maxInputBytes,
    );
    const document = object(
      object(object(nodes.nodes)?.[selected.nodeId])?.document,
    );
    const box = object(document?.absoluteBoundingBox);
    if (
      nodes.version !== manifest.sourceVersion ||
      document?.id !== selected.nodeId ||
      document.type !== "FRAME" ||
      !box ||
      ![box.x, box.y, box.width, box.height].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      ) ||
      typeof box.width !== "number" ||
      typeof box.height !== "number" ||
      box.width <= 0 ||
      box.height <= 0
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const render = await this.json(role("render-map"));
    if (
      render.version !== undefined &&
      render.version !== manifest.sourceVersion
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    const image = object(render.images)?.[selected.nodeId];
    if (typeof image !== "string")
      throw new ApplicationError("EVIDENCE_MISSING");
    const target = referenceUrl(image);
    const facts: Omit<FigmaReferenceProposal, "proofSha256"> = {
      schemaVersion: "1.0" as const,
      format: "figma-reference-proposal-v1" as const,
      approvalGeneration: 0,
      binding: {
        projectId: policy.projectId,
        actorId: this.work.actorId,
        originalRequestId: requestId,
        originalJobId: original,
        originalRecordSha256: canonicalDigest(record),
        originalReceiptSha256: canonicalDigest(receipt),
        request: ref(record.job.input),
        source: ref(role("source")),
        manifest: ref(result.manifest),
        result: ref(resultRef),
        nodes: ref(role("nodes")),
        renderMap: ref(role("render-map")),
        ...selected,
        sourceVersion: manifest.sourceVersion,
        bounds: {
          x: Number(box.x),
          y: Number(box.y),
          width: box.width,
          height: box.height,
          unit: "design-unit" as const,
        },
        scale: 1 as const,
        origin: REFERENCE_ORIGIN,
        acquisitionId: job,
      },
      capturePolicySha256: this.work.policySha256,
      referencePolicySha256: supplement,
      limits: { ...REFERENCE_LIMITS },
      limitations: [...REFERENCE_LIMITATIONS],
      ...(target.expiresAt ? { urlExpiresAt: target.expiresAt } : {}),
    };
    await this.check();
    const verifiedCapture = Object.freeze({});
    this.verifiedCaptures.set(
      verifiedCapture,
      structuredClone({
        binding: facts.binding,
        receipt,
        artifacts: manifest.artifacts,
      }),
    );
    return {
      proposal: { ...facts, proofSha256: canonicalDigest(facts) },
      url: target.url,
      verifiedCapture,
    };
  }
}
