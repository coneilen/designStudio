import type {
  Clock,
  ContractError,
  FileSystemBoundary,
  Job,
  OperationContext,
  Outcome,
  StagedArtifact,
} from "@design-studio/contracts";
import type { Authority } from "@design-studio/host";
import type {
  JobCompletion,
  JobReconciliation,
  JobRepository,
  JobUsage,
  StoredJob,
} from "@design-studio/storage";

export interface VersionedJob {
  job: Job;
  rowVersion: number;
}
export interface RecoveryView extends VersionedJob {
  stages: StagedArtifact[];
  recoveryRequired: boolean;
}
export interface ExecutionAuthority {
  verify: Authority;
  observe(signal: AbortSignal): Promise<OperationContext>;
  issue(
    record: Readonly<StoredJob>,
    signal: AbortSignal,
  ): Promise<OperationContext>;
}
export interface RecoveryFacts {
  reason:
    | "authority"
    | "deadline"
    | "cancel"
    | "lease-lost"
    | "handler-failed"
    | "stopped";
  stoppedLeaseId: string | null;
  stopConfirmed: boolean;
  error: ContractError;
}
export interface RecoveryAuthority {
  issue(
    record: Readonly<StoredJob>,
    signal: AbortSignal,
  ): Promise<OperationContext>;
  decide(
    record: Readonly<StoredJob>,
    facts: Readonly<RecoveryFacts>,
    context: OperationContext,
  ): Promise<JobReconciliation>;
}
export type HandlerResult =
  | { kind: "complete"; completion: JobCompletion }
  | { kind: "wait" | "fail" | "interrupt"; error: ContractError }
  | { kind: "retry"; error: ContractError; retryAfter?: string };

export type StageFailure = Exclude<
  Outcome<StagedArtifact>,
  { status: "complete" }
>;

export interface JobExecution {
  readonly context: OperationContext;
  readonly record: StoredJob;
  readonly stageFailure?: StageFailure | undefined;
  checkpoint(): Promise<void>;
  stage(bytes: Uint8Array): Promise<Outcome<StagedArtifact>>;
  progress(value: number): Promise<void>;
  reserve(id: string, usage: JobUsage): Promise<void>;
  settle(id: string, result: "no-effect" | "unknown" | JobUsage): Promise<void>;
  readonly filesystem: Pick<FileSystemBoundary, "stage">;
}
export interface TrustedJobHandler {
  readonly id: string;
  readonly version: string;
  readonly operation: Job["operation"];
  run(execution: JobExecution): Promise<HandlerResult>;
}
export interface JobEvent {
  kind: "claimed" | "settled" | "fault";
  jobId?: string;
  requestId?: string;
  status?: Job["status"];
  code?: ContractError["code"];
  at: number;
  attempt?: number;
  elapsedMs?: number;
  usage?: Readonly<JobUsage>;
}
export interface JobServiceOptions {
  projectId: string;
  repository: JobRepository;
  clock: Clock;
  executionAuthority: ExecutionAuthority;
  recoveryAuthority: RecoveryAuthority;
  handlers: readonly TrustedJobHandler[];
  artifactRootId: string;
  ownerId: string;
  maxWorkers?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  backoffMs?: number;
  authorityTimeoutMs?: number;
  onEvent?(event: Readonly<JobEvent>): void;
}
export interface SchedulerReport {
  claimed: string[];
  active: number;
  scanned: number;
}
