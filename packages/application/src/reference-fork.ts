import type {
  Artifact,
  NativeReferenceForkEnvelope,
  OperationContext,
  ReferenceForkOrigin,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { convertFigmaStructure } from "@design-studio/figma-import";
import {
  authorizeOperation,
  ProjectFileSystem,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import {
  acquireCaptureWork,
  type CaptureProject,
  CaptureStartupCleanupRequired,
  type CaptureWork,
} from "@design-studio/project-host";
import {
  LocalStore,
  type ReferenceForkReservation,
  type StorageOptions,
} from "@design-studio/storage";
import { REFERENCE_LIMITS } from "../../figma-capture/dist/reference.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import { captureConversionEntries } from "./capture-conversion.js";
import { NativeCaptureCleanupRequired } from "./capture-runtime-internal.js";
import { ReferenceInput } from "./reference-input.js";
import { ReferenceReader, ref, same } from "./reference-proof.js";
import { proveRecordedRecoveredReference } from "./reference-validation.js";
import { ApplicationError, safeError, unwrap } from "./response.js";

export const REFERENCE_FORK_CONFIRMATION =
  "FORK-VERIFIED-INPUTS-AND-CONVERT-OFFLINE";
export interface NativeReferenceForkInput {
  operation: "reference-fork";
  requestId: string;
  expectedJob: string;
  expectedRecovery: string;
  confirmation: string;
}
const deny = async (): Promise<never> => {
  throw new ApplicationError("FORBIDDEN");
};
function artifact(bytes: Uint8Array): Artifact {
  const sha256 = hashBytes(bytes);
  return {
    id: `sha256_${sha256}`,
    sha256,
    path: `blobs/${sha256}`,
    byteLength: bytes.length,
    mediaType: "application/octet-stream",
  };
}

/** Separate selected-recorded-input authority; old retained inventory/recovery is never relaxed. */
export function openNativeReferenceFork(
  source: CaptureProject,
  createDestination: () => Promise<CaptureProject>,
) {
  const sourceWork = acquireCaptureWork(source);
  let destination: CaptureProject | undefined;
  let destinationWork: CaptureWork | undefined;
  let sourceFiles: ProjectFileSystem | undefined;
  let destinationFiles: ProjectFileSystem | undefined;
  let sourceStore: LocalStore | undefined;
  let destinationStore: LocalStore | undefined;
  let pin:
    | Awaited<ReturnType<NonNullable<CaptureWork["pinReferenceForkDatabase"]>>>
    | undefined;
  let reader: ReferenceReader | undefined;
  let active = false;
  let consumed = false;
  let closed = false;
  let primary: NativeReferenceForkEnvelope["error"];
  let startupCleanup: (() => Promise<void>) | undefined;
  let failureResult: NativeReferenceForkEnvelope | undefined;
  const close = async () => {
    if (closed) return;
    if (active) throw new ApplicationError("INTERRUPTED");
    try {
      await startupCleanup?.();
      startupCleanup = undefined;
      await reader?.close();
      reader = undefined;
      destinationStore?.close();
      destinationStore = undefined;
      sourceStore?.close();
      sourceStore = undefined;
      pin?.close();
      pin = undefined;
      await destinationFiles?.closePreservingStages();
      destinationFiles = undefined;
      await sourceFiles?.closePreservingStages();
      sourceFiles = undefined;
      destinationWork?.close();
      destinationWork = undefined;
      await destination?.close();
      sourceWork.close();
      closed = true;
    } catch (error) {
      throw new NativeCaptureCleanupRequired(
        primary?.code ?? "INTERRUPTED",
        safeError(error).code,
        close,
        [],
      );
    }
  };
  return {
    close,
    get failureResult() {
      return failureResult;
    },
    async execute(
      supplied: NativeReferenceForkInput,
      signal: AbortSignal,
    ): Promise<NativeReferenceForkEnvelope> {
      if (active || consumed || closed) throw new ApplicationError("FORBIDDEN");
      const input = structuredClone(supplied);
      active = true;
      consumed = true;
      const meter = new ReferenceInput();
      const copies: Uint8Array[] = [];
      const issued = new Set<OperationContext["authorization"]>();
      const deadline = new Date(
        sourceWork.policy.clock.now() + 30000,
      ).toISOString();
      let reservation: ReferenceForkReservation | undefined;
      let result: unknown;
      const check = async () => {
        signal.throwIfAborted();
        if (sourceWork.policy.clock.now() >= Date.parse(deadline))
          throw new ApplicationError("DEADLINE_EXCEEDED");
        await sourceWork.current();
        if (!sourceWork.referenceForkAuthority)
          throw new ApplicationError("FORBIDDEN");
        await sourceWork.referenceForkAuthority();
        if (destinationWork) {
          await destinationWork.current();
          if (!destinationWork.referenceForkAuthority)
            throw new ApplicationError("FORBIDDEN");
          await destinationWork.referenceForkAuthority();
        }
      };
      const authorize = async (
        work: CaptureWork,
        context: OperationContext,
        write = false,
      ) => {
        await check();
        if (
          !issued.has(context.authorization) ||
          !work.policy.verify(context.authorization) ||
          context.projectId !== work.project.projectId ||
          context.signal !== signal ||
          context.authorization.egress !== "deny" ||
          context.clock !== work.policy.clock ||
          (write && work === sourceWork)
        )
          throw new ApplicationError("FORBIDDEN");
      };
      const issue = async (
        work: CaptureWork,
        jobId: string,
        requestId: string,
        jobReads: string[],
        write: boolean,
      ) => {
        const value = await work.policy.issueReferenceFork({
          jobId,
          requestId,
          jobReads,
          write,
          deadline,
          signal,
        });
        issued.add(value.authorization);
        return value;
      };
      const options = (
        work: CaptureWork,
        files: ProjectFileSystem,
      ): StorageOptions => ({
        databasePath: work.project.paths.database,
        nativeBinding: work.sqliteBinding,
        projectId: work.project.projectId,
        artifactRootId: work.project.artifactRootId,
        permissionScope: work.permissionScope,
        canonicalBytes,
        snapshotOperationContext,
        fileSystem: files,
        attestLocalDatabase: work.attestDatabase.bind(work),
        authorize: async (context, scope) => {
          await authorize(work, context, scope.operation === "write");
          authorizeOperation(
            context,
            scope.resourceKind === "artifact"
              ? { ...scope, resourceId: work.project.artifactRootId }
              : scope,
            work.policy.verify,
          );
        },
        referenceInspection: {
          authorize: (context) => authorize(work, context),
        },
        ensurePublicationDurable: async (artifacts, context) => {
          await authorize(work, context, true);
          unwrap(
            await files.ensurePublicationDurable(
              work.project.artifactRootId,
              artifacts,
              context,
            ),
          );
        },
        ensureDatabaseBackupDurable: deny,
        verifyRevision: deny,
        assessApproval: deny,
        authorizeRestore: deny,
        authorizeRetention: deny,
        canDiscardStage: deny,
        maintenance: { inventory: deny, removeBlob: deny },
        jobs: {
          clock: work.policy.clock,
          limits: REFERENCE_LIMITS,
          discovery: { authorizeOwner: (context) => authorize(work, context) },
          verifyCompletion: deny,
          authorizeRecovery: deny,
        },
      });
      const base = {
        schemaVersion: "1.0" as const,
        operation: "reference-fork" as const,
        projectId: source.projectId,
        requestId: input.requestId,
      };
      try {
        if (
          Object.keys(input).sort().join(",") !==
            "confirmation,expectedJob,expectedRecovery,operation,requestId" ||
          input.operation !== "reference-fork" ||
          input.confirmation !== REFERENCE_FORK_CONFIRMATION ||
          !/^[a-f0-9]{64}$/.test(input.expectedJob) ||
          !/^[a-f0-9]{64}$/.test(input.expectedRecovery) ||
          !validateContract("StableId", input.requestId).success
        )
          throw new ApplicationError("INVALID_INPUT");
        await check();
        if (
          !sourceWork.pinReferenceForkDatabase ||
          !sourceWork.pinReferenceValidationEntry
        )
          throw new ApplicationError("FORBIDDEN");
        initializeImmutableSqlite(sourceWork.sqliteBinding);
        pin = await sourceWork.pinReferenceForkDatabase();
        const recordedPaths = new Set<string>();
        sourceFiles = await ProjectFileSystem.create({
          projectId: source.projectId,
          authority: sourceWork.policy.verify,
          budgetLimits: REFERENCE_LIMITS,
          reserveRead: (bytes) => meter.reserveRead(bytes),
          roots: [
            {
              id: source.artifactRootId,
              path: source.paths.artifacts,
              access: "read",
              managedBlobs: true,
              trustedExclusiveAccess: true,
            },
          ],
          recordedRead: {
            authorize: async (request, context) => {
              await authorize(sourceWork, context);
              if (
                request.artifactRootId !== source.artifactRootId ||
                !recordedPaths.has(request.path)
              )
                throw new ApplicationError("FORBIDDEN");
            },
            pin: sourceWork.pinReferenceValidationEntry.bind(sourceWork),
          },
        });
        sourceStore = await LocalStore.open({
          ...options(sourceWork, sourceFiles),
          access: "read-only",
          readonlySnapshot: pin,
          referenceRecovery: {
            authorize: (context) => authorize(sourceWork, context),
            verify: deny,
          },
        });
        const metadataContext = await issue(
          sourceWork,
          `fork_reference_${canonicalDigest([source.projectId, input])}`,
          input.requestId,
          [],
          false,
        );
        const initial = unwrap(
          await sourceStore.referenceRecoverySnapshot(metadataContext),
        );
        if (initial.schema !== 5 || initial.records.length !== 1)
          throw new ApplicationError("ACTION_REQUIRED");
        const recovery = initial.records[0];
        if (
          !recovery ||
          recovery.events[7]?.kind !== "committed" ||
          canonicalDigest(recovery.events[7].receipt) !== input.expectedRecovery
        )
          throw new ApplicationError("CONFLICT");
        for (const a of unwrap(
          await sourceStore.referencePublicationState(metadataContext),
        ).artifacts)
          recordedPaths.add(a.path);
        const prove = async () => {
          if (!sourceStore || !sourceFiles)
            throw new ApplicationError("FORBIDDEN");
          const db = sourceStore;
          const fs = sourceFiles;
          return proveRecordedRecoveredReference(
            {
              work: sourceWork,
              store: sourceStore,
              files: sourceFiles,
              requestId: input.requestId,
              expectedJob: input.expectedJob,
              reason: () => {},
              issue: async (job, reads) => {
                await reader?.close();
                reader = new ReferenceReader(
                  sourceWork,
                  db,
                  fs,
                  await issue(sourceWork, job, input.requestId, reads, false),
                  meter,
                  true,
                  true,
                );
                return reader;
              },
            },
            recovery,
          );
        };
        const verified = await prove();
        const capture = verified.proof.verifiedCaptureOutputs(
          verified.source.verifiedCapture,
          verified.proposal,
        );
        const nodes = capture.artifacts.find(
          (a) => a.role === "nodes",
        )?.artifact;
        if (!nodes || !recovery.events[7].receipt)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const references = [
          ref(verified.proposal.binding.source),
          ref(nodes),
          ref(recovery.reservation.binding.reference),
          ref(recovery.reservation.evidence),
        ] as const;
        const selected: { artifact: Artifact; bytes: Uint8Array }[] = [];
        for (const reference of references) {
          const loaded = unwrap(
            await sourceStore.readVerified(reference, verified.proof.context),
          );
          selected.push(loaded);
          copies.push(loaded.bytes);
        }
        await pin.check();
        if (
          !same(
            initial,
            unwrap(
              await sourceStore.referenceRecoverySnapshot(
                verified.proof.context,
              ),
            ),
          )
        )
          throw new ApplicationError("CONFLICT");
        await check();
        destination = await createDestination();
        destinationWork = acquireCaptureWork(destination);
        if (
          destination.projectId === source.projectId ||
          destination.principal.actorId !== source.principal.actorId
        )
          throw new ApplicationError("FORBIDDEN");
        const operationId = `fork_reference_${canonicalDigest([destination.projectId, source.projectId, input.expectedJob, input.expectedRecovery])}`;
        const policySha256 = await destinationWork.referenceForkAuthority?.();
        if (!policySha256) throw new ApplicationError("FORBIDDEN");
        const origin: ReferenceForkOrigin = {
          schemaVersion: "1.0",
          operationId,
          sourceProjectId: source.projectId,
          destinationProjectId: destination.projectId,
          actorId: destinationWork.actorId,
          sourceJobSha256: input.expectedJob,
          sourceStateSha256: canonicalDigest(verified.state),
          sourceControlSha256: canonicalDigest(initial.records),
          recoveryReceipt: recovery.events[7].receipt,
          captureReceipt: capture.receipt,
          source: references[0],
          structure: references[1],
          reference: references[2],
          recoveryEvidence: references[3],
          policySha256,
          ownership: "origin-evidence-not-destination-authority",
        };
        if (!validateContract("ReferenceForkOrigin", origin).success)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const originBytes = canonicalBytes(origin);
        copies.push(originBytes);
        const originRef = ref(artifact(originBytes));
        const structure = selected[1];
        if (!structure) throw new ApplicationError("ARTIFACT_INTEGRITY");
        const converted = convertFigmaStructure(
          {
            policy: "fixed-v2",
            selection: {
              fileKey: verified.proposal.binding.fileKey,
              nodeId: verified.proposal.binding.nodeId,
            },
            structure: structure.artifact,
            structureBytes: structure.bytes,
            projectId: destination.projectId,
            designId: `design_${canonicalDigest([operationId, originRef])}`,
            intakeId: operationId,
            actorId: destinationWork.actorId,
            observedAt: recovery.reservation.binding.recordedAt,
          },
          {
            deadline: Date.parse(deadline),
            now: () => sourceWork.policy.clock.now(),
            signal,
          },
        );
        copies.push(converted.originalBytes);
        converted.provenance.evidence.push({
          id: `evidence_${canonicalDigest([operationId, originRef])}`,
          artifact: origin.reference,
          kind: "source-image",
          sourceNodeId: verified.proposal.binding.nodeId,
          snapshotId: origin.source.id,
          region: verified.proposal.binding.bounds,
        });
        const entries = captureConversionEntries(converted, origin.source);
        copies.push(...entries.map((e) => e.bytes));
        const manifest = {
          schemaVersion: "1.0",
          projectId: destination.projectId,
          operationId,
          origin: originRef,
          artifacts: [
            ...entries.map((e) => ({
              role: e.role,
              artifact: ref(artifact(e.bytes)),
            })),
            { role: "reference", artifact: origin.reference },
          ],
          readiness:
            converted.report.readiness === "blocked"
              ? "blocked"
              : "needs-review",
        };
        if (!validateContract("ReferenceForkResultManifest", manifest).success)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const manifestBytes = canonicalBytes(manifest);
        copies.push(manifestBytes);
        const outputs = [
          ...new Map(
            [
              ...selected.map((s) => s.bytes),
              originBytes,
              manifestBytes,
              ...entries.map((e) => e.bytes),
            ].map((b) => [hashBytes(b), b]),
          ).values(),
        ];
        const destinationContext = await issue(
          destinationWork,
          operationId,
          operationId,
          [],
          true,
        );
        const dw = destinationWork;
        destinationFiles = await ProjectFileSystem.create({
          projectId: destination.projectId,
          authority: dw.policy.verify,
          budgetLimits: REFERENCE_LIMITS,
          reserveRead: (bytes) => meter.reserveRead(bytes),
          publicationProfile: WINDOWS_PUBLICATION_PROFILE,
          roots: [
            {
              id: destination.artifactRootId,
              path: destination.paths.artifacts,
              access: "read-write",
              managedBlobs: true,
              trustedExclusiveAccess: true,
            },
          ],
          reservedStaging: {
            authorize: async (stage, context) => {
              await authorize(dw, context, true);
              if (
                !reservation ||
                stage.hostId !== reservation.hostId ||
                !reservation.stages.some((s) =>
                  same(s, {
                    stagingId: stage.stagingId,
                    artifact: stage.artifact,
                  }),
                )
              )
                throw new ApplicationError("FORBIDDEN");
            },
          },
        });
        const df = destinationFiles;
        const namespace = async (context: OperationContext) => {
          if (!reservation) throw new ApplicationError("FORBIDDEN");
          const owned = reservation;
          unwrap(
            await df.checkReservedNamespace(
              dw.project.artifactRootId,
              owned.stages.map((s) => ({
                ...s,
                hostId: owned.hostId,
              })),
              context,
            ),
          );
        };
        destinationStore = await LocalStore.open({
          ...options(dw, df),
          fileSystem: {
            read: df.read.bind(df),
            stage: deny,
            discard: deny,
            publish: async (stage, context) => {
              await namespace(context);
              const result = await df.publish(stage, context);
              if (result.status === "complete") await namespace(context);
              return result;
            },
          },
          referenceFork: {
            authorize: async (context) => {
              await authorize(dw, context, true);
              if (context.jobId !== operationId)
                throw new ApplicationError("FORBIDDEN");
            },
            stage: async (owned, index, bytes, context) => {
              const s = owned.stages[index];
              if (!s || !reservation || !same(reservation.stages, owned.stages))
                throw new ApplicationError("FORBIDDEN");
              await namespace(context);
              const staged = unwrap(
                await df.stageReserved(
                  { ...s, hostId: owned.hostId },
                  dw.project.artifactRootId,
                  bytes,
                  context,
                ),
              );
              await namespace(context);
              return staged;
            },
          },
        });
        meter.phase = "commit";
        reservation = unwrap(
          await destinationStore.reserveReferenceFork(
            {
              version: 1,
              operationId,
              projectId: destination.projectId,
              artifactRootId: destination.artifactRootId,
              actorId: dw.actorId,
              sourceProjectId: source.projectId,
              originSha256: originRef.sha256,
              resultSha256: hashBytes(manifestBytes),
              policySha256,
            },
            outputs.map(artifact),
            destinationContext,
          ),
        );
        for (const [index, bytes] of outputs.entries()) {
          await check();
          unwrap(
            await destinationStore.stageReferenceFork(
              reservation,
              index,
              bytes,
              destinationContext,
            ),
          );
        }
        // Revalidate the source before the only destination publication, never its unknown stages.
        await prove();
        await pin.check();
        if (
          !same(
            initial,
            unwrap(
              await sourceStore.referenceRecoverySnapshot(metadataContext),
            ),
          )
        )
          throw new ApplicationError("CONFLICT");
        const receipt = unwrap(
          await destinationStore.commitReferenceFork(
            reservation,
            destinationContext,
          ),
        );
        meter.phase = "inspection";
        if (
          !same(receipt.outputs, outputs.map(artifact)) ||
          receipt.projectId !== destination.projectId ||
          receipt.jobId !== operationId
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        for (const a of receipt.outputs) {
          const loaded = unwrap(
            await destinationStore.readVerified(ref(a), destinationContext),
          );
          loaded.bytes.fill(0);
        }
        await namespace(destinationContext);
        unwrap(
          await df.ensurePublicationDurable(
            dw.project.artifactRootId,
            receipt.outputs,
            destinationContext,
          ),
        );
        await check();
        await pin.check();
        if (
          !same(
            initial,
            unwrap(
              await sourceStore.referenceRecoverySnapshot(metadataContext),
            ),
          )
        )
          throw new ApplicationError("CONFLICT");
        result = {
          ...base,
          destinationProjectId: destination.projectId,
          status: "complete",
          inputAccounting: meter.snapshot(),
          conversion: {
            operationId,
            origin: originRef,
            receiptSha256: canonicalDigest(receipt),
            outputs: receipt.outputs,
            artifacts: [
              ...entries.map((entry) => ({
                role: entry.role,
                artifact: ref(artifact(entry.bytes)),
              })),
              { role: "reference", artifact: origin.reference },
            ],
            readiness:
              converted.report.readiness === "blocked"
                ? "blocked"
                : "needs-review",
          },
        };
      } catch (error) {
        if (error instanceof CaptureStartupCleanupRequired)
          startupCleanup = error.close;
        const failure = safeError(
          signal.aborted ? new ApplicationError("CANCELLED") : error,
        );
        primary = {
          code: failure.code,
          message: failure.message,
          retryable: false,
          diagnosticIds: [],
        };
        result = {
          ...base,
          status: "failed",
          inputAccounting: meter.snapshot(),
          error: primary,
          ...(destination
            ? {
                destinationProjectId: destination.projectId,
                partialDestination: "blocked-no-replay" as const,
              }
            : {}),
        };
      } finally {
        for (const bytes of copies) bytes.fill(0);
        active = false;
      }
      const fallback = validateContract("NativeReferenceForkEnvelope", {
        ...base,
        status: "failed",
        inputAccounting: meter.snapshot(),
        error: primary ?? {
          code: "INTERRUPTED",
          message: "Fork finalization is incomplete; no replay is authorized.",
          retryable: false,
          diagnosticIds: [],
        },
        ...(destination
          ? {
              destinationProjectId: destination.projectId,
              partialDestination: "blocked-no-replay",
            }
          : {}),
      });
      if (fallback.success) failureResult = fallback.value;
      try {
        await close();
      } catch (error) {
        const failed = validateContract("NativeReferenceForkEnvelope", {
          ...base,
          status: "failed",
          inputAccounting: meter.snapshot(),
          error: {
            code: "INTERRUPTED",
            message:
              "Fork cleanup is incomplete; original ownership is retained.",
            retryable: false,
            diagnosticIds: [],
          },
          ...(destination
            ? {
                destinationProjectId: destination.projectId,
                partialDestination: "blocked-no-replay",
              }
            : {}),
        });
        if (failed.success) failureResult = failed.value;
        if (error instanceof NativeCaptureCleanupRequired) throw error;
        throw new ApplicationError("INTERRUPTED");
      }
      if (
        !primary &&
        (signal.aborted ||
          sourceWork.policy.clock.now() >= Date.parse(deadline))
      ) {
        const code = signal.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED";
        result = {
          ...base,
          status: "failed",
          inputAccounting: meter.snapshot(),
          error: {
            code,
            message:
              "Fork finalization exceeded its original invocation; committed data is preserved, no replay authorized.",
            retryable: false,
            diagnosticIds: [],
          },
          ...(destination
            ? {
                destinationProjectId: destination.projectId,
                partialDestination: "blocked-no-replay",
              }
            : {}),
        };
      }
      const parsed = validateContract("NativeReferenceForkEnvelope", result);
      if (!parsed.success || canonicalBytes(result).length > 8192)
        throw new ApplicationError("INVALID_SCHEMA");
      return parsed.value;
    },
  };
}
