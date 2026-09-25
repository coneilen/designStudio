import type {
  Artifact,
  EffectiveReference,
  NativeReferenceOfflineEnvelope,
  OfflineReferencePlan,
  OperationContext,
  ReferenceConversionInspection,
  ReferenceRecoveryBinding,
  StagedArtifact,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import {
  authorizeOperation,
  ProjectFileSystem,
  type RetainedReferenceInput,
  type RetainedReferenceInspection,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import {
  acquireCaptureWork,
  type CaptureProject,
} from "@design-studio/project-host";
import {
  LocalStore,
  projectRecoveryState,
  type ReferenceRecoveryRecord,
  type ReferenceRecoveryReservation,
  recoveryEvidence,
  recoveryOutputs,
  referenceRecoveryHead,
  referenceRecoveryId,
  referenceRecoveryState,
  type StorageOptions,
} from "@design-studio/storage";
import { REFERENCE_LIMITS } from "../../figma-capture/dist/reference.js";
import { REFERENCE_OFFLINE_POLICY_SHA256 } from "../../project-host/dist/reference-offline-profile.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import {
  NativeCaptureCleanupRequired,
  NativeCaptureStartupCleanupRequired,
} from "./capture-runtime-internal.js";
import {
  assertReferenceConversionReceipt,
  prepareReferenceConversion,
} from "./reference-conversion.js";
import { ReferenceInput } from "./reference-input.js";
import { ReferenceReader, ref, same } from "./reference-proof.js";
import {
  proveRetainedReference,
  retainedPlanFacts,
} from "./reference-validation.js";
import { ApplicationError, safeError, unwrap } from "./response.js";

export const REFERENCE_RECOVERY_CONFIRMATION =
  "RECOVER-VERIFIED-REFERENCE-OFFLINE";
export const REFERENCE_CONVERSION_CONFIRMATION =
  "CONVERT-WITH-RECOVERED-REFERENCE";
export interface NativeReferenceOfflineInput {
  operation: NativeReferenceOfflineEnvelope["operation"];
  requestId: string;
  expectedJob: string;
  expectedProof?: string;
  expectedRecovery?: string;
  confirmation?: string;
}
type Verified = Awaited<ReturnType<typeof proveRetainedReference>>;
const descriptor = (bytes: Uint8Array): Artifact => {
  const sha256 = hashBytes(bytes);
  return {
    id: `sha256_${sha256}`,
    sha256,
    path: `blobs/${sha256}`,
    mediaType: "application/octet-stream",
    byteLength: bytes.length,
  };
};
const deny = async (): Promise<never> => {
  throw new ApplicationError("FORBIDDEN");
};

/** Native-only composition; no writable store, transport or credential object is shared with v6. */
export async function openNativeReferenceOffline(project: CaptureProject) {
  return openOffline(project, false);
}

export async function openNativeReferenceConversionInspection(
  project: CaptureProject,
) {
  return openOffline(project, true);
}

async function openOffline(
  project: CaptureProject,
  conversionInspection: boolean,
) {
  const work = acquireCaptureWork(project);
  let store: LocalStore | undefined;
  let files: ProjectFileSystem | undefined;
  let pin:
    | Awaited<ReturnType<NonNullable<typeof work.pinReferenceOfflineDatabase>>>
    | undefined;
  let reader: ReferenceReader | undefined;
  let inspection: RetainedReferenceInspection | undefined;
  let expectedInspection: RetainedReferenceInput | undefined;
  let verified: Verified | undefined;
  let active = false;
  let closed = false;
  let cleanupRequired = false;
  let input = new ReferenceInput();
  let signal: AbortSignal | undefined;
  let deadline = "";
  let issued = new Set<OperationContext["authorization"]>();
  let writer = false;
  let writerContext: OperationContext | undefined;
  let failure: NativeReferenceOfflineEnvelope["error"];
  const conversionStages: StagedArtifact[] = [];
  let publicationAdditions: Parameters<
    RetainedReferenceInspection["checkOriginals"]
  >[0];
  const inspectionAuthority = async () => {
    if (!work.referenceConversionInspectionAuthority)
      throw new ApplicationError("FORBIDDEN");
    return work.referenceConversionInspectionAuthority();
  };
  const check = async () => {
    await work.current();
    if (!active || !signal || !work.referenceOfflineAuthority)
      throw new ApplicationError("FORBIDDEN");
    await work.referenceOfflineAuthority();
    if (conversionInspection) await inspectionAuthority();
    if (signal.aborted) throw new ApplicationError("CANCELLED");
    if (work.policy.clock.now() >= Date.parse(deadline))
      throw new ApplicationError("DEADLINE_EXCEEDED");
  };
  const authorize = async (context: OperationContext) => {
    await check();
    if (
      !issued.has(context.authorization) ||
      !work.policy.verify(context.authorization) ||
      context.signal !== signal ||
      context.clock !== work.policy.clock ||
      context.deadline !== deadline ||
      context.authorization.egress !== "deny" ||
      context.projectId !== project.projectId
    )
      throw new ApplicationError("FORBIDDEN");
  };
  const closeReads = async () => {
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
    if (!inspection && !reader) {
      expectedInspection = undefined;
      verified = undefined;
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Offline proof closures remain unsettled.",
      );
  };
  const closeStore = async () => {
    const errors: unknown[] = [];
    try {
      await closeReads();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!writer) await pin?.check();
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
        if (!writer) await pin?.check();
      } catch (error) {
        errors.push(error);
      }
      try {
        pin?.close();
        pin = undefined;
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
    if (errors.length)
      throw new AggregateError(
        errors,
        "Offline store closures remain unsettled.",
      );
  };
  const close = async () => {
    if (closed) return;
    if (active) throw new ApplicationError("INTERRUPTED");
    try {
      await closeStore();
      work.close();
      closed = true;
    } catch (error) {
      cleanupRequired = true;
      const result = new NativeCaptureCleanupRequired(
        failure?.code ?? "INTERRUPTED",
        safeError(error).code,
        close,
        [],
      );
      result.cause = error;
      throw result;
    }
  };
  const makeFiles = async (write: boolean) => {
    if (conversionInspection && write) throw new ApplicationError("FORBIDDEN");
    return ProjectFileSystem.create({
      projectId: project.projectId,
      authority: work.policy.verify,
      reserveRead: (bytes) => input.reserveRead(bytes),
      budgetLimits: REFERENCE_LIMITS,
      ...(write ? { publicationProfile: WINDOWS_PUBLICATION_PROFILE } : {}),
      roots: [
        {
          id: project.artifactRootId,
          path: project.paths.artifacts,
          access: write ? "read-write" : "read",
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
        authorize: async (value, context) => {
          await authorize(context);
          if (!expectedInspection || !same(value, expectedInspection))
            throw new ApplicationError("FORBIDDEN");
        },
        pin: async (...args) => {
          await check();
          if (!work.pinReferenceValidationEntry)
            throw new ApplicationError("FORBIDDEN");
          return work.pinReferenceValidationEntry(...args);
        },
      },
    });
  };
  const options = (fs: ProjectFileSystem): StorageOptions => ({
    projectId: project.projectId,
    artifactRootId: project.artifactRootId,
    permissionScope: work.permissionScope,
    databasePath: project.paths.database,
    nativeBinding: work.sqliteBinding,
    canonicalBytes,
    snapshotOperationContext,
    attestLocalDatabase: work.attestDatabase.bind(work),
    authorize: async (context, scope) => {
      await authorize(context);
      if (
        scope.operation === "write" &&
        (!writer || context.authorization !== writerContext?.authorization)
      )
        throw new ApplicationError("FORBIDDEN");
      authorizeOperation(
        context,
        scope.resourceKind === "artifact"
          ? { ...scope, resourceId: project.artifactRootId }
          : scope,
        work.policy.verify,
      );
    },
    fileSystem: {
      read: fs.read.bind(fs),
      stage: writer ? fs.stage.bind(fs) : deny,
      publish: writer
        ? async (staged, context) => {
            await authorize(context);
            if (!verified) throw new ApplicationError("FORBIDDEN");
            await verified.inspection.checkOriginals(publicationAdditions);
            verified.inspection.pauseOriginalPins();
            fs.closeRetainedProofReads();
            const outcome = await fs.publish(staged, context);
            if (outcome.status === "complete")
              await verified.inspection.checkOriginals(publicationAdditions);
            return outcome;
          }
        : deny,
      discard: deny,
    },
    referenceInspection: { authorize },
    referenceRecovery: {
      authorize,
      verify: async (record, state, context) => {
        await authorize(context);
        if (
          !verified ||
          !record ||
          !same(
            record.reservation.binding.originalJobId,
            verified.record.job.id,
          ) ||
          !same(
            projectRecoveryState(state, record, canonicalDigest),
            verified.state,
          )
        )
          throw new ApplicationError("CONFLICT");
        publicationAdditions = {
          artifacts: [
            ...recoveryOutputs(record.reservation),
            ...(record.events[8]?.outputs ?? []),
          ],
          stages: [
            ...record.events.flatMap((e) => (e.staged ? [e.staged] : [])),
            ...conversionStages,
          ].map((s) => ({
            stagingId: s.stagingId,
            artifact: s.artifact,
            jobId: record.reservation.binding.recoveryId,
            requestId: record.reservation.binding.recoveryId,
          })),
        };
        await verified.inspection.checkOriginals(publicationAdditions);
      },
    },
    ensurePublicationDurable: async (artifacts, context) => {
      await authorize(context);
      if (!writer) throw new ApplicationError("FORBIDDEN");
      verified?.inspection.pauseOriginalPins();
      fs.closeRetainedProofReads();
      unwrap(
        await fs.ensurePublicationDurable(
          project.artifactRootId,
          artifacts,
          context,
        ),
      );
      await authorize(context);
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
      discovery: { authorizeOwner: authorize },
      verifyCompletion: deny,
      authorizeRecovery: deny,
    },
  });
  const issue = async (jobId: string, jobReads: string[], write = false) => {
    await check();
    if (!signal) throw new ApplicationError("FORBIDDEN");
    if (conversionInspection && write) throw new ApplicationError("FORBIDDEN");
    const input = {
      jobId,
      jobReads,
      requestId: write ? jobId : currentRequest,
      deadline,
      signal,
    };
    const context = conversionInspection
      ? await work.policy.issueReferenceConversionInspection(input)
      : await work.policy.issueReferenceOffline({ ...input, write });
    issued.add(context.authorization);
    return context;
  };
  let currentRequest = "";
  const prove = async (
    expectedJob: string,
    record: ReferenceRecoveryRecord | null,
    phase: "proof" | "admission" | "inspection" = "proof",
  ) => {
    input.phase = phase;
    if (!store || !files) throw new ApplicationError("FORBIDDEN");
    const db = store;
    const fs = files;
    const result = await proveRetainedReference({
      work,
      store: db,
      files: fs,
      requestId: currentRequest,
      expectedJob,
      issue: async (jobId, reads) => {
        await reader?.close();
        reader = new ReferenceReader(
          work,
          db,
          fs,
          await issue(jobId, reads),
          input,
          true,
          true,
        );
        return reader;
      },
      reason: () => {},
      ...(record
        ? {
            projectState: (state: Parameters<typeof projectRecoveryState>[0]) =>
              projectRecoveryState(state, record, canonicalDigest),
          }
        : {}),
      inspect: async (value, context) => {
        expectedInspection = {
          ...value,
          ...(record?.events[7]?.kind === "committed"
            ? {
                recoveredTargetArtifacts: [
                  record.reservation.binding.historicalEvidence,
                  record.reservation.binding.reference,
                ],
              }
            : {}),
        };
        input.phase = phase === "inspection" ? "inspection" : "history";
        inspection = unwrap(
          await fs.inspectRetainedReference(expectedInspection, context),
        );
        return inspection;
      },
    });
    if (record) {
      const b = record.reservation.binding;
      const snapshot = unwrap(
        await db.referenceRecoverySnapshot(result.proof.context),
      );
      if (
        canonicalDigest(result.state) !== b.stateSha256 ||
        canonicalDigest(result.record) !== b.recordSha256 ||
        canonicalDigest(
          result.state.stages.filter((s) => s.jobId === b.originalJobId),
        ) !== b.stagesSha256 ||
        snapshot.preimages.find((p) => p.id === b.recoveryId)
          ?.metadataSha256 !== b.metadataSha256 ||
        !same(b.source, result.proposal.binding.source) ||
        !same(b.approval, result.approved.approved)
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY");
    }
    verified = result;
    return result;
  };
  const effective = async (
    record: ReferenceRecoveryRecord,
    result: Verified,
  ): Promise<EffectiveReference> => {
    if (!store) throw new ApplicationError("FORBIDDEN");
    const final = record.events[7];
    if (final?.kind !== "committed" || !final.receipt)
      throw new ApplicationError("ACTION_REQUIRED");
    const evidence = await result.proof.contract(
      "ReferenceRecoveryEvidence",
      record.reservation.evidence,
    );
    if (
      !same(
        evidence,
        recoveryEvidence(record.reservation.binding, canonicalDigest),
      )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY");
    return {
      kind: "offline-recovered-reference",
      recoveryId: record.reservation.binding.recoveryId,
      receiptSha256: canonicalDigest(final.receipt),
      evidence: ref(record.reservation.evidence),
      source: ref(record.reservation.binding.source),
      reference: ref(record.reservation.binding.reference),
      referenceStatus:
        result.validated.evidence.referenceStatus === "complete"
          ? "complete"
          : "partial",
      pixelWidth: result.validated.decoded.width,
      pixelHeight: result.validated.decoded.height,
      colorSpace: result.validated.decoded.colorSpace,
      historicalStatus: "interrupted",
    };
  };
  try {
    if (!work.referenceOfflineAuthority || !work.pinReferenceOfflineDatabase)
      throw new ApplicationError("FORBIDDEN");
    await work.referenceOfflineAuthority();
    if (conversionInspection) await inspectionAuthority();
    initializeImmutableSqlite(work.sqliteBinding);
  } catch (error) {
    try {
      await close();
    } catch {
      throw new NativeCaptureStartupCleanupRequired(close);
    }
    throw error;
  }
  return {
    close,
    async execute(
      supplied: NativeReferenceOfflineInput,
      suppliedSignal: AbortSignal,
    ): Promise<NativeReferenceOfflineEnvelope> {
      if (closed || active || cleanupRequired || store)
        throw new ApplicationError("FORBIDDEN");
      const owned = structuredClone(supplied);
      active = true;
      input = new ReferenceInput();
      issued = new Set();
      signal = suppliedSignal;
      deadline = new Date(work.policy.clock.now() + 30000).toISOString();
      currentRequest = owned.requestId;
      let reason: NativeReferenceOfflineEnvelope["reason"] = "invalid-input";
      let result: NativeReferenceOfflineEnvelope;
      let committedReceiptSha256: string | undefined;
      const base = {
        schemaVersion: "1.0" as const,
        operation: owned.operation,
        projectId: project.projectId,
        requestId: owned.requestId,
      };
      const copies: Uint8Array[] = [];
      try {
        const extras =
          owned.operation === "reference-recovery-apply"
            ? ["expectedProof", "confirmation"]
            : owned.operation === "convert-reference"
              ? ["expectedRecovery", "confirmation"]
              : owned.operation === "reference-conversion-inspect"
                ? ["expectedRecovery"]
                : [];
        if (
          conversionInspection !==
            (owned.operation === "reference-conversion-inspect") ||
          ![
            "reference-recovery-apply-plan",
            "reference-recovery-apply",
            "reference-recovery-inspect",
            "convert-reference",
            "reference-conversion-inspect",
          ].includes(owned.operation) ||
          Object.keys(owned).sort().join(",") !==
            ["operation", "requestId", "expectedJob", ...extras]
              .sort()
              .join(",") ||
          !validateContract("StableId", owned.requestId).success ||
          !validateContract("Sha256", owned.expectedJob).success ||
          (owned.operation === "reference-recovery-apply" &&
            (!validateContract("Sha256", owned.expectedProof).success ||
              owned.confirmation !== REFERENCE_RECOVERY_CONFIRMATION)) ||
          (owned.operation === "convert-reference" &&
            (!validateContract("Sha256", owned.expectedRecovery).success ||
              owned.confirmation !== REFERENCE_CONVERSION_CONFIRMATION)) ||
          (conversionInspection &&
            !validateContract("Sha256", owned.expectedRecovery).success)
        )
          throw new ApplicationError("INVALID_INPUT");
        reason = "authority-denied";
        await check();
        reason = "database-state";
        if (
          !work.pinReferenceOfflineDatabase ||
          !work.referenceOfflineAuthority
        )
          throw new ApplicationError("FORBIDDEN");
        if (conversionInspection) {
          if (!work.pinReferenceConversionInspectionDatabase)
            throw new ApplicationError("FORBIDDEN");
          pin = await work.pinReferenceConversionInspectionDatabase();
        } else pin = await work.pinReferenceOfflineDatabase();
        files = await makeFiles(false);
        store = await LocalStore.open({
          ...options(files),
          access: "read-only",
          readonlySnapshot: pin,
        });
        const metadataContext = await issue(
          `offline_inspect_${canonicalDigest(currentRequest)}`,
          [],
        );
        const initial = unwrap(
          await store.referenceRecoverySnapshot(metadataContext),
        );
        const matching = initial.records.filter(
          (r) => r.reservation.binding.requestId === currentRequest,
        );
        if (matching.length > 1)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        let record = matching[0] ?? null;
        if (
          conversionInspection &&
          (initial.schema !== 5 ||
            !record ||
            record.reservation.binding.policySha256 !==
              REFERENCE_OFFLINE_POLICY_SHA256)
        )
          throw new ApplicationError("ACTION_REQUIRED");
        if (initial.records.length && !record) {
          reason = "recovery-blocked";
          throw new ApplicationError("ACTION_REQUIRED");
        }
        if (
          record &&
          (record.reservation.binding.actorId !== work.actorId ||
            record.reservation.binding.projectId !== project.projectId ||
            record.reservation.binding.permissionScope !== work.permissionScope)
        )
          throw new ApplicationError("FORBIDDEN");
        if (referenceRecoveryState(record) === "blocked") {
          reason = "recovery-blocked";
          throw new ApplicationError("ACTION_REQUIRED");
        }
        reason = "integrity";
        let proof = await prove(owned.expectedJob, record);
        await pin.check();
        const recoveryId = referenceRecoveryId(
          project.projectId,
          proof.record.job.id,
          canonicalDigest,
        );
        const facts: Omit<OfflineReferencePlan, "proofSha256"> = {
          retained: retainedPlanFacts(
            proof,
            canonicalDigest([
              proof.inspection.identitySha256,
              pin.identitySha256,
            ]),
            await work.referenceOfflineAuthority(),
          ),
          recoveryId,
          policySha256: await work.referenceOfflineAuthority(),
          metadataSha256: initial.metadataSha256,
          schema: initial.schema,
          state: referenceRecoveryState(record),
          controlSha256: canonicalDigest(initial.records),
          projectWriteScope: "single-recovery-and-bound-conversion-only",
          ...(record?.events[7]?.receipt
            ? { receiptSha256: canonicalDigest(record.events[7].receipt) }
            : {}),
        };
        const plan: OfflineReferencePlan = {
          ...facts,
          proofSha256: canonicalDigest(facts),
        };
        let resolved =
          record?.events[7]?.kind === "committed"
            ? await effective(record, proof)
            : undefined;
        let inspectedConversion: ReferenceConversionInspection | undefined;
        if (conversionInspection) {
          if (
            !record ||
            !resolved ||
            resolved.receiptSha256 !== owned.expectedRecovery ||
            ![8, 9, 10].includes(record.events.length)
          )
            throw new ApplicationError("CONFLICT");
          let conversion: ReferenceConversionInspection["conversion"];
          if (record.events.length === 10) {
            const receipt = record.events[9]?.receipt;
            if (!receipt || record.events[9]?.kind !== "conversion-committed")
              throw new ApplicationError("ARTIFACT_INTEGRITY");
            const prepared = await prepareReferenceConversion(
              proof.proof,
              record,
              resolved,
              proof.verifiedCapture,
              proof.proposal,
            );
            copies.push(...prepared.outputs);
            assertReferenceConversionReceipt(prepared, receipt);
            input.phase = "inspection";
            for (const artifact of receipt.outputs) {
              const loaded = unwrap(
                await store.readVerified(ref(artifact), proof.proof.context),
              );
              loaded.bytes.fill(0);
            }
            conversion = {
              operationId: prepared.operationId,
              receiptSha256: canonicalDigest(receipt),
              evidence: prepared.evidence,
              readiness: prepared.readiness,
            };
          }
          await proof.inspection.check();
          await proof.proof.check();
          await pin.check();
          const final = unwrap(
            await store.referenceRecoverySnapshot(proof.proof.context),
          );
          if (!same(initial, final)) throw new ApplicationError("CONFLICT");
          const facts = {
            inspectionPolicySha256: await inspectionAuthority(),
            recoveryPolicySha256: record.reservation.binding.policySha256,
            recoveryId,
            recoveryReceiptSha256: resolved.receiptSha256,
            originalJobSha256: canonicalDigest(proof.record.job),
            originalStateSha256: canonicalDigest(proof.state),
            identitySha256: canonicalDigest([
              proof.inspection.identitySha256,
              pin.identitySha256,
            ]),
            controlSha256: canonicalDigest(final.records),
          };
          const state = conversion
            ? ("committed" as const)
            : ("incomplete" as const);
          const detail =
            record.events.length === 8
              ? ("no-conversion-intent-observed" as const)
              : ("conversion-intent-without-committed-receipt" as const);
          inspectedConversion = {
            verification: "conversion-readonly-v1",
            state,
            proof: {
              ...facts,
              proofSha256: canonicalDigest({
                ...facts,
                state,
                ...(conversion ? { conversion } : { detail }),
              }),
            },
            ...(conversion ? { conversion } : { detail }),
          };
        }
        if (owned.operation === "reference-recovery-apply") {
          reason = "proof-changed";
          if (owned.expectedProof !== plan.proofSha256)
            throw new ApplicationError("CONFLICT");
          if (!record || record.events.length === 0) {
            reason = "ineligible";
            if (
              proof.inspection.targets.some(
                (t) => t.publication !== "stage-only",
              )
            )
              throw new ApplicationError("ACTION_REQUIRED");
            const json =
              proof.inspection.targets[proof.validated.evidenceIndex];
            const image =
              proof.inspection.targets[1 - proof.validated.evidenceIndex];
            if (!json?.bytes || !image?.bytes)
              throw new ApplicationError("ARTIFACT_INTEGRITY");
            const binding: ReferenceRecoveryBinding = record?.reservation
              .binding ?? {
              schemaVersion: "1.0",
              recoveryId,
              projectId: project.projectId,
              actorId: work.actorId,
              permissionScope: work.permissionScope,
              artifactRootId: project.artifactRootId,
              requestId: currentRequest,
              originalJobId: proof.record.job.id,
              jobSha256: owned.expectedJob,
              recordSha256: canonicalDigest(proof.record),
              stateSha256: canonicalDigest(proof.state),
              metadataSha256: initial.metadataSha256,
              stagesSha256: canonicalDigest(
                proof.state.stages.filter(
                  (s) => s.jobId === proof.record.job.id,
                ),
              ),
              identitySha256: plan.retained.identitySha256,
              policySha256: plan.policySha256,
              planSha256: plan.proofSha256,
              source: proof.proposal.binding.source,
              approval: proof.approved.approved,
              historicalEvidence: json.descriptor.artifact,
              reference: image.descriptor.artifact,
              recordedAt: new Date(work.policy.clock.now()).toISOString(),
              confirmation: REFERENCE_RECOVERY_CONFIRMATION,
            };
            const evidenceBytes = canonicalBytes(
              recoveryEvidence(binding, canonicalDigest),
            );
            const reservation: ReferenceRecoveryReservation = {
              binding,
              evidence: descriptor(evidenceBytes),
            };
            copies.push(evidenceBytes);
            const handoff = pin;
            const inventoryPreimage = proof.inspection.identitySha256;
            await closeStore();
            writer = true;
            files = await makeFiles(true);
            writerContext = await issue(recoveryId, [], true);
            const opts = options(files);
            if (!opts.referenceRecovery)
              throw new ApplicationError("FORBIDDEN");
            store = await LocalStore.open({
              ...opts,
              referenceRecovery: {
                ...opts.referenceRecovery,
                writer: {
                  metadataSha256: initial.metadataSha256,
                  controlSha256: canonicalDigest(initial.records),
                  schema: initial.schema,
                  beforeOpen: async () => {
                    await check();
                    await handoff.checkReleased();
                  },
                  check,
                },
                prepareBackup: async (filename) => {
                  if (!work.prepareReferenceBackup)
                    throw new ApplicationError("FORBIDDEN");
                  await work.prepareReferenceBackup(filename);
                },
                pinBackup: async (filename) => {
                  if (!work.pinReferenceBackup || !writerContext)
                    throw new ApplicationError("FORBIDDEN");
                  return work.pinReferenceBackup(filename, writerContext);
                },
                publishBackup: async (source, destination, proof) => {
                  if (!work.publishReferenceBackup || !writerContext)
                    throw new ApplicationError("FORBIDDEN");
                  return work.publishReferenceBackup(
                    source,
                    destination,
                    writerContext,
                    proof,
                  );
                },
              },
            });
            proof = await prove(owned.expectedJob, record, "admission");
            if (proof.inspection.identitySha256 !== inventoryPreimage)
              throw new ApplicationError("CONFLICT");
            const freshJson =
              proof.inspection.targets[proof.validated.evidenceIndex]?.bytes;
            const freshPng =
              proof.inspection.targets[1 - proof.validated.evidenceIndex]
                ?.bytes;
            if (!freshJson || !freshPng)
              throw new ApplicationError("ARTIFACT_INTEGRITY");
            const outputs = [
              Uint8Array.from(freshJson),
              Uint8Array.from(freshPng),
              evidenceBytes,
            ];
            copies.push(...outputs);
            let progress: ReferenceRecoveryRecord = unwrap(
              await store.reserveReferenceRecovery(reservation, writerContext),
            );
            // Retain logical verified facts, not native read pins that would block publication.
            await reader?.close();
            reader = undefined;
            files.closeRetainedProofReads();
            input.phase = "commit";
            for (const bytes of outputs) {
              await check();
              const staged = unwrap(
                await store.stageReferenceRecovery(
                  recoveryId,
                  referenceRecoveryHead(progress, canonicalDigest),
                  bytes,
                  writerContext,
                ),
              );
              progress = staged.record;
            }
            reason = "publication-uncertain";
            const committed = unwrap(
              await store.commitReferenceRecovery(
                recoveryId,
                referenceRecoveryHead(progress, canonicalDigest),
                writerContext,
              ),
            );
            committedReceiptSha256 = canonicalDigest(committed);
            const final = unwrap(
              await store.referenceRecoverySnapshot(writerContext),
            );
            record =
              final.records.find(
                (r) => r.reservation.binding.recoveryId === recoveryId,
              ) ?? null;
            if (!record) throw new ApplicationError("ARTIFACT_INTEGRITY");
            await closeReads();
            proof = await prove(owned.expectedJob, record, "inspection");
            resolved = await effective(record, proof);
          }
        }
        let conversion: NativeReferenceOfflineEnvelope["conversion"];
        if (owned.operation === "convert-reference") {
          if (
            !resolved ||
            !record ||
            resolved.receiptSha256 !== owned.expectedRecovery
          )
            throw new ApplicationError("CONFLICT");
          if (record.events.length === 9) {
            reason = "recovery-blocked";
            throw new ApplicationError("ACTION_REQUIRED");
          }
          let prepared = await prepareReferenceConversion(
            proof.proof,
            record,
            resolved,
            proof.verifiedCapture,
            proof.proposal,
          );
          copies.push(...prepared.outputs);
          let receipt = record.events[9]?.receipt;
          if (!receipt) {
            const handoff = pin;
            const inventoryPreimage = proof.inspection.identitySha256;
            await closeStore();
            writer = true;
            files = await makeFiles(true);
            writerContext = await issue(prepared.operationId, [], true);
            const opts = options(files);
            if (!opts.referenceRecovery)
              throw new ApplicationError("FORBIDDEN");
            store = await LocalStore.open({
              ...opts,
              referenceRecovery: {
                ...opts.referenceRecovery,
                writer: {
                  metadataSha256: initial.metadataSha256,
                  controlSha256: canonicalDigest(initial.records),
                  schema: initial.schema,
                  beforeOpen: async () => {
                    await check();
                    await handoff.checkReleased();
                  },
                  check,
                },
              },
            });
            proof = await prove(owned.expectedJob, record, "admission");
            if (proof.inspection.identitySha256 !== inventoryPreimage)
              throw new ApplicationError("CONFLICT");
            resolved = await effective(record, proof);
            prepared = await prepareReferenceConversion(
              proof.proof,
              record,
              resolved,
              proof.verifiedCapture,
              proof.proposal,
            );
            copies.push(...prepared.outputs);
            await reader?.close();
            reader = undefined;
            files.closeRetainedProofReads();
            input.phase = "commit";
            record = unwrap(
              await store.beginReferenceConversion(
                recoveryId,
                referenceRecoveryHead(record, canonicalDigest),
                prepared.outputs.map(descriptor),
                writerContext,
              ),
            );
            const staged = [];
            for (const bytes of prepared.outputs) {
              await check();
              const output = unwrap(
                await store.stageReferenceConversion(
                  recoveryId,
                  bytes,
                  writerContext,
                ),
              );
              staged.push(output);
              conversionStages.push(output);
            }
            receipt = unwrap(
              await store.commitReferenceConversion(
                recoveryId,
                staged,
                writerContext,
              ),
            );
          }
          assertReferenceConversionReceipt(prepared, receipt);
          input.phase = "inspection";
          for (const artifact of receipt.outputs) {
            const loaded = unwrap(
              await store.readVerified(
                ref(artifact),
                writerContext ?? proof.proof.context,
              ),
            );
            loaded.bytes.fill(0);
          }
          conversion = {
            operationId: prepared.operationId,
            receiptSha256: canonicalDigest(receipt),
            evidence: prepared.evidence,
            readiness: prepared.readiness,
          };
        }
        await check();
        result = {
          ...base,
          status: "complete",
          ...(owned.operation === "reference-recovery-apply-plan" ||
          owned.operation === "reference-recovery-inspect"
            ? { plan }
            : {}),
          ...(resolved && !conversionInspection
            ? {
                effectiveReference: resolved,
                receiptSha256: resolved.receiptSha256,
              }
            : {}),
          ...(conversion ? { conversion } : {}),
          ...(inspectedConversion ? { inspection: inspectedConversion } : {}),
        };
      } catch (error) {
        const code = safeError(error).code;
        failure = {
          code,
          message: committedReceiptSha256
            ? "An offline recovery receipt committed; final verification did not finish."
            : "Offline reference operation did not establish a verified result.",
          retryable: false,
          diagnosticIds: [],
        };
        result = {
          ...base,
          status: code === "CANCELLED" ? "cancelled" : "failed",
          reason:
            code === "INPUT_LIMIT"
              ? "input-limit"
              : code === "DEADLINE_EXCEEDED"
                ? "deadline-exceeded"
                : code === "CANCELLED"
                  ? "cancelled"
                  : reason,
          error: failure,
          ...(committedReceiptSha256 && work.isCurrent()
            ? { receiptSha256: committedReceiptSha256 }
            : {}),
        };
      } finally {
        for (const bytes of copies) bytes.fill(0);
        active = false;
      }
      await close();
      if (
        result.status === "complete" &&
        (suppliedSignal.aborted ||
          work.policy.clock.now() >= Date.parse(deadline))
      ) {
        result = {
          ...base,
          status: suppliedSignal.aborted ? "cancelled" : "failed",
          reason: suppliedSignal.aborted ? "cancelled" : "deadline-exceeded",
          ...(result.receiptSha256
            ? { receiptSha256: result.receiptSha256 }
            : {}),
          error: {
            code: suppliedSignal.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED",
            message:
              "Offline reference closure exceeded its invocation boundary; committed receipts are not undone.",
            retryable: false,
            diagnosticIds: [],
          },
        };
      }
      result.inputAccounting = input.snapshot();
      if (conversionInspection && result.status !== "complete")
        result.inspection = {
          verification: "conversion-readonly-v1",
          state: "blocked",
          detail: "verification-incomplete",
        };
      const validated = validateContract(
        "NativeReferenceOfflineEnvelope",
        result,
      );
      if (!validated.success || canonicalBytes(result).length > 8192)
        throw new ApplicationError("INTERNAL_ERROR");
      return validated.value;
    },
  };
}
