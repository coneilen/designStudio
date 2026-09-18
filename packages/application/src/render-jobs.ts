import {
  type OperationContext,
  type RenderRequest,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import {
  authorizeOperation,
  snapshotOperationContext,
} from "@design-studio/host";
import type { JobExecution, TrustedJobHandler } from "@design-studio/jobs";
import {
  renderStaged,
  type StagedRender,
  type StagedRendererOptions,
} from "@design-studio/renderer";
import type { JobStorageOptions, StoredJob } from "@design-studio/storage";
import { ApplicationError } from "./response.js";

export function createRenderJobs(dependencies: {
  stageAdapter?(execution: JobExecution): JobExecution["filesystem"];
  observePreparation?(preparation: Readonly<StagedRender>): void;
  loadRequest(
    record: StoredJob,
    context: OperationContext,
    mode: RenderRequest["mode"],
  ): Promise<RenderRequest>;
  options: Omit<StagedRendererOptions, "filesystem">;
}) {
  const preparations = new Map<
    string,
    { record: StoredJob; prepared: StagedRender; context: OperationContext }
  >();
  const loadRequest = dependencies.loadRequest.bind(dependencies);
  const stageAdapter = dependencies.stageAdapter?.bind(dependencies);
  const observePreparation =
    dependencies.observePreparation?.bind(dependencies);
  const options = { ...dependencies.options };
  function key(record: StoredJob) {
    return `${record.job.id}:${record.generation}`;
  }
  const handlers: TrustedJobHandler[] = (["strict", "inspection"] as const).map(
    (mode) => ({
      id: `fixture-render-${mode}`,
      version: "1.0.0",
      operation: "render",
      async run(execution: JobExecution) {
        preparations.delete(key(execution.record));
        const request = await loadRequest(
          execution.record,
          execution.context,
          mode,
        );
        const prepared = await renderStaged(request, execution.context, {
          ...options,
          filesystem: stageAdapter
            ? stageAdapter(execution)
            : execution.filesystem,
        });
        observePreparation?.(structuredClone(prepared));
        if (
          (prepared.outcome.status !== "complete" &&
            prepared.outcome.status !== "partial") ||
          prepared.stageFailure ||
          prepared.recoveryRequired ||
          prepared.staged.length !== 6 ||
          !prepared.evidence ||
          prepared.cleanup?.status !== "complete" ||
          !prepared.cleanup.value.workerExitObserved ||
          !prepared.cleanup.value.jobEmptyObserved
        ) {
          const code =
            prepared.outcome.status === "complete"
              ? "INTERRUPTED"
              : prepared.outcome.error.code;
          return {
            kind:
              prepared.staged.length === 0 &&
              !prepared.recoveryRequired &&
              (prepared.cleanup?.status === "complete" ||
                (!prepared.cleanup &&
                  [
                    "TOOL_MISSING",
                    "PROVIDER_UNAVAILABLE",
                    "UNSUPPORTED_HOST",
                  ].includes(code)))
                ? "fail"
                : "interrupt",
            error: { code, message: code, retryable: false, diagnosticIds: [] },
          };
        }
        preparations.set(key(execution.record), {
          record: structuredClone(execution.record),
          prepared: structuredClone(prepared),
          context: snapshotOperationContext(execution.context),
        });
        return {
          kind: "complete",
          completion: {
            outputs: prepared.staged,
            outputState:
              prepared.outcome.value.diagnostics.readiness === "blocked"
                ? "partial-inspection"
                : "complete",
            diagnosticIds: prepared.outcome.value.diagnostics.diagnostics.map(
              (diagnostic) => diagnostic.id,
            ),
          },
        };
      },
    }),
  );
  const verifyCompletion: JobStorageOptions["verifyCompletion"] = async (
    record,
    completion,
    evidence,
    context,
  ) => {
    const known = preparations.get(key(record));
    if (
      !known?.prepared.evidence ||
      context.authorization !== known.context.authorization ||
      context.signal !== known.context.signal ||
      context.clock !== known.context.clock ||
      context.projectId !== known.context.projectId ||
      context.signal.aborted ||
      context.clock.now() >= Date.parse(context.deadline) ||
      record.generation !== known.record.generation ||
      record.job.attempt !== known.record.job.attempt ||
      record.job.lease?.id !== known.record.job.lease?.id ||
      record.job.status !== "running" ||
      record.requestId !== known.record.requestId ||
      record.job.actorId !== context.authorization.actorId ||
      context.requestId !== record.requestId ||
      context.jobId !== record.job.id ||
      record.handlerVersion !== "1.0.0" ||
      !handlers.some((handler) => handler.id === record.handlerId)
    )
      throw new ApplicationError("FORBIDDEN", 403);
    authorizeOperation(
      context,
      {
        projectId: options.projectId,
        resourceKind: "artifact",
        resourceId: options.artifactRootId,
        operation: "write",
      },
      options.authority,
    );
    const prepared = known.prepared;
    if (
      prepared.outcome.status !== "complete" &&
      prepared.outcome.status !== "partial"
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    if (
      canonicalDigest(completion.outputs) !==
        canonicalDigest(prepared.staged) ||
      completion.outputs.length !== 6 ||
      evidence.length !== 6 ||
      completion.revision !== undefined ||
      completion.referenceBindings !== undefined ||
      completion.sourceStatus !== undefined ||
      completion.comparisonVerdict !== undefined
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    for (let index = 0; index < evidence.length; index++) {
      const actual = evidence[index];
      const expected = prepared.staged[index]?.artifact;
      if (
        !actual ||
        !expected ||
        canonicalDigest(actual.artifact) !== canonicalDigest(expected) ||
        hashBytes(actual.bytes) !== expected.sha256 ||
        actual.bytes.length !== expected.byteLength
      )
        throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    }
    if (!validateContract("RenderResult", prepared.outcome.value).success)
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    const expectedState =
      prepared.outcome.value.diagnostics.readiness === "blocked"
        ? "partial-inspection"
        : "complete";
    if (
      completion.outputState !== expectedState ||
      canonicalDigest(completion.diagnosticIds) !==
        canonicalDigest(
          prepared.outcome.value.diagnostics.diagnostics.map((d) => d.id),
        )
    )
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
  };
  return {
    handlers,
    verifyCompletion,
    release(record: StoredJob) {
      preparations.delete(key(record));
    },
    releaseJob(jobId: string) {
      for (const name of preparations.keys())
        if (name.startsWith(`${jobId}:`)) preparations.delete(name);
    },
  };
}
