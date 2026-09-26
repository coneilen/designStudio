import type {
  Artifact,
  ArtifactReference,
  NativeReferenceForkResultEnvelope,
} from "@design-studio/contracts";
import { parseContract, validateContract } from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  authorizeOperation,
  ProjectFileSystem,
  snapshotOperationContext,
} from "@design-studio/host";
import {
  acquireCaptureWork,
  type CaptureProject,
} from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { REFERENCE_LIMITS } from "../../figma-capture/dist/reference.js";
import { initializeImmutableSqlite } from "../../storage/dist/immutable-sqlite.js";
import { NativeCaptureCleanupRequired } from "./capture-runtime-internal.js";
import { ReferenceInput } from "./reference-input.js";
import { ref, same } from "./reference-proof.js";
import { ApplicationError, safeError, unwrap } from "./response.js";
export interface NativeReferenceForkResultInput {
  operation: "reference-fork-result";
  requestId: string;
  expectedReceipt: string;
}
export type ReferenceForkRole =
  | "design"
  | "resources"
  | "source-map"
  | "conversion-evidence"
  | "provenance"
  | "report"
  | "reference";
export interface ReferenceForkConsumer {
  role: ReferenceForkRole;
  reference: ArtifactReference;
  /** Borrowed, verified bytes: settle all work before return; zeroed immediately afterwards.
   * Delivery is provisional until execute resolves COMPLETE after final checks and closure. */
  consume(
    bytes: Uint8Array,
    artifact: Artifact,
    signal: AbortSignal,
  ): Promise<void>;
}
const deny = async (): Promise<never> => {
  throw new ApplicationError("FORBIDDEN");
};
export function openNativeReferenceForkResult(project: CaptureProject) {
  const work = acquireCaptureWork(project);
  let store: LocalStore | undefined;
  let files: ProjectFileSystem | undefined;
  let pin:
    | Awaited<ReturnType<NonNullable<typeof work.pinReferenceForkDatabase>>>
    | undefined;
  let active = false,
    consumed = false,
    closed = false;
  let failureResult: NativeReferenceForkResultEnvelope | undefined;
  const close = async () => {
    if (closed) return;
    if (active) throw new ApplicationError("INTERRUPTED");
    try {
      store?.close();
      store = undefined;
      await files?.closePreservingStages();
      files = undefined;
      pin?.close();
      pin = undefined;
      work.close();
      closed = true;
    } catch (error) {
      throw new NativeCaptureCleanupRequired(
        failureResult?.error?.code ?? "INTERRUPTED",
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
      input: NativeReferenceForkResultInput,
      signal: AbortSignal,
      consumer?: ReferenceForkConsumer,
    ): Promise<NativeReferenceForkResultEnvelope> {
      if (active || consumed || closed) throw new ApplicationError("FORBIDDEN");
      const owned = structuredClone(input);
      const selected = consumer
        ? {
            role: consumer.role,
            reference: structuredClone(consumer.reference),
            consume: consumer.consume,
          }
        : undefined;
      active = true;
      consumed = true;
      const meter = new ReferenceInput();
      const deadline = new Date(work.policy.clock.now() + 30000).toISOString();
      const base = {
        schemaVersion: "1.0" as const,
        operation: "reference-fork-result" as const,
        projectId: project.projectId,
        requestId: owned.requestId,
      };
      let result: unknown;
      let primary: NativeReferenceForkResultEnvelope["error"];
      const buffers: Uint8Array[] = [];
      const check = async () => {
        if (signal.aborted) throw new ApplicationError("CANCELLED");
        if (work.policy.clock.now() >= Date.parse(deadline))
          throw new ApplicationError("DEADLINE_EXCEEDED");
        await work.current();
        if (!work.referenceForkAuthority)
          throw new ApplicationError("FORBIDDEN");
        await work.referenceForkAuthority();
      };
      try {
        if (
          Object.keys(owned).sort().join(",") !==
            "expectedReceipt,operation,requestId" ||
          owned.operation !== "reference-fork-result" ||
          !validateContract("StableId", owned.requestId).success ||
          !validateContract("Sha256", owned.expectedReceipt).success ||
          (selected &&
            (!validateContract("ArtifactReference", selected.reference)
              .success ||
              ![
                "design",
                "resources",
                "source-map",
                "conversion-evidence",
                "provenance",
                "report",
                "reference",
              ].includes(selected.role)))
        )
          throw new ApplicationError("INVALID_INPUT");
        await check();
        if (!work.pinReferenceForkDatabase || !work.pinReferenceValidationEntry)
          throw new ApplicationError("FORBIDDEN");
        initializeImmutableSqlite(work.sqliteBinding);
        pin = await work.pinReferenceForkDatabase();
        const context = await work.policy.issueReferenceForkResult({
          jobId: `fork_reference_${canonicalDigest([project.projectId, owned.expectedReceipt])}`,
          requestId: owned.requestId,
          deadline,
          signal,
        });
        const authorize = async () => {
          await check();
          if (
            !work.policy.verify(context.authorization) ||
            context.authorization.egress !== "deny" ||
            context.authorization.grants.some((g) =>
              g.operations.includes("write"),
            )
          )
            throw new ApplicationError("FORBIDDEN");
        };
        const allowed = new Set<string>();
        files = await ProjectFileSystem.create({
          projectId: project.projectId,
          authority: work.policy.verify,
          budgetLimits: REFERENCE_LIMITS,
          reserveRead: (bytes) => meter.reserveRead(bytes),
          roots: [
            {
              id: project.artifactRootId,
              path: project.paths.artifacts,
              access: "read",
              managedBlobs: true,
              trustedExclusiveAccess: true,
            },
          ],
          recordedRead: {
            authorize: async (request) => {
              await authorize();
              if (
                request.artifactRootId !== project.artifactRootId ||
                !allowed.has(request.path)
              )
                throw new ApplicationError("FORBIDDEN");
            },
            pin: work.pinReferenceValidationEntry.bind(work),
          },
        });
        store = await LocalStore.open({
          access: "read-only",
          readonlySnapshot: pin,
          referenceForkRead: {
            expectedReceiptSha256: owned.expectedReceipt,
            authorize,
          },
          databasePath: project.paths.database,
          nativeBinding: work.sqliteBinding,
          projectId: project.projectId,
          artifactRootId: project.artifactRootId,
          permissionScope: work.permissionScope,
          canonicalBytes,
          snapshotOperationContext,
          fileSystem: files,
          attestLocalDatabase: work.attestDatabase.bind(work),
          authorize: async (_context, scope) => {
            await authorize();
            authorizeOperation(
              context,
              scope.resourceKind === "artifact"
                ? { ...scope, resourceId: project.artifactRootId }
                : scope,
              work.policy.verify,
            );
          },
          ensurePublicationDurable: deny,
          ensureDatabaseBackupDurable: deny,
          verifyRevision: deny,
          assessApproval: deny,
          authorizeRestore: deny,
          authorizeRetention: deny,
          canDiscardStage: deny,
          maintenance: { inventory: deny, removeBlob: deny },
        });
        const record = unwrap(await store.referenceForkResult(context));
        const db = store;
        const receipt = record.receipt;
        if (
          !receipt ||
          record.binding.policySha256 !==
            (await work.referenceForkAuthority?.())
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        for (const a of receipt.outputs) allowed.add(a.path);
        const read = async (reference: ArtifactReference) => {
          if (!receipt.outputs.some((a) => same(ref(a), reference)))
            throw new ApplicationError("ARTIFACT_INTEGRITY");
          const loaded = unwrap(await db.readVerified(reference, context));
          buffers.push(loaded.bytes);
          return loaded;
        };
        const originRead = await read({
          id: `sha256_${record.binding.originSha256}`,
          sha256: record.binding.originSha256,
        });
        const origin = parseContract(
          "ReferenceForkOrigin",
          new TextDecoder("utf8", { fatal: true }).decode(originRead.bytes),
          "json",
          { maxInputBytes: 65536 },
        );
        const manifestRead = await read({
          id: `sha256_${record.binding.resultSha256}`,
          sha256: record.binding.resultSha256,
        });
        const manifest = parseContract(
          "ReferenceForkResultManifest",
          new TextDecoder("utf8", { fatal: true }).decode(manifestRead.bytes),
          "json",
          { maxInputBytes: 65536 },
        );
        if (
          origin.destinationProjectId !== project.projectId ||
          origin.actorId !== work.actorId ||
          origin.sourceProjectId !== record.binding.sourceProjectId ||
          origin.operationId !== record.binding.operationId ||
          origin.sourceProjectId === project.projectId ||
          origin.policySha256 !== record.binding.policySha256 ||
          manifest.projectId !== project.projectId ||
          manifest.operationId !== record.binding.operationId ||
          !same(manifest.origin, ref(originRead.artifact)) ||
          record.binding.operationId !==
            `fork_reference_${canonicalDigest([project.projectId, origin.sourceProjectId, origin.sourceJobSha256, canonicalDigest(origin.recoveryReceipt)])}` ||
          new Set(manifest.artifacts.map((a) => a.role)).size !==
            manifest.artifacts.length ||
          ![
            "resources",
            "source-map",
            "conversion-evidence",
            "provenance",
            "report",
          ].every((role) => manifest.artifacts.some((a) => a.role === role))
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const named = manifest.artifacts;
        if (
          !named.some(
            (a) => a.role === "reference" && same(a.artifact, origin.reference),
          )
        )
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        for (const entry of named)
          if (!receipt.outputs.some((a) => same(ref(a), entry.artifact)))
            throw new ApplicationError("ARTIFACT_INTEGRITY");
        const data = new Map<string, Awaited<ReturnType<typeof read>>>();
        for (const a of receipt.outputs) data.set(a.sha256, await read(ref(a)));
        await pin.check();
        if (!same(record, unwrap(await store.referenceForkResult(context))))
          throw new ApplicationError("CONFLICT");
        if (selected) {
          const entry = named.find((a) => a.role === selected.role);
          if (!entry || !same(entry.artifact, selected.reference))
            throw new ApplicationError("FORBIDDEN");
          const loaded = data.get(entry.artifact.sha256);
          if (!loaded) throw new ApplicationError("ARTIFACT_INTEGRITY");
          await selected.consume(
            loaded.bytes,
            structuredClone(loaded.artifact),
            signal,
          );
          loaded.bytes.fill(0);
        }
        meter.phase = "inspection";
        for (const a of receipt.outputs) {
          const loaded = await read(ref(a));
          loaded.bytes.fill(0);
        }
        await check();
        await pin.check();
        if (!same(record, unwrap(await store.referenceForkResult(context))))
          throw new ApplicationError("CONFLICT");
        result = {
          ...base,
          status: "complete",
          inputAccounting: meter.snapshot(),
          conversion: {
            operationId: record.binding.operationId,
            origin: manifest.origin,
            receiptSha256: owned.expectedReceipt,
            outputs: receipt.outputs,
            artifacts: manifest.artifacts,
            readiness: manifest.readiness,
          },
        };
      } catch (error) {
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
        };
      } finally {
        for (const bytes of buffers) bytes.fill(0);
        active = false;
      }
      const fallback = validateContract("NativeReferenceForkResultEnvelope", {
        ...base,
        status: "failed",
        inputAccounting: meter.snapshot(),
        error: primary ?? {
          code: "INTERRUPTED",
          message: "Completed result finalization is incomplete.",
          retryable: false,
          diagnosticIds: [],
        },
      });
      if (fallback.success) failureResult = fallback.value;
      await close();
      if (
        !primary &&
        (signal.aborted || work.policy.clock.now() >= Date.parse(deadline))
      )
        result = {
          ...base,
          status: "failed",
          inputAccounting: meter.snapshot(),
          error: {
            code: signal.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED",
            message: "Result finalization exceeded its original invocation.",
            retryable: false,
            diagnosticIds: [],
          },
        };
      const parsed = validateContract(
        "NativeReferenceForkResultEnvelope",
        result,
      );
      if (!parsed.success || canonicalBytes(result).length > 8192)
        throw new ApplicationError("INVALID_SCHEMA");
      return parsed.value;
    },
  };
}
