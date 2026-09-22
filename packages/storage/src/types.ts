import type {
  ApprovalContext,
  Artifact,
  ArtifactReference,
  AuthorizationContext,
  CaptureRecoveryAuthorization,
  CommitReceipt,
  ExpectedBase,
  FileSystemBoundary,
  OperationContext,
  ReviewEvent,
  Revision,
  StagedArtifact,
} from "@design-studio/contracts";
import type {
  CaptureRecoveryEvidence,
  CaptureRecoveryState,
} from "./capture-recovery.js";
import type {
  JobStorageOptions,
  StoredJob,
  StoredJobResource,
  StoredJobStage,
} from "./job-types.js";

export interface StorageScope {
  projectId: string;
  resourceKind: AuthorizationContext["grants"][number]["resourceKind"];
  resourceId: string;
  operation: "read" | "write";
}

export interface StorageMaintenance {
  inventory(
    context: OperationContext,
    maxEntries: number,
  ): Promise<{ stagedIds: string[]; publishedArtifacts: Artifact[] }>;
  removeBlob(artifact: Artifact, context: OperationContext): Promise<void>;
}

export interface ApprovalAssessment {
  complete: boolean;
  blockingDiagnosticIds: string[];
  waiverEligibleDiagnosticIds: string[];
}

export interface LogicalArtifactBinding {
  reference: ArtifactReference;
  artifact: ArtifactReference;
}

export interface StoredArtifactBinding extends LogicalArtifactBinding {
  receiptId: string;
}

export interface StorageOptions {
  referenceInspection?: {
    authorize(context: OperationContext): Promise<void>;
  };
  captureRecovery?: {
    authorize(context: OperationContext): Promise<void>;
    verify(
      evidence: CaptureRecoveryEvidence,
      state: CaptureRecoveryState,
      context: OperationContext,
    ): Promise<void>;
    verifyIssuance(
      authorization: CaptureRecoveryAuthorization,
      state: CaptureRecoveryState,
      context: OperationContext,
    ): Promise<void>;
  };
  jobs?: JobStorageOptions;
  databasePath: string;
  nativeBinding: string;
  projectId: string;
  artifactRootId: string;
  permissionScope: string;
  /** Supply the host's branded snapshot helper when host callbacks preserve reservation identity. */
  snapshotOperationContext?(context: OperationContext): OperationContext;
  fileSystem: FileSystemBoundary;
  maintenance: StorageMaintenance;
  /** Must establish directory-entry durability, not only atomic visibility or file fsync. */
  ensurePublicationDurable(
    artifacts: Artifact[],
    context: OperationContext,
  ): Promise<void>;
  ensureDatabaseBackupDurable(path: string): Promise<void>;
  authorize(context: OperationContext, scope: StorageScope): Promise<void>;
  /** Attest trusted database provenance, exclusive scope ownership and local media; never adopt untrusted SQL files. */
  attestLocalDatabase(
    path: string,
    scope: {
      projectId: string;
      artifactRootId: string;
      permissionScope: string;
    },
  ): Promise<void>;
  canonicalBytes(value: unknown): Uint8Array;
  authorizeArtifactBinding?(
    binding: LogicalArtifactBinding,
    evidence: { artifact: Artifact; bytes: Uint8Array },
    context: OperationContext,
  ): Promise<void>;
  verifyRevision(
    revision: Revision,
    context: OperationContext,
    evidence: {
      reference: ArtifactReference;
      artifact: Artifact;
      bytes: Uint8Array;
    }[],
  ): Promise<void>;
  assessApproval(
    approval: ApprovalContext,
    context: OperationContext,
  ): Promise<ApprovalAssessment>;
  /** Authenticate backup provenance; a matching digest is insufficient to restore trusted approvals. */
  authorizeRestore(
    backup: ProjectBackup,
    context: OperationContext,
  ): Promise<void>;
  authorizeRetention(
    action: "pin" | "release" | "collect",
    pin: RetentionPin | null,
    context: OperationContext,
  ): Promise<void>;
  /** A trusted job registry must establish that a staged output is abandoned. Unknown means retain. */
  canDiscardStage(
    stagingId: string,
    context: OperationContext,
  ): Promise<boolean>;
  fault?(
    point:
      | "before-commit"
      | "after-commit"
      | "migration-before-commit"
      | "job-after-stage"
      | "job-after-artifacts"
      | "job-after-receipt"
      | "job-after-state"
      | "job-cancel-after-state"
      | "job-cancel-after-control",
  ): void;
}

export interface RevisionCommit {
  branch: string;
  base: ExpectedBase | null;
  revision: Revision;
  outputs: StagedArtifact[];
  referenceBindings?: LogicalArtifactBinding[];
}

export interface StoredReview {
  reference: ArtifactReference;
  event: ReviewEvent;
}

export interface RetentionPin {
  kind: "bundle" | "job" | "legal" | "cache";
  id: string;
  artifacts: ArtifactReference[];
}

export interface LegacyBackupMetadata {
  storageVersion: 2;
  projectId: string;
  artifacts: Artifact[];
  revisions: Revision[];
  heads: { designId: string; branch: string; revisionId: string }[];
  reviews: StoredReview[];
  receipts: CommitReceipt[];
  pins: RetentionPin[];
}

export interface JobBackupMetadata
  extends Omit<LegacyBackupMetadata, "storageVersion"> {
  storageVersion: 3;
  jobs: StoredJob[];
  jobResources: StoredJobResource[];
  jobStages: StoredJobStage[];
}

export interface BoundBackupMetadata
  extends Omit<JobBackupMetadata, "storageVersion"> {
  storageVersion: 4;
  artifactBindings: StoredArtifactBinding[];
}

export type BackupMetadata =
  | LegacyBackupMetadata
  | JobBackupMetadata
  | BoundBackupMetadata;

export interface ProjectBackup {
  metadata: BackupMetadata;
  sha256: string;
  blobs: { sha256: string; bytes: Uint8Array }[];
}

export interface RecoveryReport {
  stagedDiscarded: number;
  stagedRetained: string[];
  orphanPaths: string[];
  missingOrCorrupt: string[];
}

export type StorageCode =
  | "ACTION_REQUIRED"
  | "AUTHORIZATION_CHANGED"
  | "WRITER_BUSY"
  | "UNSUITABLE_FILESYSTEM"
  | "SCHEMA_INCOMPATIBLE"
  | "INTEGRITY"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "APPROVAL_INAPPLICABLE"
  | "LIMIT"
  | "CANCELLED"
  | "DEADLINE"
  | "IO_FAILURE";

export class StorageError extends Error {
  constructor(
    readonly code: StorageCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}
