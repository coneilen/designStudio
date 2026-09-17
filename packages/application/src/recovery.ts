import { randomUUID } from "node:crypto";
import type {
  AuthorizationContext,
  OperationContext,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import { authorizeOperation } from "@design-studio/host";
import type { RecoveryFacts } from "@design-studio/jobs";
import type { JobReconciliation, StoredJob } from "@design-studio/storage";
import type { FixturePolicy } from "./policy.js";
import { ApplicationError } from "./response.js";
import { PROJECT_ID } from "./routes.js";

type RecoveryRecord = Pick<StoredJob, "job" | "requestId" | "generation">;
interface RecoveryProof {
  identity: string;
  interruptedIdentity?: string;
  decisionDigest?: string;
}
export class RecoveryDecisions {
  private readonly proofs = new WeakMap<AuthorizationContext, RecoveryProof>();
  constructor(private readonly policy: FixturePolicy) {}
  private identity(record: RecoveryRecord) {
    return canonicalDigest([
      record.job.projectId,
      record.job.actorId,
      record.job.id,
      record.requestId,
      record.generation,
      record.job.lease?.id ?? null,
    ]);
  }
  register(record: RecoveryRecord, context: OperationContext) {
    this.checkContext(record, context);
    this.proofs.set(context.authorization, { identity: this.identity(record) });
  }
  private checkContext(record: RecoveryRecord, context: OperationContext) {
    if (
      !this.policy.verify(context.authorization) ||
      context.projectId !== PROJECT_ID ||
      record.job.projectId !== PROJECT_ID ||
      record.job.actorId !== this.policy.actorId ||
      context.authorization.actorId !== record.job.actorId ||
      context.jobId !== record.job.id ||
      context.requestId !== record.requestId ||
      context.clock !== this.policy.clock ||
      context.signal.aborted ||
      context.clock.now() >= Date.parse(context.deadline)
    )
      throw new ApplicationError("FORBIDDEN", 403);
    authorizeOperation(
      context,
      {
        projectId: PROJECT_ID,
        resourceKind: "job",
        resourceId: record.job.id,
        operation: "write",
      },
      this.policy.verify,
    );
  }
  private async check(record: RecoveryRecord, context: OperationContext) {
    await this.policy.check();
    this.checkContext(record, context);
    const proof = this.proofs.get(context.authorization);
    if (
      !proof ||
      (proof.identity !== this.identity(record) &&
        !(
          record.job.status === "interrupted" &&
          proof.interruptedIdentity === this.identity(record)
        ))
    )
      throw new ApplicationError("FORBIDDEN", 403);
    return proof;
  }
  async decide(
    record: RecoveryRecord,
    facts: Readonly<RecoveryFacts>,
    context: OperationContext,
  ): Promise<JobReconciliation> {
    const proof = await this.check(record, context);
    if (facts.stoppedLeaseId !== (record.job.lease?.id ?? null))
      throw new ApplicationError("CONFLICT", 409);
    const evidence: JobReconciliation = facts.stopConfirmed
      ? {
          kind: "resolved",
          decision:
            facts.reason === "cancel"
              ? "cancelled"
              : facts.reason === "authority"
                ? "waiting-for-user"
                : "failed",
          evidenceRef: randomUUID(),
          stoppedLeaseId: facts.stoppedLeaseId,
          effects: [],
          abandonedStageIds: [],
          error: structuredClone(facts.error),
        }
      : { kind: "interrupt", error: structuredClone(facts.error) };
    proof.decisionDigest = canonicalDigest(evidence);
    return evidence;
  }
  async authorize(
    record: RecoveryRecord,
    evidence: JobReconciliation,
    context: OperationContext,
  ): Promise<void> {
    const proof = await this.check(record, context);
    // Quarantine is conservative: no retry, output adoption, resource release or deletion follows from it.
    if (evidence.kind === "interrupt") {
      if (!Number.isSafeInteger(record.generation + 1))
        throw new ApplicationError("FORBIDDEN", 403);
      proof.interruptedIdentity = this.identity({
        ...record,
        generation: record.generation + 1,
      });
      return;
    }
    if (
      evidence.kind !== "resolved" ||
      proof.decisionDigest !== canonicalDigest(evidence)
    )
      throw new ApplicationError("FORBIDDEN", 403);
  }
}
