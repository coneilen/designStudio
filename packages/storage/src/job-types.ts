import type {
  Artifact,
  ArtifactReference,
  Budget,
  Clock,
  CommitReceipt,
  ContractError,
  Job,
  OperationContext,
  Outcome,
  StagedArtifact,
} from "@design-studio/contracts";
import type { LogicalArtifactBinding, RevisionCommit } from "./types.js";

export interface JobSubmission {
  id: string;
  operation: Job["operation"];
  input: ArtifactReference;
  resources: Job["resources"];
  inputRevision?: ArtifactReference;
  handlerId: string;
  handlerVersion: string;
  authorityRef: string;
  resourceKeys: string[];
  deadline: string;
  budget: Budget;
}

export interface JobExpected {
  state: Job["status"];
  rowVersion: number;
}

export interface JobReservation {
  key: string;
  generation: number;
}

export interface JobWorkerExpected extends JobExpected {
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  resources: JobReservation[];
}

export interface JobUsage {
  inputBytes: number;
  outputBytes: number;
  externalCalls: number;
  modelTokens: number;
  costMicros: number;
}

export interface JobEffect {
  id: string;
  reserved: JobUsage;
  actual?: JobUsage;
  state: "reserved" | "settled" | "no-effect" | "unknown";
}

export interface StoredJob {
  submission: JobSubmission;
  job: Job;
  requestId: string;
  handlerId: string;
  handlerVersion: string;
  authorityRef: string;
  inputRevision?: ArtifactReference;
  resourceKeys: string[];
  rowVersion: number;
  generation: number;
  resources: JobReservation[];
  /** Imported lease evidence, not an execution admitted by this destination store. */
  restoredLease?: true;
  cancelControls?: JobCancelReceipt[];
  createdAt: string;
  updatedAt: string;
  progressSequence: number;
  lastProgressAt: string | null;
  usage: JobUsage;
  effects: JobEffect[];
  finalOutputSha256?: string;
}

export interface StoredJobResource {
  key: string;
  generation: number;
  state: "released" | "held" | "quarantined";
  jobId: string | null;
  leaseId: string | null;
  fencingToken: number | null;
}

export interface StoredJobStage {
  stagingId: string;
  artifactRootId: string;
  staged: StagedArtifact;
  jobId: string;
  requestId: string;
  attempt: number;
  fencingToken: number;
  leaseId: string;
  hostInstanceId: string;
  disposition: "retained" | "recovery-needed" | "authorized-abandoned";
}

export type JobCommand =
  | { kind: "progress"; sequence: number; progress: number }
  | { kind: "reserve-usage"; id: string; usage: JobUsage }
  | {
      kind: "settle-usage";
      id: string;
      result: "settled";
      actual: JobUsage;
    }
  | { kind: "settle-usage"; id: string; result: "no-effect" | "unknown" }
  | {
      kind: "wait" | "fail" | "interrupt";
      error: ContractError;
    }
  | { kind: "retry"; error: ContractError; nextEligibleAttempt: string }
  | { kind: "acknowledge-cancel" };

export interface JobCompletion {
  referenceBindings?: LogicalArtifactBinding[];
  outputs: StagedArtifact[];
  outputState: NonNullable<Job["outputState"]>;
  comparisonVerdict?: Job["comparisonVerdict"];
  sourceStatus?: Job["sourceStatus"];
  diagnosticIds: string[];
  revision?: Omit<RevisionCommit, "outputs" | "referenceBindings">;
}

export type JobReconciliation =
  | { kind: "abandon-stages"; evidenceRef: string; abandonedStageIds: string[] }
  | { kind: "interrupt"; error: ContractError }
  | {
      kind: "resolved";
      decision: "queued" | "cancelled" | "failed" | "waiting-for-user";
      evidenceRef: string;
      stoppedLeaseId: string | null;
      effects: {
        id: string;
        result: "no-effect" | "settled";
        actual?: JobUsage;
      }[];
      abandonedStageIds: string[];
      error?: ContractError;
    };

