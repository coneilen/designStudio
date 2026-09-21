import type {
  Artifact,
  ArtifactReference,
  CaptureRecoveryBinding,
  CredentialStore,
  FigmaCaptureManifest,
  FigmaCaptureRequest,
  FigmaCaptureResult,
  Job,
  OperationContext,
  Outcome,
  ResourceLock,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { parseFigmaSelection } from "@design-studio/figma-import";
import {
  type Authority,
  authorizeOperation,
  HostBoundaryError,
  snapshotOperationContext,
} from "@design-studio/host";
import type { JobService, TrustedJobHandler } from "@design-studio/jobs";
import type {
  JobRepository,
  JobStorageOptions,
  JobSubmission,
  StoredJob,
} from "@design-studio/storage";
import {
  CAPTURE_LIMITS,
  type CapturePolicy,
  fail,
  ownPolicy,
  ownRequest,
} from "./boundary.js";
import { type CapturePreparation, captureSelectedFrame } from "./capture.js";

export const CAPTURE_HANDLER_ID = "figma-rest-selected-frame";
export const CAPTURE_HANDLER_VERSION = "0.1.0";
export interface CaptureServiceOptions {
  policy: CapturePolicy;
  authority: Authority;
  credentials: CredentialStore;
  repository: Pick<JobRepository, "discoverOwned" | "get" | "getJobReceipt"> &
    Partial<
      Pick<JobRepository, "getCaptureRecovery" | "getCaptureRecoveryForNext">
    >;
  /** Current authorized private artifact read; return exclusively owned bytes, never log them. */
  readArtifact(
    reference: ArtifactReference,
    context: OperationContext,
    maximumBytes: number,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
}
const states: Job["status"][] = [
  "queued",
  "running",
  "retry-wait",
  "waiting-for-user",
  "cancel-requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
function referenceOnly(input: ArtifactReference): ArtifactReference {
  if (
    !validateContract("ArtifactReference", input).success &&
    !validateContract("Artifact", input).success
  )
    fail("INVALID_INPUT", "Invalid capture artifact reference.");
  return { id: input.id, sha256: input.sha256 };
}
function complete<T>(outcome: Outcome<T>): T {
  if (outcome.status !== "complete")
    fail(
      outcome.error.code,
      "Capture history or storage requires current authorized recovery.",
    );
  return outcome.value;
}
export function createFigmaCaptureJobs(input: CaptureServiceOptions) {
  const policy = ownPolicy(input.policy);
  const authority = input.authority;
  const credentials = Object.freeze({
    use: input.credentials.use.bind(input.credentials),
  });
  const repository = input.repository;
  const readArtifact = input.readArtifact.bind(input);
  const preparations = new Map<
    string,
    {
      prepared: CapturePreparation;
      context: OperationContext;
      record: StoredJob;
    }
  >();
  const key = (record: StoredJob) => `${record.job.id}:${record.generation}`;
  const check = (context: OperationContext) => {
    for (const scope of [
      {
        resourceKind: "source" as const,
        resourceId: policy.sourceId,
        operation: "capture" as const,
      },
      {
        resourceKind: "provider" as const,
        resourceId: "figma_rest",
        operation: "read" as const,
      },
      {
        resourceKind: "credential" as const,
        resourceId: policy.credential.id,
        operation: "credential-use" as const,
      },
      {
        resourceKind: "artifact" as const,
        resourceId: policy.artifactRootId,
        operation: "write" as const,
      },
    ])
      authorizeOperation(
        context,
        { projectId: policy.projectId, ...scope },
        authority,
      );
  };
  const checked = async <T>(
    work: Promise<Outcome<T>>,
    context: OperationContext,
  ): Promise<T> => {
    try {
      const outcome = await work;
      check(context);
      return complete(outcome);
    } catch (error) {
      check(context);
      fail(
        error instanceof HostBoundaryError ? error.code : "INTERNAL_ERROR",
        "Capture storage lookup failed; sensitive details withheld.",
      );
    }
  };
  const load = async (
    reference: ArtifactReference,
    context: OperationContext,
    maximum: number,
  ) => {
    check(context);
    const captured = Object.freeze(referenceOnly(reference));
    let evidence: Awaited<ReturnType<typeof readArtifact>> | undefined;
    try {
      evidence = await readArtifact(captured, context, maximum);
      check(context);
      if (
        !(evidence.bytes instanceof Uint8Array) ||
        evidence.bytes.buffer instanceof SharedArrayBuffer ||
        !validateContract("Artifact", evidence.artifact).success ||
        evidence.bytes.length > maximum ||
        evidence.artifact.byteLength !== evidence.bytes.length ||
        evidence.artifact.sha256 !== captured.sha256 ||
        hashBytes(evidence.bytes) !== captured.sha256
      )
        fail("ARTIFACT_INTEGRITY", "Capture artifact integrity failed.");
      return new TextDecoder("utf-8", { fatal: true }).decode(evidence.bytes);
    } catch (error) {
      check(context);
      if (error instanceof HostBoundaryError)
        fail(
          error.code,
          "Capture artifact read failed; sensitive details withheld.",
        );
      fail("INVALID_INPUT", "Capture artifact could not be decoded.");
    } finally {
      if (
        evidence?.bytes instanceof Uint8Array &&
        !(evidence.bytes.buffer instanceof SharedArrayBuffer)
      )
        evidence.bytes.fill(0);
    }
  };
  const requestFor = async (
    reference: ArtifactReference,
    context: OperationContext,
    enforcePolicy: boolean,
  ) => {
    const text = await load(reference, context, 65536);
    check(context);
    let request: FigmaCaptureRequest;
    try {
      request = parseContract("FigmaCaptureRequest", text, "json", {
        maxInputBytes: 65536,
      });
    } catch {
      fail("INVALID_INPUT", "Capture request artifact is invalid.");
    }
    if (canonicalDigest(request) !== reference.sha256)
      fail("ARTIFACT_INTEGRITY", "Capture request is not canonical.");
    return enforcePolicy ? ownRequest(request, policy) : request;
  };
  const resultFor = async (
    record: StoredJob,
    context: OperationContext,
  ): Promise<FigmaCaptureResult | undefined> => {
    check(context);
    const receipt = await checked(
      repository.getJobReceipt(record.job.id, context),
      context,
    );
    check(context);
    if (!receipt?.outputs.length) return undefined;
    const last = receipt.outputs.at(-1);
    if (!last) return undefined;
    const text = await load(last, context, 65536);
    check(context);
    try {
      const result = parseContract("FigmaCaptureResult", text, "json", {
        maxInputBytes: 65536,
      });
      if (
        result.projectId !== policy.projectId ||
        result.captureId !== record.job.id
      )
        throw new Error("scope");
      return result;
    } catch {
      fail("ARTIFACT_INTEGRITY", "Capture result artifact is invalid.");
    }
  };
  const history = async (
    current: FigmaCaptureRequest,
    context: OperationContext,
  ) => {
    const reserved = repository.getCaptureRecoveryForNext
      ? await checked(repository.getCaptureRecoveryForNext(context), context)
      : null;
    if (
      reserved &&
      canonicalDigest(reserved.authorization.nextRequest) !==
        canonicalDigest(current)
    )
      fail(
        "CONFLICT",
        "This next request is reserved for different capture bytes.",
      );
    let recovery: CaptureRecoveryBinding | undefined;
    let cursor: { createdAt: string; id: string } | undefined;
    let seen = 0;
    const cursors = new Set<string>();
    for (;;) {
      check(context);
      const page = await checked(
        repository.discoverOwned(
          {
            states: [...states],
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          context,
        ),
        context,
      );
      check(context);
      for (const item of page.descriptors) {
        if (++seen > 1000)
          fail(
            "ACTION_REQUIRED",
            "Capture history exceeds bounded inspection; explicit maintenance is required.",
          );
        if (
          item.jobId === current.captureId ||
          item.operation !== "capture" ||
          item.handlerId !== CAPTURE_HANDLER_ID
        )
          continue;
        const request = await requestFor(item.input, context, false);
        check(context);
        let selection: { fileKey: string; nodeId: string };
        try {
          selection = parseFigmaSelection(request.selectionUrl);
        } catch {
          fail("ARTIFACT_INTEGRITY", "Prior capture selection is invalid.");
        }
        if (
          selection.fileKey !== policy.fileKey ||
          request.credential.id !== policy.credential.id ||
          request.credential.providerId !== policy.credential.providerId ||
          request.credential.store !== policy.credential.store ||
          request.projectId !== policy.projectId
        )
          continue;
        const record = await checked(
          repository.get(item.jobId, context),
          context,
        );
        check(context);
        if (record.usage.externalCalls === 0) continue;
        const result = await resultFor(record, context);
        check(context);
        if (!result) {
          const evidence = repository.getCaptureRecovery
            ? await checked(
                repository.getCaptureRecovery(item.jobId, context),
                context,
              )
            : null;
          if (
            !evidence ||
            recovery ||
            canonicalDigest(evidence.authorization.nextRequest) !==
              canonicalDigest(current) ||
            evidence.authorization.proposal.nextRequestId !==
              context.requestId ||
            evidence.authorization.originalRecordSha256 !==
              canonicalDigest(record)
          )
            fail(
              "ACTION_REQUIRED",
              "Prior capture network effects lack an exact one-next recovery authorization.",
            );
          recovery = {
            originalJobId: record.job.id,
            authorization: referenceOnly(evidence.artifact),
          };
          continue;
        }
        const text = await load(
          result.manifest,
          context,
          Math.min(26214400, context.budget.maxInputBytes),
        );
        let manifest: FigmaCaptureManifest;
        try {
          manifest = parseContract("FigmaCaptureManifest", text, "json");
        } catch {
          fail("ARTIFACT_INTEGRITY", "Prior capture manifest is invalid.");
        }
        check(context);
        if (
          manifest.captureId !== item.jobId ||
          manifest.projectId !== policy.projectId ||
          manifest.request.sha256 !== item.input.sha256 ||
          manifest.selection.fileKey !== policy.fileKey
        )
          fail(
            "ARTIFACT_INTEGRITY",
            "Prior capture manifest scope is inconsistent.",
          );
        if (manifest.retry === "retry-after-unknown")
          fail(
            "ACTION_REQUIRED",
            "Prior rate limit has no trusted retry time; explicit quota review is required.",
          );
        if (
          manifest.nextEligibleAt &&
          context.clock.now() < Date.parse(manifest.nextEligibleAt)
        )
          fail(
            "RATE_LIMITED",
            "A prior capture's persisted Retry-After has not elapsed; no automatic retry.",
          );
      }
      if (!page.nextCursor) {
        if (
          reserved &&
          (!recovery ||
            canonicalDigest(recovery.authorization) !==
              canonicalDigest(reserved.artifact))
        )
          fail(
            "CONFLICT",
            "Capture recovery reservation lacks its original history binding.",
          );
        return recovery;
      }
      const marker = canonicalDigest(page.nextCursor);
      if (cursors.has(marker))
        fail("ARTIFACT_INTEGRITY", "Capture history pagination repeated.");
      cursors.add(marker);
      cursor = page.nextCursor;
    }
  };
  const handler: TrustedJobHandler = {
    id: CAPTURE_HANDLER_ID,
    version: CAPTURE_HANDLER_VERSION,
    operation: "capture",
    async run(execution) {
      const record = execution.record;
      const context = snapshotOperationContext(execution.context);
      preparations.delete(key(record));
      try {
        check(context);
        if (preparations.size >= 64)
          fail(
            "ACTION_REQUIRED",
            "Release settled capture preparations before admitting more work.",
          );
        const request = await requestFor(record.job.input, context, true);
        await execution.checkpoint();
        check(context);
        const recovery = await history(request, context);
        if (
          canonicalDigest(recovery ?? null) !==
          canonicalDigest(record.submission.captureRecovery ?? null)
        )
          fail(
            "FORBIDDEN",
            "Capture recovery differs from its immutable submission binding.",
          );
        check(context);
        const prepared = await captureSelectedFrame(request, execution, {
          policy,
          authority,
          credentials,
        });
        check(context);
        preparations.set(key(record), {
          prepared: structuredClone(prepared),
          context,
          record: structuredClone(record),
        });
        return {
          kind: "complete",
          completion: {
            outputs: prepared.staged,
            outputState:
              prepared.result.completeness === "complete"
                ? "complete"
                : "partial-inspection",
            diagnosticIds: [],
          },
        };
      } catch (error) {
        const code =
          error instanceof HostBoundaryError ? error.code : "INTERNAL_ERROR";
        return {
          kind:
            code === "RATE_LIMITED" || code === "ACTION_REQUIRED"
              ? "wait"
              : execution.record.usage.externalCalls === 0
                ? "fail"
                : "interrupt",
          error: {
            code,
            message:
              "Selected-frame capture did not complete; no automatic retry.",
            retryable: false,
            diagnosticIds: [],
          },
        };
      }
    },
  };
  const verifyCompletion: JobStorageOptions["verifyCompletion"] = async (
    record,
    completion,
    evidence,
    supplied,
  ) => {
    const context = snapshotOperationContext(supplied);
    check(context);
    const known = preparations.get(key(record));
    if (
      !known ||
      context.authorization !== known.context.authorization ||
      context.signal !== known.context.signal ||
      context.clock !== known.context.clock ||
      context.deadline !== known.context.deadline ||
      context.requestId !== known.context.requestId ||
      context.jobId !== record.job.id ||
      context.requestId !== record.requestId ||
      record.job.lease?.id !== known.record.job.lease?.id ||
      canonicalDigest(context.budget) !==
        canonicalDigest(known.context.budget) ||
      record.job.actorId !== context.authorization.actorId ||
      record.job.status !== "running" ||
      record.handlerId !== CAPTURE_HANDLER_ID ||
      record.handlerVersion !== CAPTURE_HANDLER_VERSION ||
      canonicalDigest(record.job.input) !==
        canonicalDigest(known.record.job.input) ||
      record.job.attempt !== 1 ||
      record.effects.some(
        (effect) => effect.state === "reserved" || effect.state === "unknown",
      )
    )
      fail(
        "FORBIDDEN",
        "Capture completion lacks current byte-bound execution evidence.",
      );
    const expected = {
      outputs: known.prepared.staged,
      outputState:
        known.prepared.result.completeness === "complete"
          ? "complete"
          : "partial-inspection",
      diagnosticIds: [],
    };
    if (
      canonicalDigest(completion) !== canonicalDigest(expected) ||
      evidence.length !== expected.outputs.length
    )
      fail(
        "ARTIFACT_INTEGRITY",
        "Capture completion was changed after preparation.",
      );
    for (const [index, item] of evidence.entries()) {
      check(context);
      const saved = expected.outputs[index]?.artifact;
      if (
        !saved ||
        canonicalDigest(item.artifact) !== canonicalDigest(saved) ||
        hashBytes(item.bytes) !== saved.sha256 ||
        item.bytes.length !== saved.byteLength
      )
        fail(
          "ARTIFACT_INTEGRITY",
          "Capture committed bytes differ from staged evidence.",
        );
    }
    check(context);
  };
  return {
    handlers: [handler],
    verifyCompletion,
    normalize(request: unknown) {
      const normalized = ownRequest(request, policy);
      return { request: normalized, bytes: canonicalBytes(normalized) };
    },
    async prepare(request: unknown, supplied: OperationContext) {
      const context = snapshotOperationContext(supplied);
      check(context);
      return history(ownRequest(request, policy), context);
    },
    async submit(
      service: Pick<JobService, "submit">,
      input: unknown,
      requestArtifact: ArtifactReference,
      resources: ResourceLock,
      authorityRef: string,
      supplied: OperationContext,
    ) {
      const context = snapshotOperationContext(supplied);
      const request = ownRequest(input, policy);
      const artifact = referenceOnly(requestArtifact);
      const lock = structuredClone(resources);
      check(context);
      if (
        !validateContract("ArtifactReference", artifact).success ||
        artifact.sha256 !== canonicalDigest(request) ||
        !validateContract("ResourceLock", lock).success ||
        !validateContract("StableId", authorityRef).success ||
        context.jobId !== request.captureId
      )
        fail("INVALID_INPUT", "Capture submission is not byte/resource bound.");
      const discovery = await checked(
        repository.discoverOwned(
          { jobId: request.captureId, limit: 1 },
          context,
        ),
        context,
      );
      check(context);
      if (discovery.descriptors.length) {
        if (
          discovery.descriptors.length !== 1 ||
          discovery.descriptors[0]?.jobId !== request.captureId
        )
          fail(
            "ARTIFACT_INTEGRITY",
            "Capture idempotency discovery was inconsistent.",
          );
        const prior = await checked(
          repository.get(request.captureId, context),
          context,
        );
        check(context);
        if (
          prior.handlerId !== CAPTURE_HANDLER_ID ||
          canonicalDigest(prior.job.input) !== canonicalDigest(artifact) ||
          canonicalDigest(prior.job.resources) !== canonicalDigest(lock)
        )
          fail("CONFLICT", "Capture ID is already bound to another request.");
        return {
          schemaVersion: "1.0" as const,
          projectId: context.projectId,
          requestId: context.requestId,
          status: "complete" as const,
          value: prior.job,
          diagnosticIds: [],
        };
      }
      const recovery = await history(request, context);
      check(context);
      const budget = {
        ...context.budget,
        maxExternalCalls: Math.min(4, context.budget.maxExternalCalls),
        maxAttempts: 1,
      };
      for (const name of Object.keys(
        CAPTURE_LIMITS,
      ) as (keyof typeof CAPTURE_LIMITS)[])
        if (budget[name] > CAPTURE_LIMITS[name])
          fail("POLICY_FAILED", "Capture submission exceeds trusted limits.");
      const submission: JobSubmission = {
        id: request.captureId,
        operation: "capture",
        input: artifact,
        resources: lock,
        handlerId: CAPTURE_HANDLER_ID,
        handlerVersion: CAPTURE_HANDLER_VERSION,
        authorityRef,
        resourceKeys: [
          `capture_source_${canonicalDigest([policy.projectId, policy.fileKey, policy.credential])}`,
        ],
        deadline: new Date(
          Math.min(
            Date.parse(context.deadline),
            Date.parse(context.authorization.expiresAt),
            context.clock.now() + budget.maxDurationMs,
          ),
        ).toISOString(),
        budget,
        ...(recovery ? { captureRecovery: recovery } : {}),
      };
      const submitted = await service.submit(submission, context);
      check(context);
      return submitted;
    },
    async readResult(jobId: string, supplied: OperationContext) {
      const context = snapshotOperationContext(supplied);
      check(context);
      const record = await checked(repository.get(jobId, context), context);
      check(context);
      if (
        record.handlerId !== CAPTURE_HANDLER_ID ||
        record.job.projectId !== policy.projectId
      )
        fail("FORBIDDEN", "Capture job scope denied.");
      await requestFor(record.job.input, context, true);
      check(context);
      return resultFor(record, context);
    },
    release(record: StoredJob) {
      preparations.delete(key(record));
    },
    releaseJob(jobId: string) {
      for (const name of preparations.keys())
        if (name.startsWith(`${jobId}:`)) preparations.delete(name);
    },
  };
}
