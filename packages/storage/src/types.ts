import type {
  ApprovalContext,
  Artifact,
  ArtifactReference,
  AuthorizationContext,
  CommitReceipt,
  ExpectedBase,
  FileSystemBoundary,
  OperationContext,
  ReviewEvent,
  Revision,
  StagedArtifact,
} from "@design-studio/contracts";

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

export interface StorageOptions {
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
  /** Trusted host provisioning must reject mapped drives/network mounts, unsafe roots and aliases. */
  attestLocalDatabase(
    path: string,
    scope: {
      projectId: string;
      artifactRootId: string;
      permissionScope: string;
    },
  ): Promise<void>;
  canonicalBytes(value: unknown): Uint8Array;
  verifyRevision(
    revision: Revision,
    context: OperationContext,
    evidence: { artifact: Artifact; bytes: Uint8Array }[],
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
    point: "before-commit" | "after-commit" | "migration-before-commit",
  ): void;
}

export interface RevisionCommit {
  branch: string;
  base: ExpectedBase | null;
  revision: Revision;
  outputs: StagedArtifact[];
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

export interface BackupMetadata {
  storageVersion: 2;
  projectId: string;
  artifacts: Artifact[];
  revisions: Revision[];
  heads: { designId: string; branch: string; revisionId: string }[];
  reviews: StoredReview[];
  receipts: CommitReceipt[];
  pins: RetentionPin[];
}

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
