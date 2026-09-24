import type {
  ArtifactReference,
  AuthorizationContext,
  ErrorCode,
  FigmaCaptureManifest,
  FigmaCaptureRequest,
  NativeCaptureEnvelope,
  NativeCaptureRecoveryEnvelope,
  NativeReferenceEnvelope,
  OperationContext,
  StagedArtifact,
} from "@design-studio/contracts";
import {
  parseContract,
  type ReferenceDiagnostic,
  referenceDiagnosticFields,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import {
  CAPTURE_HANDLER_ID,
  CAPTURE_HANDLER_VERSION,
  CAPTURE_LIMITS,
  type CapturePolicy,
  createFigmaCaptureJobs,
} from "@design-studio/figma-capture";
import {
  convertFigmaStructure,
  parseFigmaSelection,
} from "@design-studio/figma-import";
import {
  authorizeOperation,
  type OwnedPendingPublication,
  ProjectFileSystem,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { createJobService, type JobService } from "@design-studio/jobs";
import {
  acquireCaptureWork,
  type CaptureProject,
} from "@design-studio/project-host";
import { LocalStore, type StoredJob } from "@design-studio/storage";
import {
  captureConversionEntries,
  captureConversionIdentity,
  persistCaptureConversion,
} from "./capture-conversion.js";
import {
  CaptureRecovery,
  type NativeCaptureRecoveryInput,
  nativeCaptureResources,
} from "./capture-recovery.js";
import { RecoveryDecisions } from "./recovery.js";
import {
  NativeReference,
  type NativeReferenceInput,
} from "./reference-runtime.js";
import { ApplicationError, safeError, unwrap } from "./response.js";

type Operation = "capture" | "inspect" | "convert" | "artifact";
type Value = NonNullable<NativeCaptureEnvelope["value"]>;
export interface NativeCaptureInput {
  operation: Operation;
  requestId: string;
  url?: string;
  role?: Value["artifacts"][number]["role"];
  outputRelative?: string;
}
export interface NativeCaptureRuntime {
  reference?(
    input: NativeReferenceInput,
    signal: AbortSignal,
  ): Promise<NativeReferenceEnvelope>;
  recover(
    input: NativeCaptureRecoveryInput,
    signal: AbortSignal,
  ): Promise<NativeCaptureRecoveryEnvelope>;
  execute(
    input: NativeCaptureInput,
    signal: AbortSignal,
  ): Promise<NativeCaptureEnvelope>;
  close(): Promise<void>;
}
export class NativeCaptureStartupCleanupRequired extends ApplicationError {
  constructor(readonly close: () => Promise<void>) {
    super("INTERRUPTED");
  }
}
export class NativeCaptureCleanupRequired extends ApplicationError {
  constructor(
    readonly operationCode: ErrorCode,
    readonly cleanupCode: ErrorCode,
    readonly close: () => Promise<void>,
    readonly pending: readonly {
      kind: "job" | "intake" | "conversion" | "export";
      stagingId: string;
      jobId: string;
      requestId: string;
    }[],
  ) {
    super("INTERRUPTED");
  }
}
const ref = (artifact: ArtifactReference): ArtifactReference => ({
  id: artifact.id,
  sha256: artifact.sha256,
});
const same = (a: unknown, b: unknown) =>
  canonicalDigest(a) === canonicalDigest(b);

/** Internal composition; public native entry supplies no test or authority overrides. */
export async function assembleNativeCapture(
  project: CaptureProject,
): Promise<NativeCaptureRuntime> {
  const work = acquireCaptureWork(project);
  const policy = work.policy;
  let files: ProjectFileSystem | undefined;
  let store: LocalStore | undefined;
  let service: JobService | undefined;
  let capture: ReturnType<typeof createFigmaCaptureJobs> | undefined;
  let captureRecovery: CaptureRecovery | undefined;
  let reference: NativeReference | undefined;
  let active = false;
  let closing = false;
  let closed = false;
  let primaryFailure: ErrorCode | undefined;
  const publications = new Map<
    OwnedPendingPublication,
    {
      kind: "job" | "intake" | "conversion" | "export";
      context: OperationContext;
    }
  >();
  const cleanupProofs = new WeakMap<
    AuthorizationContext,
    OwnedPendingPublication
  >();
  let closeFlight: Promise<void> | undefined;
  const outside = async (): Promise<never> => {
    throw new ApplicationError("ACTION_REQUIRED");
  };
  const recovery = new RecoveryDecisions(policy, project.projectId);
  const closeOwned = async () => {
    if (closed) return;
    closing = true;
    if (active) throw new ApplicationError("INTERRUPTED");
    if (service) {
      unwrap(await service.stop());
      service = undefined;
    }
    await reference?.close();
    for (const [pending, original] of publications) {
      await policy.check();
      const context = await policy.issue({
        jobId: pending.jobId ?? original.context.jobId ?? "capture_cleanup",
        requestId: pending.requestId,
        signal: new AbortController().signal,
        output: pending.artifactRootId === policy.outputRoot,
      });
      cleanupProofs.set(context.authorization, pending);
      try {
        if (!files) throw new ApplicationError("INTERRUPTED");
        unwrap(await files.reconcileOwnedPublication(pending, context));
        publications.delete(pending);
        await policy.check();
      } finally {
        cleanupProofs.delete(context.authorization);
      }
    }
    if (store) {
      store.close();
      store = undefined;
    }
    if (files) {
      await files.closePreservingStages();
      files = undefined;
    }
    policy.close();
    work.close();
    closed = true;
  };
  const retained = (code: ErrorCode) =>
    new NativeCaptureCleanupRequired(
      primaryFailure ?? "INTERRUPTED",
      code,
      close,
      Object.freeze(
        [...publications].map(([pending, owned]) =>
          Object.freeze({
            kind: owned.kind,
            stagingId: pending.stagingId,
            jobId: pending.jobId ?? "capture_cleanup",
            requestId: pending.requestId,
          }),
        ),
      ),
    );
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (!closeFlight) {
      const attempt = closeOwned().catch((error: unknown) => {
        throw retained(safeError(error).code);
      });
      closeFlight = attempt.finally(() => {
        closeFlight = undefined;
      });
    }
    const original = closeFlight;
    return new Promise<void>((resolve, reject) => {
      // This only bounds acknowledgement. The original pass stays owned in
      // closeFlight, and no retry starts a second pass before it actually settles.
      const timer = setTimeout(() => reject(retained("INTERRUPTED")), 5000);
      original.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };
  try {
    await work.current();
    files = await ProjectFileSystem.create({
      reserveRead: (bytes) => reference?.reserveRead(bytes),
      referenceInspection: {
        artifactRootId: project.artifactRootId,
        outputRootId: policy.outputRoot,
        authorize: async (stages, context) => {
          if (!reference) throw new ApplicationError("FORBIDDEN");
          await reference.authorizeInspection(context, stages);
        },
      },
      captureRecoveryInspection: {
        artifactRootId: project.artifactRootId,
        outputRootId: policy.outputRoot,
        authorize: async (stages, context) => {
          if (!captureRecovery) throw new ApplicationError("FORBIDDEN");
          await captureRecovery.authorizeInspection(stages, context);
        },
      },
      projectId: project.projectId,
      authority: policy.verify,
      budgetLimits: CAPTURE_LIMITS,
      publicationProfile: WINDOWS_PUBLICATION_PROFILE,
      roots: [
        {
          id: project.artifactRootId,
          path: project.paths.artifacts,
          access: "read-write",
          managedBlobs: true,
          trustedExclusiveAccess: true,
        },
        {
          id: policy.outputRoot,
          path: project.paths.outputs,
          access: "read-write",
          trustedExclusiveAccess: true,
        },
      ],
      authorizeRemoval: async (artifact, context) =>
        store?.hasRemovalReservation(artifact, context) ?? false,
      authorizeOwnedPublicationRecovery: async (pending, context) => {
        const owned = publications.get(pending);
        if (
          !owned ||
          cleanupProofs.get(context.authorization) !== pending ||
          pending.projectId !== project.projectId ||
          pending.actorId !== work.actorId ||
          context.jobId !== pending.jobId ||
          context.requestId !== pending.requestId ||
          owned.context.projectId !== pending.projectId ||
          owned.context.authorization.actorId !== pending.actorId ||
          owned.context.jobId !== pending.jobId ||
          owned.context.requestId !== pending.requestId ||
          ![project.artifactRootId, policy.outputRoot].includes(
            pending.artifactRootId,
          )
        )
          throw new ApplicationError("FORBIDDEN");
        await policy.check();
        authorizeOperation(
          context,
          {
            projectId: project.projectId,
            actorId: work.actorId,
            resourceKind: "artifact",
            resourceId: pending.artifactRootId,
            operation: "write",
          },
          policy.verify,
        );
        if (
          cleanupProofs.get(context.authorization) !== pending ||
          publications.get(pending) !== owned
        )
          throw new ApplicationError("FORBIDDEN");
      },
    });
    const fs = files;
    const publish = async (
      staged: StagedArtifact,
      context: OperationContext,
    ) => {
      const descriptor = structuredClone(staged);
      const original = snapshotOperationContext(context);
      const outcome = await fs.publish(descriptor, original);
      if (
        outcome.status !== "complete" &&
        outcome.error.code === "OUTPUT_UNCERTAIN"
      ) {
        const pending = fs.retainPendingPublication(descriptor, original);
        const kind =
          pending.artifactRootId === policy.outputRoot
            ? "export"
            : original.jobId?.startsWith("seed_")
              ? "intake"
              : original.jobId?.startsWith("convert_")
                ? "conversion"
                : "job";
        publications.set(pending, { kind, context: original });
      }
      return outcome;
    };
    await work.current();
    store = await LocalStore.open({
      referenceInspection: {
        authorize: async (context) => {
          if (!reference) throw new ApplicationError("FORBIDDEN");
          await reference.authorizeInspection(context);
        },
      },
      captureRecovery: {
        authorize: async (context) => {
          if (!captureRecovery) throw new ApplicationError("FORBIDDEN");
          await captureRecovery.authorize(context);
        },
        verify: async (...args) => {
          if (!captureRecovery) throw new ApplicationError("FORBIDDEN");
          await captureRecovery.storage.verify(...args);
        },
        verifyIssuance: async (...args) => {
          if (!captureRecovery) throw new ApplicationError("FORBIDDEN");
          await captureRecovery.storage.verifyIssuance(...args);
        },
      },
      projectId: project.projectId,
      artifactRootId: project.artifactRootId,
      permissionScope: work.permissionScope,
      databasePath: project.paths.database,
      nativeBinding: work.sqliteBinding,
      fileSystem: {
        read: fs.read.bind(fs),
        stage: fs.stage.bind(fs),
        discard: fs.discard.bind(fs),
        publish,
      },
      snapshotOperationContext,
      canonicalBytes,
      attestLocalDatabase: work.attestDatabase.bind(work),
      authorize: async (context, scope) => {
        await policy.check();
        authorizeOperation(
          context,
          scope.resourceKind === "artifact"
            ? { ...scope, resourceId: project.artifactRootId }
            : scope,
          policy.verify,
        );
      },
      ensurePublicationDurable: async (artifacts, context) => {
        await policy.check();
        unwrap(
          await fs.ensurePublicationDurable(
            project.artifactRootId,
            artifacts,
            context,
          ),
        );
        await policy.check();
      },
      ensureDatabaseBackupDurable: outside,
      verifyRevision: outside,
      assessApproval: outside,
      authorizeRestore: outside,
      authorizeRetention: outside,
      canDiscardStage: async () => false,
      maintenance: {
        inventory: async (context, limit) =>
          unwrap(await fs.inventory(project.artifactRootId, context, limit)),
        removeBlob: outside,
      },
      jobs: {
        clock: policy.clock,
        limits: CAPTURE_LIMITS,
        discovery: {
          authorizeOwner: async (context) => {
            await policy.check();
            authorizeOperation(
              context,
              {
                projectId: project.projectId,
                actorId: work.actorId,
                resourceKind: "artifact",
                resourceId: project.artifactRootId,
                operation: "read",
              },
              policy.verify,
            );
          },
        },
        verifyCompletion: async (...args) => {
          if (args[0].job.operation === "reference-download") {
            if (!reference) throw new ApplicationError("FORBIDDEN");
            await reference.verifyCompletion(...args);
            return;
          }
          if (!capture) throw new ApplicationError("FORBIDDEN");
          await policy.check();
          await capture.verifyCompletion(...args);
          await policy.check();
        },
        authorizeRecovery: (record, evidence, context) =>
          recovery.authorize(record, evidence, context),
      },
    });
    await work.current();
    const db = store;
    reference = new NativeReference(work, fs, db, recovery);
    const read = async (
      reference: ArtifactReference,
      ctx: OperationContext,
      maximum = CAPTURE_LIMITS.maxInputBytes,
    ) => {
      await policy.check();
      const artifact = unwrap(await db.verify(ref(reference), ctx));
      await policy.check();
      if (artifact.byteLength > maximum)
        throw new ApplicationError("INPUT_LIMIT");
      const bytes = unwrap(
        await fs.read(
          { artifactRootId: project.artifactRootId, path: artifact.path },
          ctx,
        ),
      );
      try {
        await policy.check();
        if (
          bytes.length !== artifact.byteLength ||
          hashBytes(bytes) !== reference.sha256
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        return { artifact, bytes };
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    };
    const json = async <
      K extends
        | "FigmaCaptureRequest"
        | "FigmaCaptureManifest"
        | "FigmaCaptureResult"
        | "SourceSnapshot",
    >(
      kind: K,
      reference: ArtifactReference,
      ctx: OperationContext,
    ) => {
      const loaded = await read(reference, ctx, 262144);
      try {
        return parseContract(
          kind,
          new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes),
          "json",
          { maxInputBytes: 262144 },
        );
      } finally {
        loaded.bytes.fill(0);
      }
    };
    const identity = (requestId: string) =>
      `capture_${canonicalDigest([project.projectId, work.actorId, requestId])}`;
    const selectionPolicy = (url: string): CapturePolicy => {
      const selection = parseFigmaSelection(url);
      return {
        id: `native_${work.policySha256}`,
        projectId: project.projectId,
        sourceId: `figma_${canonicalDigest([project.projectId, selection])}`,
        artifactRootId: project.artifactRootId,
        ...selection,
        credential: { ...project.reference },
        imageOrigins: [...work.imageOrigins],
      };
    };
    const checkRecord = (record: StoredJob, requestId: string) => {
      if (
        record.job.id !== identity(requestId) ||
        record.requestId !== requestId ||
        record.job.projectId !== project.projectId ||
        record.job.actorId !== work.actorId ||
        record.handlerId !== CAPTURE_HANDLER_ID ||
        record.handlerVersion !== CAPTURE_HANDLER_VERSION ||
        record.authorityRef !== `native_${work.policySha256}` ||
        record.job.operation !== "capture"
      )
        throw new ApplicationError("FORBIDDEN");
    };
    captureRecovery = new CaptureRecovery(work, fs, db, selectionPolicy);
    const discover = async (ctx: OperationContext, jobId?: string) => {
      const ids: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      do {
        const page = unwrap(
          await db.jobs.discoverOwned(
            {
              limit: 100,
              ...(jobId ? { jobId } : {}),
              ...(cursor ? { cursor } : {}),
            },
            ctx,
          ),
        );
        await policy.check();
        for (const item of page.descriptors) {
          if (ids.length >= 1000 || ids.includes(item.jobId))
            throw new ApplicationError("ACTION_REQUIRED");
          ids.push(item.jobId);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return ids;
    };
    const committed = async (
      requestId: string,
      ctx: OperationContext,
      expectedRequest?: FigmaCaptureRequest,
    ) => {
      let record = unwrap(await db.jobs.get(identity(requestId), ctx));
      checkRecord(record, requestId);
      const request = await json("FigmaCaptureRequest", record.job.input, ctx);
      const selected = selectionPolicy(request.selectionUrl);
      if (
        request.captureId !== record.job.id ||
        request.projectId !== project.projectId ||
        request.policyId !== selected.id ||
        request.policySha256 !== canonicalDigest(selected) ||
        !same(request.credential, project.reference) ||
        canonicalDigest(request) !== record.job.input.sha256
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      if (expectedRequest && !same(request, expectedRequest))
        throw new ApplicationError("CONFLICT");
      if (
        ["queued", "running", "retry-wait", "cancel-requested"].includes(
          record.job.status,
        )
      ) {
        // This facade holds the native project writer lock. A stored lease is not
        // a live executor; concurrent execute is denied and original work is joined.
        if (service) throw new ApplicationError("INTERRUPTED");
        const cleanup = await policy.issue({
          jobId: record.job.id,
          requestId: record.requestId,
          signal: ctx.signal,
        });
        recovery.register(record, cleanup);
        record = unwrap(
          await db.jobs.reconcile(
            record.job.id,
            record.rowVersion,
            {
              kind: "interrupt",
              error: {
                code: "INTERRUPTED",
                message:
                  "No live native executor owns this capture. Original deadline, effects and stages are retained; explicit recovery is required.",
                retryable: false,
                diagnosticIds: [],
              },
            },
            cleanup,
          ),
        );
        await policy.check();
      }
      const receipt = unwrap(await db.jobs.getJobReceipt(record.job.id, ctx));
      await policy.check();
      if (record.job.status !== "completed" || !receipt)
        return { record, request, selected };
      if (
        record.job.attempt !== 1 ||
        record.effects.some(
          (effect) =>
            effect.state !== "settled" && effect.state !== "no-effect",
        ) ||
        !same(record.job.receipt, receipt)
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      const last = receipt.outputs.at(-1);
      if (!last) throw new ApplicationError("EVIDENCE_MISSING");
      const result = await json("FigmaCaptureResult", last, ctx);
      const member = (reference: ArtifactReference) => {
        const found = receipt.outputs.find((item) =>
          same(ref(item), ref(reference)),
        );
        if (!found) throw new ApplicationError("ARTIFACT_INTEGRITY");
        return found;
      };
      const manifestArtifact = member(result.manifest);
      const manifest = await json(
        "FigmaCaptureManifest",
        manifestArtifact,
        ctx,
      );
      if (
        result.projectId !== project.projectId ||
        result.captureId !== record.job.id ||
        manifest.projectId !== project.projectId ||
        manifest.captureId !== record.job.id ||
        manifest.policyId !== selected.id ||
        manifest.policySha256 !== canonicalDigest(selected) ||
        !same(manifest.request, record.job.input) ||
        !same(manifest.selection, parseFigmaSelection(request.selectionUrl)) ||
        result.completeness !== manifest.completeness ||
        result.referenceStatus !== manifest.referenceStatus ||
        !same(result.source ?? null, manifest.source ?? null) ||
        receipt.outputs.length !== manifest.artifacts.length + 2 ||
        new Set(manifest.artifacts.map((entry) => entry.role)).size !==
          manifest.artifacts.length ||
        record.job.outputState !==
          (result.completeness === "complete"
            ? "complete"
            : "partial-inspection")
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      const artifacts: Value["artifacts"] = [];
      for (const entry of manifest.artifacts) {
        const artifact = member(entry.artifact);
        if (!same(artifact, entry.artifact))
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const loaded = await read(artifact, ctx);
        loaded.bytes.fill(0);
        artifacts.push({ role: entry.role, artifact });
      }
      artifacts.push(
        { role: "manifest", artifact: manifestArtifact },
        { role: "result", artifact: last },
      );
      return { record, request, selected, result, manifest, artifacts };
    };
    const envelope = (
      operation: Operation,
      requestId: string,
      status: NativeCaptureEnvelope["status"],
      value?: Value,
      code?: ErrorCode,
      referenceDiagnostic?: ReferenceDiagnostic,
    ) => {
      const candidate = {
        schemaVersion: "1.0",
        operation,
        projectId: project.projectId,
        requestId,
        status,
        ...(value ? { value } : {}),
        ...(code
          ? {
              error: {
                code,
                message:
                  "Native capture requires the reported recovery or review; no automatic retry.",
                retryable: false,
                diagnosticIds: [],
                ...(referenceDiagnostic ? { referenceDiagnostic } : {}),
              },
            }
          : {}),
      };
      const checked = validateContract("NativeCaptureEnvelope", candidate);
      if (!checked.success) throw new ApplicationError("INTERNAL_ERROR");
      return checked.value;
    };
    const runtime: NativeCaptureRuntime = Object.freeze({
      async reference(input: NativeReferenceInput, signal: AbortSignal) {
        if (publications.size) throw new ApplicationError("INTERRUPTED");
        if (
          this !== runtime ||
          active ||
          closed ||
          closing ||
          service ||
          reference?.retainsService ||
          !reference
        )
          throw new ApplicationError("FORBIDDEN");
        active = true;
        try {
          const result = await reference.execute(
            structuredClone(input),
            signal,
          );
          if (!validateContract("NativeReferenceEnvelope", result).success)
            throw new ApplicationError("INTERNAL_ERROR");
          primaryFailure = reference.operationFailure ?? result.error?.code;
          return result;
        } finally {
          active = false;
        }
      },
      async recover(input: NativeCaptureRecoveryInput, signal: AbortSignal) {
        if (publications.size) throw new ApplicationError("INTERRUPTED");
        if (
          this !== runtime ||
          active ||
          closed ||
          closing ||
          service ||
          reference?.retainsService ||
          !captureRecovery
        )
          throw new ApplicationError("FORBIDDEN");
        active = true;
        try {
          const result = await captureRecovery.execute(
            structuredClone(input),
            signal,
          );
          if (
            !validateContract("NativeCaptureRecoveryEnvelope", result).success
          )
            throw new ApplicationError("INTERNAL_ERROR");
          primaryFailure = result.error?.code;
          return result;
        } finally {
          active = false;
        }
      },
      async execute(input: NativeCaptureInput, signal: AbortSignal) {
        if (publications.size) throw new ApplicationError("INTERRUPTED");
        if (
          this !== runtime ||
          active ||
          closed ||
          closing ||
          service ||
          reference?.retainsService
        )
          throw new ApplicationError("FORBIDDEN");
        const owned = structuredClone(input);
        if (
          !["capture", "inspect", "convert", "artifact"].includes(
            owned.operation,
          ) ||
          !validateContract("StableId", owned.requestId).success ||
          Object.keys(owned).some(
            (key) =>
              ![
                "operation",
                "requestId",
                "url",
                "role",
                "outputRelative",
              ].includes(key),
          )
        )
          throw new ApplicationError("INVALID_INPUT");
        if (
          (owned.operation === "capture") !== (typeof owned.url === "string") ||
          (owned.operation !== "artifact" &&
            (owned.role !== undefined || owned.outputRelative !== undefined)) ||
          (owned.operation === "artifact" &&
            (!owned.role || !owned.outputRelative))
        )
          throw new ApplicationError("INVALID_INPUT");
        active = true;
        const deadline = new Date(policy.clock.now() + 30000).toISOString();
        const jobId = identity(owned.requestId);
        const base = { jobId, requestId: owned.requestId, signal, deadline };
        let attemptFailure: ErrorCode | undefined;
        let attemptDiagnostic: ReferenceDiagnostic | undefined;
        try {
          await policy.check();
          let ctx = await policy.issue(base);
          const existing = await discover(ctx, jobId);
          if (owned.operation === "capture") {
            if (!owned.url) throw new ApplicationError("INVALID_INPUT");
            const selected = selectionPolicy(owned.url);
            capture = createFigmaCaptureJobs({
              policy: selected,
              authority: policy.verify,
              credentials: work.credentials(),
              repository: db.jobs,
              readArtifact: read,
            });
            const normalized = capture.normalize({
              schemaVersion: "1.0",
              projectId: project.projectId,
              captureId: jobId,
              selectionUrl: owned.url,
              policyId: selected.id,
              policySha256: canonicalDigest(selected),
              credential: project.reference,
            });
            captureRecovery?.activate(normalized.request);
            if (existing.length) {
              await committed(owned.requestId, ctx, normalized.request);
            } else {
              await work.readyCredential(policy.clock.now());
              const history = await discover(ctx);
              ctx = await policy.issue({
                ...base,
                network: selected,
                jobReads: history,
              });
              const recoveryBinding = await capture.prepare(
                normalized.request,
                ctx,
              );
              const resources = nativeCaptureResources(project.projectId);
              const seedId = `seed_${canonicalDigest([jobId, normalized.request])}`;
              const seed = await policy.issue({
                ...base,
                jobId: seedId,
                requestId: seedId,
              });
              let receipt = unwrap(await db.getReceipt(seedId, seed));
              if (!receipt) {
                const staged = [
                  unwrap(await db.stage(normalized.bytes, seed)),
                  unwrap(await db.stage(canonicalBytes(resources), seed)),
                ];
                receipt = unwrap(await db.commit(staged, seed));
                if (recoveryBinding) {
                  // The grant proves these resource bytes already have an immutable receipt.
                  // Release only this invocation's redundant seed stage, never an old job stage.
                  const resourceStage = staged[1];
                  if (!resourceStage)
                    throw new ApplicationError("ARTIFACT_INTEGRITY");
                  unwrap(await fs.discard(resourceStage.stagingId, seed));
                }
              }
              const requestArtifact = receipt.outputs[0];
              const resource = receipt.outputs[1];
              if (
                receipt.outputs.length !== 2 ||
                !requestArtifact ||
                !resource ||
                requestArtifact.sha256 !== hashBytes(normalized.bytes) ||
                resource.sha256 !== canonicalDigest(resources)
              )
                throw new ApplicationError("ARTIFACT_INTEGRITY");
              const execution = capture;
              service = createJobService({
                projectId: project.projectId,
                repository: db.jobs,
                clock: policy.clock,
                artifactRootId: project.artifactRootId,
                ownerId: `owner_${canonicalDigest([work.actorId, jobId])}`,
                handlers: execution.handlers.map((handler) => ({
                  ...handler,
                  run: async (jobExecution) => {
                    try {
                      return await handler.run(jobExecution);
                    } catch (error) {
                      attemptDiagnostic =
                        referenceDiagnosticFields(error).referenceDiagnostic;
                      throw error;
                    }
                  },
                })),
                executionAuthority: {
                  verify: policy.verify,
                  observe: async (jobSignal) =>
                    policy.issue({
                      ...base,
                      signal: jobSignal,
                      parentSignal: signal,
                      jobWrite: false,
                    }),
                  issue: async (record, jobSignal) => {
                    checkRecord(record, owned.requestId);
                    await work.readyCredential(policy.clock.now());
                    if (record.job.deadline !== ctx.deadline)
                      throw new ApplicationError("FORBIDDEN");
                    return policy.issue({
                      ...base,
                      signal: jobSignal,
                      parentSignal: signal,
                      deadline: record.job.deadline,
                      network: selected,
                      jobReads: history,
                    });
                  },
                },
                recoveryAuthority: {
                  issue: async (record, jobSignal) => {
                    checkRecord(record, owned.requestId);
                    const cleanup = await policy.issue({
                      jobId,
                      requestId: record.requestId,
                      signal: jobSignal,
                    });
                    recovery.register(record, cleanup);
                    return cleanup;
                  },
                  decide: (record, facts, context) =>
                    recovery.decide(record, facts, context),
                },
              });
              try {
                unwrap(
                  await execution.submit(
                    service,
                    normalized.request,
                    requestArtifact,
                    {
                      snapshotId: resource.id,
                      sha256: resource.sha256,
                      componentRegistryRevision: "none",
                      tokenRegistryRevision: "none",
                      selectedModes: {},
                    },
                    `native_${work.policySha256}`,
                    ctx,
                  ),
                );
                unwrap(await service.start());
                unwrap(await service.waitForAttempt(jobId, ctx));
              } catch (error) {
                attemptFailure = signal.aborted
                  ? "CANCELLED"
                  : safeError(error).code;
                throw error;
              } finally {
                // Keep ownership if bounded stop cannot join the original work.
                unwrap(await service.stop());
                service = undefined;
                execution.releaseJob(jobId);
              }
            }
          } else if (!existing.length) throw new ApplicationError("NOT_FOUND");
          const loaded = await committed(owned.requestId, ctx);
          if (!loaded.result || !loaded.manifest || !loaded.artifacts) {
            const state = loaded.record.job.status;
            primaryFailure = loaded.record.job.error?.code ?? "ACTION_REQUIRED";
            const status =
              state === "cancelled"
                ? "cancelled"
                : state === "interrupted"
                  ? "interrupted"
                  : "unavailable";
            return envelope(
              owned.operation,
              owned.requestId,
              status,
              {
                jobId,
                jobStatus: state,
                readiness: "not-evaluated",
                artifacts: [],
                missing: ["capture-not-committed"],
              },
              loaded.record.job.error?.code ?? "ACTION_REQUIRED",
              referenceDiagnosticFields(loaded.record.job.error)
                .referenceDiagnostic ?? attemptDiagnostic,
            );
          }
          const { result, manifest, artifacts } = loaded;
          let readiness: Value["readiness"] = "not-evaluated";
          if (
            owned.operation === "convert" ||
            (owned.operation === "artifact" &&
              owned.role &&
              [
                "design",
                "resources",
                "source-map",
                "conversion-evidence",
                "provenance",
                "report",
              ].includes(owned.role))
          ) {
            readiness = await convertCommitted(
              loaded.request,
              manifest,
              ctx,
              artifacts,
            );
          }
          if (owned.operation === "artifact") {
            if (
              !owned.role ||
              !owned.outputRelative ||
              !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(owned.outputRelative)
            )
              throw new ApplicationError("INVALID_INPUT");
            const artifact = artifacts.find(
              (entry) => entry.role === owned.role,
            )?.artifact;
            if (!artifact) throw new ApplicationError("NOT_FOUND");
            ctx = await policy.issue({ ...base, output: true });
            unwrap(await db.checkOrdinaryWrite(ctx));
            const source = await read(artifact, ctx);
            try {
              const staged = unwrap(
                await fs.stage(
                  {
                    artifactRootId: policy.outputRoot,
                    path: owned.outputRelative,
                  },
                  source.bytes,
                  ctx,
                ),
              );
              unwrap(await publish(staged, ctx));
              await policy.check();
            } finally {
              source.bytes.fill(0);
            }
          }
          await policy.check();
          authorizeOperation(
            ctx,
            {
              projectId: project.projectId,
              resourceKind: "artifact",
              resourceId: project.artifactRootId,
              operation: "read",
            },
            policy.verify,
          );
          const partial =
            result.completeness !== "complete" || owned.operation === "convert";
          return envelope(
            owned.operation,
            owned.requestId,
            partial ? "partial" : "complete",
            {
              jobId,
              jobStatus: loaded.record.job.status,
              capture: result,
              readiness,
              missing: [...manifest.missing],
              artifacts,
              ...(manifest.remediationOrigin
                ? { remediationOrigin: manifest.remediationOrigin }
                : {}),
              ...(owned.operation === "artifact"
                ? { outputRelative: owned.outputRelative }
                : {}),
            },
            partial ? (result.errorCode ?? "ACTION_REQUIRED") : undefined,
            result.referenceDiagnostic,
          );
        } catch (error) {
          const code = signal.aborted ? "CANCELLED" : safeError(error).code;
          primaryFailure = attemptFailure ?? code;
          return envelope(
            owned.operation,
            owned.requestId,
            code === "CANCELLED"
              ? "cancelled"
              : code === "INTERRUPTED"
                ? "interrupted"
                : "failed",
            undefined,
            code,
            referenceDiagnosticFields(error).referenceDiagnostic ??
              attemptDiagnostic,
          );
        } finally {
          active = false;
          captureRecovery?.clear();
        }
      },
      async close() {
        if (this !== runtime) throw new ApplicationError("FORBIDDEN");
        await close();
      },
    });
    async function convertCommitted(
      request: FigmaCaptureRequest,
      manifest: FigmaCaptureManifest,
      context: OperationContext,
      artifacts: Value["artifacts"],
    ) {
      if (!manifest.source || !manifest.sourceVersion)
        throw new ApplicationError("EVIDENCE_MISSING");
      const sourceArtifact = artifacts.find(
        (entry) => entry.role === "source",
      )?.artifact;
      const nodes = artifacts.find((entry) => entry.role === "nodes")?.artifact;
      if (
        !sourceArtifact ||
        !nodes ||
        !same(ref(sourceArtifact), manifest.source)
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      const source = await json("SourceSnapshot", sourceArtifact, context);
      if (
        source.projectId !== project.projectId ||
        source.identity.transport !== "figma-rest" ||
        source.consistency.guarantee !== "version-pinned" ||
        source.identity.fileKey !== manifest.selection.fileKey ||
        source.identity.sourceVersion !== manifest.sourceVersion ||
        source.identity.nodeId !== manifest.selection.nodeId ||
        !source.artifacts.some((artifact) => same(artifact, nodes))
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
      for (const operation of ["nodes", "reference-render"] as const) {
        const observation = manifest.observations.find(
          (entry) => entry.operation === operation,
        );
        if (
          !observation ||
          observation.requestedVersion !== manifest.sourceVersion
        )
          throw new ApplicationError("EVIDENCE_MISSING");
        if (
          operation === "nodes" &&
          (observation.returnedVersion !== manifest.sourceVersion ||
            observation.outcome !== "complete")
        )
          throw new ApplicationError("EVIDENCE_MISSING");
      }
      const raw = await read(nodes, context);
      try {
        const check = () =>
          authorizeOperation(
            context,
            {
              projectId: project.projectId,
              resourceKind: "artifact",
              resourceId: project.artifactRootId,
              operation: "read",
            },
            policy.verify,
          );
        const conversion = captureConversionIdentity(
          request.captureId,
          manifest,
          nodes,
        );
        const converted = convertFigmaStructure(
          {
            policy: conversion.policy,
            selection: manifest.selection,
            structure: nodes,
            structureBytes: raw.bytes,
            projectId: project.projectId,
            designId: conversion.designId,
            intakeId: request.captureId,
            actorId: work.actorId,
            observedAt: manifest.endedAt,
          },
          {
            deadline: Date.parse(context.deadline),
            now: () => {
              check();
              return policy.clock.now();
            },
            signal: context.signal,
          },
        );
        try {
          if (hashBytes(converted.originalBytes) !== nodes.sha256)
            throw new ApplicationError("ARTIFACT_INTEGRITY");
          const entries = captureConversionEntries(converted, sourceArtifact);
          const key = conversion.operationId;
          const ctx = await policy.issue({
            jobId: key,
            requestId: key,
            signal: context.signal,
            deadline: context.deadline,
          });
          artifacts.push(
            ...(await persistCaptureConversion(entries, db, ctx, async () => {
              await policy.check();
              check();
            })),
          );
          return converted.report.readiness === "blocked"
            ? ("blocked" as const)
            : ("needs-review" as const);
        } finally {
          converted.originalBytes.fill(0);
        }
      } finally {
        raw.bytes.fill(0);
      }
    }
    return runtime;
  } catch (error) {
    try {
      await close();
    } catch {
      throw new NativeCaptureStartupCleanupRequired(close);
    }
    throw error;
  }
}