export interface JobScan {
  states: Job["status"][];
  limit: number;
  cursor?: { createdAt: string; id: string };
  dueBefore?: string;
}

export interface JobPage {
  records: StoredJob[];
  nextCursor: JobScan["cursor"] | null;
}

export interface JobDiscoveryQuery {
  jobId?: string;
  states?: Job["status"][];
  limit: number;
  cursor?: { createdAt: string; id: string };
}

export interface JobDiscoveryDescriptor {
  jobId: string;
  projectId: string;
  actorId: string;
  requestId: string;
  operation: Job["operation"];
  status: Job["status"];
  rowVersion: number;
  input: ArtifactReference;
  resources: Job["resources"];
  inputRevision?: ArtifactReference & { designId: string };
  handlerId: string;
  handlerVersion: string;
  authorityRef: string;
  physicalInputs: LogicalArtifactBinding[];
  outputs: ArtifactReference[];
}

export interface JobDiscoveryPage {
  descriptors: JobDiscoveryDescriptor[];
  nextCursor: JobDiscoveryQuery["cursor"] | null;
}

export interface JobStageResult {
  record: StoredJob;
  staged: StagedArtifact;
}

export interface JobCommitResult {
  record: StoredJob;
  receipt: CommitReceipt;
}

export interface JobCancelReceipt {
  version: 1;
  operation: "job-cancel";
  projectId: string;
  actorId: string;
  key: string;
  jobId: string;
  expectedVersion: number;
  payloadSha256: string;
  resultVersion: number;
  resultStatus: Job["status"];
  recordedAt: string;
}

export interface JobCancelResult {
  record: StoredJob;
  control: JobCancelReceipt;
}

export interface JobRepository {
  discoverOwned(
    query: JobDiscoveryQuery,
    context: OperationContext,
  ): Promise<Outcome<JobDiscoveryPage>>;
  create(
    input: JobSubmission,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  get(id: string, context: OperationContext): Promise<Outcome<StoredJob>>;
  getStages(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<StoredJobStage[]>>;
  scan(query: JobScan, context: OperationContext): Promise<Outcome<JobPage>>;
  claim(
    id: string,
    expected: JobExpected,
    ownerId: string,
    durationMs: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  heartbeat(
    id: string,
    expected: JobWorkerExpected,
    extensionMs: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  update(
    id: string,
    expected: JobWorkerExpected,
    command: JobCommand,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  requestCancel(
    id: string,
    expectedVersion: number,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  cancelWithReceipt(
    id: string,
    expectedVersion: number,
    context: OperationContext,
  ): Promise<Outcome<JobCancelResult>>;
  stage(
    id: string,
    expected: JobWorkerExpected,
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<JobStageResult>>;
  commitJob(
    id: string,
    expected: JobWorkerExpected,
    completion: JobCompletion,
    context: OperationContext,
  ): Promise<Outcome<JobCommitResult>>;
  getJobReceipt(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt | null>>;
  reconcile(
    id: string,
    expectedVersion: number,
    evidence: JobReconciliation,
    context: OperationContext,
  ): Promise<Outcome<StoredJob>>;
  canDiscardStage(
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<boolean>>;
}

/** Composition authority only; never populate from a submitted payload. */
export interface JobStorageOptions {
  discovery?: {
    authorizeOwner(
      context: OperationContext,
      scope: {
        projectId: string;
        artifactRootId: string;
        permissionScope: string;
      },
    ): Promise<void>;
  };
  clock: Clock;
  maxWorkers?: number;
  limits?: Budget;
  verifyCompletion(
    record: StoredJob,
    completion: JobCompletion,
    evidence: { artifact: Artifact; bytes: Uint8Array }[],
    context: OperationContext,
  ): Promise<void>;
  authorizeRecovery(
    record: StoredJob,
    evidence: JobReconciliation,
    context: OperationContext,
  ): Promise<void>;
}
