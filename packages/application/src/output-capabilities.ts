import {
  type AuthorizationContext,
  type FileSystemBoundary,
  type OperationContext,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { type Authority, authorizeOperation } from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import type { StorageScope } from "@design-studio/storage";
import { ApplicationError } from "./response.js";
import { PROJECT_ID } from "./routes.js";

interface Attempt {
  execution: JobExecution;
  proof: AuthorizationContext;
  jobId: string;
  requestId: string;
  actorId: string;
  attempt: number;
  generation: number;
  leaseId: string;
  ownerId: string;
  resourcesDigest: string;
  stageAttempts: number;
  stages: Map<string, StagedArtifact>;
}
// Private application ownership, never an imported artifact, client grant or persistence format.
export class OutputCapabilities {
  private readonly attempts = new Map<AuthorizationContext, Attempt>();
  constructor(
    private readonly rootId: string,
    private readonly verify: Authority,
  ) {}
  private live(attempt: Attempt, context: OperationContext): boolean {
    const record = attempt.execution.record;
    return (
      this.verify(context.authorization) &&
      context.authorization === attempt.proof &&
      context.projectId === PROJECT_ID &&
      context.authorization.actorId === attempt.actorId &&
      context.requestId === attempt.requestId &&
      context.jobId === attempt.jobId &&
      context.clock === attempt.execution.context.clock &&
      context.signal === attempt.execution.context.signal &&
      !context.signal.aborted &&
      context.clock.now() < Date.parse(context.deadline) &&
      context.clock.now() < Date.parse(record.job.deadline) &&
      record.job.projectId === PROJECT_ID &&
      record.job.id === attempt.jobId &&
      record.requestId === attempt.requestId &&
      record.job.actorId === attempt.actorId &&
      record.job.attempt === attempt.attempt &&
      record.generation === attempt.generation &&
      canonicalDigest(record.resources) === attempt.resourcesDigest &&
      record.job.lease?.id === attempt.leaseId &&
      record.job.lease.ownerId === attempt.ownerId &&
      context.clock.now() < Date.parse(record.job.lease.expiresAt) &&
      record.job.lease.fencingToken === attempt.generation &&
      record.job.status === "running"
    );
  }
  wrap(execution: JobExecution): Pick<FileSystemBoundary, "stage"> {
    const stage = execution.filesystem.stage.bind(execution.filesystem);
    const record = execution.record;
    const context = execution.context;
    this.dropJob(record.job.id);
    if (
      !record.job.lease ||
      record.job.operation !== "render" ||
      this.attempts.size >= 4
    )
      throw new ApplicationError("FORBIDDEN", 403);
    const attempt: Attempt = {
      execution,
      proof: context.authorization,
      jobId: record.job.id,
      requestId: record.requestId,
      actorId: record.job.actorId,
      attempt: record.job.attempt,
      generation: record.generation,
      leaseId: record.job.lease.id,
      ownerId: record.job.lease.ownerId,
      resourcesDigest: canonicalDigest(record.resources),
      stageAttempts: 0,
      stages: new Map(),
    };
    if (!this.live(attempt, context))
      throw new ApplicationError("FORBIDDEN", 403);
    this.attempts.set(context.authorization, attempt);
    return {
      stage: async (request, input, ctx) => {
        if (
          request.artifactRootId !== this.rootId ||
          ctx !== context ||
          this.attempts.get(context.authorization) !== attempt ||
          !this.live(attempt, ctx) ||
          !(input instanceof Uint8Array) ||
          input.buffer instanceof SharedArrayBuffer ||
          input.byteLength > ctx.budget.maxInputBytes ||
          attempt.stageAttempts >= 6
        )
          throw new ApplicationError("FORBIDDEN", 403);
        const bytes = input.slice();
        const digest = hashBytes(bytes);
        const target = { ...request };
        if (target.path !== `blobs/${digest}`)
          throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
        authorizeOperation(
          ctx,
          {
            projectId: PROJECT_ID,
            resourceKind: "artifact",
            resourceId: this.rootId,
            operation: "write",
          },
          this.verify,
        );
        attempt.stageAttempts++;
        const outcome = await stage(target, bytes, ctx);
        if (outcome.status === "complete") {
          const staged = structuredClone(outcome.value);
          if (
            this.attempts.get(context.authorization) !== attempt ||
            !this.live(attempt, ctx) ||
            !validateContract("Artifact", staged.artifact).success ||
            !validateContract("StableId", staged.stagingId).success ||
            staged.artifact.id !== `sha256_${digest}` ||
            staged.artifact.sha256 !== digest ||
            staged.artifact.path !== target.path ||
            staged.artifact.byteLength !== bytes.length ||
            staged.artifact.mediaType !== "application/octet-stream"
          )
            throw new ApplicationError("FORBIDDEN", 403);
          attempt.stages.set(staged.artifact.id, staged);
        }
        return outcome;
      },
    };
  }
  authorize(context: OperationContext, scope: StorageScope): boolean {
    if (
      scope.projectId !== PROJECT_ID ||
      scope.resourceKind !== "artifact" ||
      scope.operation !== "write"
    )
      return false;
    const attempt = this.attempts.get(context.authorization);
    if (
      !attempt ||
      !this.live(attempt, context) ||
      !attempt.stages.has(scope.resourceId)
    )
      return false;
    authorizeOperation(
      context,
      {
        projectId: PROJECT_ID,
        resourceKind: "artifact",
        resourceId: this.rootId,
        operation: "write",
      },
      this.verify,
    );
    return true;
  }
  dropJob(jobId: string) {
    for (const [proof, attempt] of this.attempts)
      if (attempt.jobId === jobId) this.attempts.delete(proof);
  }
  clear() {
    this.attempts.clear();
  }
}
