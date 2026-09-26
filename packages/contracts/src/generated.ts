/* Generated from schemas/foundation.schema.json. Do not edit. */

/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SchemaVersion".
 */
export type SchemaVersion = "1.0";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "StableId".
 */
export type StableId = string;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Sha256".
 */
export type Sha256 = string;
/**
 * Portable bundle-relative slash path, not a host filesystem path. No drives, traversal, empty segments, percent escapes, ADS or Windows reserved basenames. Host confinement/symlink checks are F04.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RelativePath".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Operation".
 */
export type Operation =
  | "inspect"
  | "resolve"
  | "render"
  | "handoff"
  | "editable-export"
  | "implement"
  | "capture"
  | "reference-download"
  | "compare"
  | "read"
  | "write"
  | "execute"
  | "credential-use"
  | "model-egress";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceConversionInspection".
 */
export type ReferenceConversionInspection = {
  [k: string]: unknown;
} & {
  verification: "conversion-readonly-v1";
  state: "incomplete" | "committed" | "blocked";
  detail?: "no-conversion-intent-observed" | "conversion-intent-without-committed-receipt" | "verification-incomplete";
  proof?: ReferenceConversionInspectionProof;
  diagnostic?: {
    stage: ReferenceRecoveryPlanReason;
    inventoryFailure?: RetainedInventoryFailure;
    publicationCheck?: RetainedPublicationCheck;
  };
  conversion?: {
    operationId: StableId;
    receiptSha256: Sha256;
    evidence: ArtifactReference;
    readiness: "blocked" | "needs-review";
  };
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryPlanReason".
 */
export type ReferenceRecoveryPlanReason =
  | "invalid-input"
  | "authority-denied"
  | "ineligible-job"
  | "job-changed"
  | "source-metadata-invalid"
  | "source-proof-invalid"
  | "inventory-invalid"
  | "evidence-invalid"
  | "png-invalid"
  | "known-pair-native-read-blocked"
  | "state-changed"
  | "input-limit"
  | "cancelled"
  | "deadline-exceeded"
  | "cleanup-incomplete";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RetainedInventoryFailure".
 */
export type RetainedInventoryFailure = {
  [k: string]: unknown;
} & {
  check:
    | "descriptor"
    | "missing-recorded-entry"
    | "publication-shape"
    | "committed-size"
    | "proof-native-identity"
    | "proof-stat"
    | "proof-membership"
    | "native-read-admission"
    | "body-read"
    | "body-hash"
    | "inventory-recheck"
    | "native-identity-recheck"
    | "scan-blob-classification"
    | "scan-stage-classification"
    | "scan-root-entry-classification";
  category: "original-proof" | "history-stage" | "retained-target" | "committed-inventory" | "namespace";
  detail?:
    | "missing-stage-or-entry"
    | "unproven-history-coexistence"
    | "distinct-target-copies"
    | "link-count-or-shared-identity"
    | "recorded-length-mismatch"
    | "native-identity-unavailable"
    | "native-identity-not-distinct";
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RetainedPublicationCheck".
 */
export type RetainedPublicationCheck =
  "pending-stages-without-capture-recovery-binding" | "pending-stage-provenance-mismatch";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NativeReferenceOfflineEnvelope".
 */
export type NativeReferenceOfflineEnvelope = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  operation:
    | "reference-recovery-apply-plan"
    | "reference-recovery-apply"
    | "reference-recovery-inspect"
    | "convert-reference"
    | "reference-conversion-inspect";
  projectId: StableId;
  requestId: StableId;
  status: "complete" | "failed" | "cancelled" | "interrupted";
  plan?: OfflineReferencePlan;
  effectiveReference?: EffectiveReference;
  receiptSha256?: Sha256;
  inspection?: ReferenceConversionInspection;
  conversion?: {
    operationId: StableId;
    receiptSha256: Sha256;
    evidence: ArtifactReference;
    readiness: "blocked" | "needs-review";
  };
  reason?:
    | "invalid-input"
    | "authority-denied"
    | "database-state"
    | "proof-changed"
    | "ineligible"
    | "recovery-blocked"
    | "publication-uncertain"
    | "integrity"
    | "input-limit"
    | "deadline-exceeded"
    | "cancelled"
    | "cleanup-required";
  inputAccounting?: ReferenceInputAccounting;
  error?: ContractError;
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INPUT_LIMIT"
  | "RASTER_LIMIT"
  | "NODE_LIMIT"
  | "DEPTH_LIMIT"
  | "ASSET_LIMIT"
  | "UNKNOWN_PROPERTY"
  | "INVALID_LAYOUT"
  | "DUPLICATE_NODE_ID"
  | "DEPENDENCY_CYCLE"
  | "RESOURCE_UNRESOLVED"
  | "TOKEN_TYPE_MISMATCH"
  | "TOKEN_MODE_MISSING"
  | "COMPONENT_PROPERTY_INVALID"
  | "COMPONENT_SLOT_INVALID"
  | "MAPPING_STALE"
  | "BEHAVIOR_UNRESOLVED"
  | "UNSUPPORTED_FEATURE"
  | "FONT_MISSING"
  | "FONT_FALLBACK"
  | "LICENSE_UNVERIFIED"
  | "ASSET_INVALID"
  | "ARTIFACT_INTEGRITY"
  | "PATH_FORBIDDEN"
  | "NODE_SELECTION_REQUIRED"
  | "FIGMA_NODE_NOT_FOUND"
  | "FIGMA_ACCESS_DENIED"
  | "RATE_LIMITED"
  | "HISTORICAL_ASSET_UNAVAILABLE"
  | "SOURCE_CHANGED_DURING_CAPTURE"
  | "SOURCE_BINDING_UNVERIFIED"
  | "SOURCE_INCOMPLETE"
  | "PLUGIN_UNAVAILABLE"
  | "TRANSPORT_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ORIGIN_FORBIDDEN"
  | "CSRF_INVALID"
  | "EGRESS_DENIED"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "APPROVAL_REQUIRED"
  | "ACTION_REQUIRED"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "LEASE_LOST"
  | "INTERRUPTED"
  | "OUTPUT_UNCERTAIN"
  | "PROVIDER_UNAVAILABLE"
  | "TOOL_MISSING"
  | "TOOL_VERSION_UNSUPPORTED"
  | "PROCESS_FAILED"
  | "OUTPUT_LIMIT"
  | "UNSUPPORTED_HOST"
  | "DEVICE_SELECTION_REQUIRED"
  | "DEVICE_UNAUTHORIZED"
  | "DEVICE_OFFLINE"
  | "CAPTURE_PROTECTED"
  | "APP_UNAVAILABLE"
  | "NAVIGATION_FAILED"
  | "READINESS_TIMEOUT"
  | "SCREEN_UNVERIFIED"
  | "PROFILE_MISMATCH"
  | "EVIDENCE_MISSING"
  | "POLICY_FAILED"
  | "VALIDATION_INCONCLUSIVE"
  | "INTERNAL_ERROR";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Version".
 */
export type Version = string;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JsonPointer".
 */
export type JsonPointer = string;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JsonValue".
 */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JsonArray".
 */
export type JsonArray = JsonValue[];
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Dimension".
 */
export type Dimension = number | TokenReference;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SignedLength".
 */
export type SignedLength = number | TokenReference;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Size".
 */
export type Size = Dimension | ("hug" | "fill");
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Paint".
 */
export type Paint = Color | TokenReference;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "PropertyValue".
 */
export type PropertyValue =
  | {
      type: "string";
      value: string;
    }
  | {
      type: "boolean";
      value: boolean;
    }
  | {
      type: "number";
      value: number;
    }
  | {
      type: "dimension";
      value: number;
      unit: "design-unit";
    }
  | {
      type: "color";
      value: Color;
    }
  | {
      type: "typography";
      value: Typography;
    }
  | {
      type: "shadow";
      value: Shadow;
    }
  | {
      type: "asset";
      value: StableId;
    }
  | {
      type: "component";
      value: ComponentReference;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DesignNode".
 */
export type DesignNode =
  ContainerNode | ScrollNode | TextNode | ImageNode | ShapeNode | SimpleNode | ComponentNode | UnsupportedNode;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "MappingState".
 */
export type MappingState = "proposed" | "approved" | "stale" | "rejected" | "unresolved";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TargetCodeMapping".
 */
export type TargetCodeMapping = {
  [k: string]: unknown;
} & {
  id: StableId;
  component: ComponentReference;
  target: "android" | "ios" | "web";
  state: MappingState;
  repository?: RepositoryIdentity;
  path?: RelativePath;
  module?: string;
  symbol?: string;
  adapters: TypedAdapter[];
  supportedVariants: StableId[];
  usageExamples: ArtifactReference[];
  evidenceIds: StableId[];
  reviewer?: StableId;
  approvalRevision?: StableId;
  reason?: string;
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TokenValue".
 */
export type TokenValue =
  | PropertyValue
  | {
      type: "alias";
      token: StableId;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TokenResolution".
 */
export type TokenResolution =
  | {
      tokenId: StableId;
      mode: StableId;
      status: "resolved";
      value: PropertyValue;
      aliasChain: StableId[];
    }
  | {
      tokenId: StableId;
      mode: StableId;
      status: "unresolved";
      /**
       * @minItems 1
       */
      diagnosticIds: [StableId, ...StableId[]];
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FontResource".
 */
export type FontResource =
  | {
      kind: "bundled";
      id: StableId;
      family: string;
      postScriptName: string;
      style: "normal" | "italic";
      weight: number;
      version: Version;
      artifact: Artifact;
      license: LicenseEvidence;
      availability: "declared" | "verified" | "missing";
      source: string;
      glyphCoverage: "unverified" | "fixture-verified" | "missing-glyphs";
    }
  | {
      kind: "local-requirement";
      id: StableId;
      family: string;
      postScriptName: string;
      style: "normal" | "italic";
      weight: number;
      version: Version;
      expectedSha256: Sha256;
      expectedByteLength: number;
      license: LicenseEvidence;
      hostScope: string;
      verification: "required" | "verified" | "mismatch" | "missing";
      verificationEvidence?: ArtifactReference;
      glyphCoverage: "unverified" | "fixture-verified" | "missing-glyphs";
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaBinding".
 */
export type FigmaBinding =
  | {
      status: "verified";
      fileKey: StableId;
      branchKey?: StableId;
      nodeId: string;
      evidenceId: StableId;
    }
  | {
      status: "asserted";
      assertedUrl: string;
      actorId: StableId;
    }
  | {
      status: "unknown";
      reason: string;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SourceIdentity".
 */
export type SourceIdentity =
  | {
      transport: "figma-offline";
      intakeId: StableId;
      contentDigest: Sha256;
      binding: FigmaBinding & {
        [k: string]: unknown;
      };
      declaredTransport?: "figma-rest" | "figma-plugin";
      declaredSourceVersion?: Version;
    }
  | {
      transport: "figma-rest";
      fileKey: StableId;
      branchKey?: StableId;
      nodeId: string;
      sourceVersion: Version;
    }
  | {
      transport: "figma-plugin";
      sessionId: StableId;
      captureId: StableId;
      contentDigest: Sha256;
      binding: FigmaBinding;
      delivery: "snapshot-file" | "paired-ingest";
    }
  | {
      transport: "synthetic";
      fixtureId: StableId;
      contentDigest: Sha256;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SourceSnapshot".
 */
export type SourceSnapshot = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  identity: SourceIdentity;
  capturedAt: Timestamp;
  captureEndedAt: Timestamp;
  consistency: {
    guarantee: "version-pinned" | "change-checked-session" | "synthetic-immutable" | "unstable" | "unknown";
    beforeDigest?: Sha256;
    afterDigest?: Sha256;
    limitations: string[];
  };
  completeness: "complete" | "partial" | "unavailable";
  requests: {
    id: StableId;
    operation:
      "metadata" | "nodes" | "reference-render" | "image-fills" | "variables" | "library" | "plugin-export" | "fixture";
    nodeIds: string[];
    versionSupport: "pinned" | "not-supported" | "not-applicable";
    requestedVersion?: Version;
    returnedVersion?: Version;
    outcome: "complete" | "null-result" | "denied" | "partial" | "downscaled" | "unavailable";
  }[];
  artifacts: Artifact[];
  missing: string[];
  diagnosticIds: StableId[];
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NativeCaptureRecoveryEnvelope".
 */
export type NativeCaptureRecoveryEnvelope = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  operation: "recover";
  projectId: StableId;
  requestId: StableId;
  status: "complete" | "failed" | "cancelled" | "interrupted" | "unavailable";
  error?: ContractError;
  value?: {
    phase: "proposed" | "authorized";
    proposal: CaptureRecoveryProposal;
    consumed: boolean;
    confirmationText: string;
    authorization?: ArtifactReference;
    receiptId?: StableId;
  };
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NativeCaptureEnvelope".
 */
export type NativeCaptureEnvelope = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  operation: "capture" | "inspect" | "convert" | "artifact";
  projectId: StableId;
  requestId: StableId;
  status: "accepted" | "complete" | "partial" | "failed" | "unavailable" | "cancelled" | "interrupted";
  error?: ContractError;
  value?: {
    jobId: StableId;
    jobStatus: JobStatus;
    capture?: FigmaCaptureResult;
    readiness: "not-evaluated" | "needs-review" | "blocked";
    /**
     * @maxItems 64
     */
    missing: string[];
    remediationOrigin?: string;
    outputRelative?: RelativePath;
    /**
     * @maxItems 32
     */
    artifacts: {
      role:
        | "metadata"
        | "nodes"
        | "render-map"
        | "reference"
        | "source"
        | "manifest"
        | "result"
        | "design"
        | "resources"
        | "source-map"
        | "conversion-evidence"
        | "provenance"
        | "report";
      artifact: Artifact;
    }[];
  };
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JobStatus".
 */
export type JobStatus =
  | "queued"
  | "running"
  | "waiting-for-user"
  | "retry-wait"
  | "cancel-requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Job".
 */
export type Job = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  actorId: StableId;
  operation: Operation;
  status: JobStatus;
  input: ArtifactReference;
  resources: ResourceLock;
  idempotency: IdempotencyScope;
  attempt: number;
  deadline: Timestamp;
  budget: Budget;
  lease?: Lease;
  nextEligibleAttempt?: Timestamp;
  progress: number;
  outputState?: "complete" | "partial-inspection";
  receipt?: CommitReceipt;
  error?: ContractError;
  comparisonVerdict?: "pass" | "fail" | "inconclusive";
  sourceStatus?: SourceStatus;
  diagnosticIds: StableId[];
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SemanticOperation".
 */
export type SemanticOperation =
  | {
      op: "set-property";
      nodeId: StableId;
      pointer: JsonPointer;
      value: JsonValue;
    }
  | {
      op: "insert-node";
      parentId: StableId;
      beforeNodeId?: StableId;
      slot?: StableId;
      node: DesignNode;
    }
  | {
      op: "remove-node" | "detach-instance";
      nodeId: StableId;
    }
  | {
      op: "move-node";
      nodeId: StableId;
      parentId: StableId;
      beforeNodeId?: StableId;
      slot?: StableId;
    }
  | {
      op: "replace-resources";
      resources: ResourceLock;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Measurement".
 */
export type Measurement =
  | {
      status: "measured";
      /**
       * @minItems 1
       */
      evidenceIds: [StableId, ...StableId[]];
    }
  | {
      status: "not-measured";
      reason: string;
    };
/**
 * No manifest self-hash; payload artifacts never contain bundleId. Hash canonical payload including sorted artifact hashes, excluding bundleId and volatile delivery metadata only. Integrity is not authorship. F03 trusted store validates approval, F08/later compiler publishes atomically.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "HandoffManifest".
 */
export type HandoffManifest = {
  [k: string]: unknown;
} & {
  schemaVersion: SchemaVersion;
  bundleVersion: "1.0";
  compiler: ToolIdentity;
  bundleId: Sha256;
  projectId: StableId;
  designId: StableId;
  revision: ArtifactReference;
  target: "android" | "ios" | "web";
  resources: ResourceLock;
  readiness: "ready" | "needs-review" | "blocked";
  approval:
    | {
        status: "approved";
        event: ArtifactReference;
        verification: "trusted-local-store-required" | "trusted-issuer-required";
      }
    | {
        status: "unapproved";
        mode: "explicit-draft";
      };
  scenario: ArtifactReference;
  validationPolicy: ArtifactReference;
  artifacts: {
    "design.json": Artifact & {
      path?: "design.json";
      mediaType?: "application/json";
    };
    "design.md": Artifact & {
      path?: "design.md";
      mediaType?: "text/markdown";
    };
    "reference.png": Artifact & {
      path?: "reference.png";
      mediaType?: "image/png";
    };
    "preview.png": Artifact & {
      path?: "preview.png";
      mediaType?: "image/png";
    };
    "metadata.json": Artifact & {
      path?: "metadata.json";
      mediaType?: "application/json";
    };
    "components.json": Artifact & {
      path?: "components.json";
      mediaType?: "application/json";
    };
    "tokens.json": Artifact & {
      path?: "tokens.json";
      mediaType?: "application/json";
    };
    "implementation.json": Artifact & {
      path?: "implementation.json";
      mediaType?: "application/json";
    };
    "diagnostics.json": Artifact & {
      path?: "diagnostics.json";
      mediaType?: "application/json";
    };
    assets: (Artifact & {
      path?: string;
    })[];
  };
};
/**
 * Authoritative stored job row version, not a client counter or artifact schema version.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JobVersion".
 */
export type JobVersion = number;
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "LegacyResponseData".
 */
export type LegacyResponseData = {
  kind: "accepted-job" | "job" | "artifact" | "design" | "validation" | "capabilities";
  job?: Job;
  jobVersion?: JobVersion;
  jobId?: StableId;
  status?: JobStatus;
  artifact?: Artifact;
  design?: DesignIR;
  validation?: ValidationReport;
  capabilities?: ProviderCapabilities;
  warnings: Diagnostic[];
} & LegacyResponseData1;
export type LegacyResponseData1 =
  | {
      kind: "accepted-job";
      jobId: StableId;
      status: "queued" | "running" | "waiting-for-user" | "retry-wait";
    }
  | {
      kind: "job";
      job: Job;
    }
  | {
      kind: "artifact";
      artifact: Artifact;
    }
  | {
      kind: "design";
      design: DesignIR;
    }
  | {
      kind: "validation";
      validation: ValidationReport;
    }
  | {
      kind: "capabilities";
      capabilities: ProviderCapabilities;
    };
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ResponseEnvelope".
 */
export type ResponseEnvelope =
  | {
      schemaVersion: SchemaVersion;
      success: true;
      requestId: StableId;
      data:
        | FoundationRevisionResponseData
        | FoundationHelpResponseData
        | FoundationVersionResponseData
        | FoundationApiDescriptionResponseData
        | FoundationServiceResponseData
        | LegacyResponseData;
    }
  | {
      schemaVersion: SchemaVersion;
      success: false;
      requestId: StableId;
      error: ContractError;
    };
/**
 * F08 successful job response with an authoritative row version. Refines the shared envelope without invalidating legacy unversioned job responses.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationVersionedJobResponse".
 */
export type FoundationVersionedJobResponse = ResponseEnvelope & {
  success: true;
  data: {
    kind: "job";
    job: Job;
    jobVersion: JobVersion;
  };
};
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ProviderOutcome".
 */
export type ProviderOutcome =
  | {
      schemaVersion: SchemaVersion;
      projectId: StableId;
      requestId: StableId;
      status: "complete";
      value: JsonValue;
      diagnosticIds: StableId[];
    }
  | {
      schemaVersion: SchemaVersion;
      projectId: StableId;
      requestId: StableId;
      status: "partial";
      value: JsonValue;
      /**
       * @minItems 1
       */
      missing: [string, ...string[]];
      error: ContractError;
      diagnosticIds: StableId[];
    }
  | {
      schemaVersion: SchemaVersion;
      projectId: StableId;
      requestId: StableId;
      status: "unavailable" | "failed" | "cancelled" | "interrupted";
      error: ContractError;
      diagnosticIds: StableId[];
    };

export interface ContractCatalog {
  ReferenceRecoveryBinding: ReferenceRecoveryBinding;
  ReferenceRecoveryArchive: ReferenceRecoveryArchive;
  ReferenceRecoveryRecord: ReferenceRecoveryRecord;
  ReferenceRecoveryEvidence: ReferenceRecoveryEvidence;
  OfflineReferencePlan: OfflineReferencePlan;
  EffectiveReference: EffectiveReference;
  ReferenceConversionEvidence: ReferenceConversionEvidence;
  ReferenceConversionInspectionProof: ReferenceConversionInspectionProof;
  ReferenceConversionInspection: ReferenceConversionInspection;
  NativeReferenceOfflineEnvelope: NativeReferenceOfflineEnvelope;
  SchemaVersion: SchemaVersion;
  StableId: StableId;
  Sha256: Sha256;
  Version: Version;
  Timestamp: Timestamp;
  JsonPointer: JsonPointer;
  RelativePath: RelativePath;
  JsonValue: JsonValue;
  JsonArray: JsonArray;
  JsonObject: JsonObject;
  Extensions: Extensions;
  Artifact: Artifact;
  ArtifactReference: ArtifactReference;
  Point: Point;
  Bounds: Bounds;
  Transform: Transform;
  TokenReference: TokenReference;
  Dimension: Dimension;
  SignedLength: SignedLength;
  Size: Size;
  Insets: Insets;
  Layout: Layout;
  Color: Color;
  Paint: Paint;
  Shadow: Shadow;
  Clip: Clip;
  Appearance: Appearance;
  Typography: Typography;
  StyledRange: StyledRange;
  ControlState: ControlState;
  Accessibility: Accessibility;
  Behavior: Behavior;
  NodeMetadata: NodeMetadata;
  VisualBinding: VisualBinding;
  ContainerNode: ContainerNode;
  ScrollNode: ScrollNode;
  TextNode: TextNode;
  ImageNode: ImageNode;
  ShapeNode: ShapeNode;
  SimpleNode: SimpleNode;
  ComponentReference: ComponentReference;
  PropertyValue: PropertyValue;
  PropertyValues: PropertyValues;
  ComponentNode: ComponentNode;
  UnsupportedNode: UnsupportedNode;
  DesignNode: DesignNode;
  ResourceLock: ResourceLock;
  DesignIR: DesignIR;
  PropertyDefinition: PropertyDefinition;
  SlotDefinition: SlotDefinition;
  VisualDefinition: VisualDefinition;
  DependencyDeclaration: DependencyDeclaration;
  RepositoryIdentity: RepositoryIdentity;
  MappingState: MappingState;
  TypedAdapter: TypedAdapter;
  TargetCodeMapping: TargetCodeMapping;
  TokenValue: TokenValue;
  TokenDefinition: TokenDefinition;
  TokenResolution: TokenResolution;
  LicenseEvidence: LicenseEvidence;
  AssetResource: AssetResource;
  FontResource: FontResource;
  ComponentSnapshot: ComponentSnapshot;
  TokenSnapshot: TokenSnapshot;
  ResourceSnapshot: ResourceSnapshot;
  Evidence: Evidence;
  ProvenanceEntry: ProvenanceEntry;
  ProvenanceSnapshot: ProvenanceSnapshot;
  FigmaBinding: FigmaBinding;
  SourceIdentity: SourceIdentity;
  SourceSnapshot: SourceSnapshot;
  FigmaCaptureRequest: FigmaCaptureRequest;
  FigmaCaptureManifest: FigmaCaptureManifest;
  FigmaCaptureResult: FigmaCaptureResult;
  CaptureRecoveryProposal: CaptureRecoveryProposal;
  CaptureRecoveryBinding: CaptureRecoveryBinding;
  CaptureRecoveryResource: CaptureRecoveryResource;
  CaptureRecoveryAuthorization: CaptureRecoveryAuthorization;
  NativeCaptureRecoveryEnvelope: NativeCaptureRecoveryEnvelope;
  NativeCaptureEnvelope: NativeCaptureEnvelope;
  FigmaIntakeManifest: FigmaIntakeManifest;
  FigmaSourceMap: FigmaSourceMap;
  FigmaConversionEvidence: FigmaConversionEvidence;
  SourceStatus: SourceStatus;
  FigmaReferenceBinding: FigmaReferenceBinding;
  FigmaReferenceProposal: FigmaReferenceProposal;
  FigmaReferenceApproval: FigmaReferenceApproval;
  FigmaDiagnosticPredecessor: FigmaDiagnosticPredecessor;
  FigmaReferenceRequest: FigmaReferenceRequest;
  FigmaReferenceEvidence: FigmaReferenceEvidence;
  ReferenceInputAccounting: ReferenceInputAccounting;
  ReferenceJobUsage: ReferenceJobUsage;
  ReferenceJobMetadata: ReferenceJobMetadata;
  ReferenceRecoveryPlan: ReferenceRecoveryPlan;
  RetainedPublicationCheck: RetainedPublicationCheck;
  RetainedInventoryFailure: RetainedInventoryFailure;
  ReferenceRecoveryPlanReason: ReferenceRecoveryPlanReason;
  NativeReferenceRecoveryPlanEnvelope: NativeReferenceRecoveryPlanEnvelope;
  NativeReferenceEnvelope: NativeReferenceEnvelope;
  Operation: Operation;
  Diagnostic: Diagnostic;
  Loss: Loss;
  StageAssessment: StageAssessment;
  DiagnosticReport: DiagnosticReport;
  Revision: Revision;
  ExpectedBase: ExpectedBase;
  SemanticOperation: SemanticOperation;
  SemanticPatch: SemanticPatch;
  SemanticDiff: SemanticDiff;
  ApprovalContext: ApprovalContext;
  Waiver: Waiver;
  ReviewEvent: ReviewEvent;
  CaptureRegion: CaptureRegion;
  RenderProfile: RenderProfile;
  ToolIdentity: ToolIdentity;
  HostIdentity: HostIdentity;
  BoundsMap: BoundsMap;
  CaptureScenario: CaptureScenario;
  RequiredControl: RequiredControl;
  ReadinessReceipt: ReadinessReceipt;
  CaptureMetadata: CaptureMetadata;
  DeviceIdentity: DeviceIdentity;
  ValidationPolicy: ValidationPolicy;
  Measurement: Measurement;
  ComparisonRegion: ComparisonRegion;
  ValidationReport: ValidationReport;
  PixelMetrics: PixelMetrics;
  ImplementationPlan: ImplementationPlan;
  HandoffMetadata: HandoffMetadata;
  HandoffManifest: HandoffManifest;
  ErrorCode: ErrorCode;
  ReferenceDiagnostic: ReferenceDiagnostic;
  ContractError: ContractError;
  Budget: Budget;
  AuthorizationContext: AuthorizationContext;
  IdempotencyScope: IdempotencyScope;
  Lease: Lease;
  CommitReceipt: CommitReceipt;
  JobStatus: JobStatus;
  Job: Job;
  JobVersion: JobVersion;
  FoundationRevisionResponseData: FoundationRevisionResponseData;
  FoundationHelpResponseData: FoundationHelpResponseData;
  FoundationVersionResponseData: FoundationVersionResponseData;
  FoundationApiDescriptionResponseData: FoundationApiDescriptionResponseData;
  FoundationServiceResponseData: FoundationServiceResponseData;
  LegacyResponseData: LegacyResponseData;
  ResponseEnvelope: ResponseEnvelope;
  FoundationVersionedJobResponse: FoundationVersionedJobResponse;
  ProviderCapabilities: ProviderCapabilities;
  OperationRequestContext: OperationRequestContext;
  ProviderOutcome: ProviderOutcome;
  FigmaReadRequest: FigmaReadRequest;
  PluginSnapshotRequest: PluginSnapshotRequest;
  FoundationAcceptFixtureRequest: FoundationAcceptFixtureRequest;
  FoundationRenderSubmissionRequest: FoundationRenderSubmissionRequest;
  FoundationCancelJobRequest: FoundationCancelJobRequest;
  RenderRequest: RenderRequest;
  RenderResult: RenderResult;
  DeviceRequest: DeviceRequest;
  DeviceScenarioRequest: DeviceScenarioRequest;
  ProcessRequest: ProcessRequest;
  FileRequest: FileRequest;
  CredentialReference: CredentialReference;
  ModelCapabilities: ModelCapabilities;
  ModelRequest: ModelRequest;
  IndexRequest: IndexRequest;
  SemanticCase: SemanticCase;
  FixtureManifest: FixtureManifest;
  ContractExamples: ContractExamples;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryBinding".
 */
export interface ReferenceRecoveryBinding {
  schemaVersion: SchemaVersion;
  recoveryId: StableId;
  projectId: StableId;
  actorId: StableId;
  permissionScope: StableId;
  artifactRootId: StableId;
  requestId: StableId;
  originalJobId: StableId;
  jobSha256: Sha256;
  recordSha256: Sha256;
  stateSha256: Sha256;
  metadataSha256: Sha256;
  stagesSha256: Sha256;
  identitySha256: Sha256;
  policySha256: Sha256;
  planSha256: Sha256;
  source: ArtifactReference;
  approval: ArtifactReference;
  historicalEvidence: Artifact;
  reference: Artifact;
  recordedAt: Timestamp;
  confirmation: "RECOVER-VERIFIED-REFERENCE-OFFLINE";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ArtifactReference".
 */
export interface ArtifactReference {
  id: StableId;
  sha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Artifact".
 */
export interface Artifact {
  id: StableId;
  path: RelativePath;
  mediaType: string;
  byteLength: number;
  sha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryArchive".
 */
export interface ReferenceRecoveryArchive {
  kind: "restored-offline-reference-v1";
  originBackupSha256: Sha256;
  restoredFromBackupSha256: Sha256;
  sourceRecordSha256: Sha256;
  bindingSha256: Sha256;
  currentRecordSha256: Sha256;
  currentStateSha256: Sha256;
  currentMetadataSha256: Sha256;
  protectionSha256: Sha256;
  sha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryRecord".
 */
export interface ReferenceRecoveryRecord {
  archive?: ReferenceRecoveryArchive;
  reservation: {
    binding: ReferenceRecoveryBinding;
    evidence: Artifact;
  };
  /**
   * @maxItems 10
   */
  events:
    | []
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ]
    | [
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
        {
          sequence: number;
          previousSha256: Sha256;
          kind:
            | "stage-intent"
            | "staged"
            | "publication-intent"
            | "committed"
            | "conversion-intent"
            | "conversion-committed";
          staged?: {
            stagingId: StableId;
            artifact: Artifact;
          };
          receipt?: CommitReceipt;
          /**
           * @minItems 6
           * @maxItems 7
           */
          outputs?:
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
            | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
          /**
           * @maxItems 7
           */
          introduced?:
            | []
            | [StableId]
            | [StableId, StableId]
            | [StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId]
            | [StableId, StableId, StableId, StableId, StableId, StableId, StableId];
        },
      ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CommitReceipt".
 */
export interface CommitReceipt {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  jobId: StableId;
  idempotency: IdempotencyScope;
  committedAt: Timestamp;
  outputs: Artifact[];
  integrity: "verified";
  publication: "atomic";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "IdempotencyScope".
 */
export interface IdempotencyScope {
  key: StableId;
  projectId: StableId;
  actorId: StableId;
  operation: Operation;
  payloadSha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryEvidence".
 */
export interface ReferenceRecoveryEvidence {
  schemaVersion: SchemaVersion;
  kind: "offline-recovered-reference";
  binding: ReferenceRecoveryBinding;
  bindingSha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "OfflineReferencePlan".
 */
export interface OfflineReferencePlan {
  retained: ReferenceRecoveryPlan;
  recoveryId: StableId;
  policySha256: Sha256;
  metadataSha256: Sha256;
  schema: 4 | 5;
  state: "unreserved" | "reserved" | "blocked" | "committed";
  controlSha256: Sha256;
  projectWriteScope: "single-recovery-and-bound-conversion-only";
  receiptSha256?: Sha256;
  proofSha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceRecoveryPlan".
 */
export interface ReferenceRecoveryPlan {
  verification: "retained-bytes";
  eligibility: "eligible-for-recovery-review";
  consumed: true;
  historicalStatus: "interrupted";
  jobId: StableId;
  jobSha256: Sha256;
  stateSha256: Sha256;
  identitySha256: Sha256;
  sourceSha256: Sha256;
  approvalSha256: Sha256;
  policySha256: Sha256;
  proofSha256: Sha256;
  referenceStatus: "complete" | "partial";
  pixelWidth: number;
  pixelHeight: number;
  colorSpace: "srgb" | "unknown";
  /**
   * @minItems 2
   * @maxItems 2
   */
  stages: [
    {
      role: "reference" | "evidence";
      sha256: Sha256;
      byteLength: number;
      disposition: "recovery-needed";
      publication: "stage-only" | "published-only" | "recovered-stage-and-blob";
    },
    {
      role: "reference" | "evidence";
      sha256: Sha256;
      byteLength: number;
      disposition: "recovery-needed";
      publication: "stage-only" | "published-only" | "recovered-stage-and-blob";
    },
  ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "EffectiveReference".
 */
export interface EffectiveReference {
  kind: "offline-recovered-reference";
  recoveryId: StableId;
  receiptSha256: Sha256;
  evidence: ArtifactReference;
  source: ArtifactReference;
  reference: ArtifactReference;
  referenceStatus: "complete" | "partial";
  pixelWidth: number;
  pixelHeight: number;
  colorSpace: "srgb" | "unknown";
  historicalStatus: "interrupted";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceConversionEvidence".
 */
export interface ReferenceConversionEvidence {
  schemaVersion: SchemaVersion;
  composition: "figma-capture-recovered-reference-v1";
  policy: "fixed-v2";
  source: ArtifactReference;
  structure: ArtifactReference;
  projection: ArtifactReference;
  effectiveReference: EffectiveReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceConversionInspectionProof".
 */
export interface ReferenceConversionInspectionProof {
  inspectionPolicySha256: Sha256;
  recoveryPolicySha256: Sha256;
  recoveryId: StableId;
  recoveryReceiptSha256: Sha256;
  originalJobSha256: Sha256;
  originalStateSha256: Sha256;
  identitySha256: Sha256;
  controlSha256: Sha256;
  proofSha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceInputAccounting".
 */
export interface ReferenceInputAccounting {
  limitBytes: number;
  privateBytes: number;
  networkBytes: number;
  phase: "proof" | "history" | "inventory" | "admission" | "acquisition" | "commit" | "inspection";
  rejected?: {
    kind: "private" | "network";
    bytes: number;
    limit: "aggregate" | "per-read";
    phase: "proof" | "history" | "inventory" | "admission" | "acquisition" | "commit" | "inspection";
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ContractError".
 */
export interface ContractError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfter?: Timestamp;
  jobId?: StableId;
  referenceDiagnostic?: ReferenceDiagnostic;
  diagnosticIds: StableId[];
}
/**
 * Closed nonsecret observations only. Absence on legacy evidence means unknown, never a reconstructed diagnosis. A command diagnostic without a receipt is not durable proof.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceDiagnostic".
 */
export interface ReferenceDiagnostic {
  stage: "mime" | "png" | "json" | "worker" | "operation" | "legacy";
  reason:
    | "validated"
    | "mime-missing"
    | "mime-rejected"
    | "not-png"
    | "png-malformed"
    | "png-unsupported"
    | "png-interlace"
    | "png-animation"
    | "png-critical"
    | "png-color-unsupported"
    | "png-color-conflict"
    | "input-limit"
    | "output-limit"
    | "raster-limit"
    | "node-limit"
    | "depth-limit"
    | "intermediate-limit"
    | "json-malformed"
    | "worker-protocol"
    | "worker-unavailable"
    | "worker-limit"
    | "cancelled"
    | "deadline"
    | "authority"
    | "legacy-unknown";
  mimeClass: "not-observed" | "png" | "generic-binary" | "missing" | "other";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "JsonObject".
 */
export interface JsonObject {
  [k: string]: JsonValue;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Extensions".
 */
export interface Extensions {
  [k: string]: JsonValue;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Point".
 */
export interface Point {
  x: number;
  y: number;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Bounds".
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "design-unit" | "pixel" | "dp" | "point";
}
/**
 * Affine local transform [a,b,c,d,tx,ty], x'=ax+cy+tx and y'=bx+dy+ty. Translation is in design units; origin is separate.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Transform".
 */
export interface Transform {
  /**
   * @minItems 6
   * @maxItems 6
   */
  matrix: [number, number, number, number, number, number];
  origin: Point;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TokenReference".
 */
export interface TokenReference {
  token: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Insets".
 */
export interface Insets {
  top: Dimension;
  right: Dimension;
  bottom: Dimension;
  left: Dimension;
}
/**
 * Normalizer in F02 owns defaults; schema validation never inserts them. Numeric dimensions are fixed design units. No percentages or CSS/native fields.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Layout".
 */
export interface Layout {
  width: Size;
  height: Size;
  minWidth?: Dimension;
  maxWidth?: Dimension;
  minHeight?: Dimension;
  maxHeight?: Dimension;
  padding?: Insets;
  margin?: Insets;
  spacing?: Dimension;
  alignment?: "start" | "center" | "end" | "stretch";
  distribution?: "start" | "center" | "end" | "space-between";
  position?: "flow" | "absolute";
  offset?: Point;
  aspectRatio?: number;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Color".
 */
export interface Color {
  space: "srgb";
  r: number;
  g: number;
  b: number;
  a: number;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Shadow".
 */
export interface Shadow {
  offset: Point;
  blur: Dimension;
  spread: SignedLength;
  color: Paint;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Clip".
 */
export interface Clip {
  kind: "none" | "bounds" | "rounded-bounds";
  radius?: Dimension;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Appearance".
 */
export interface Appearance {
  fill?: Paint;
  border?: {
    width: Dimension;
    color: Paint;
  };
  radius?: Dimension;
  shadow?: Shadow | TokenReference;
  opacity?: number;
  /**
   * Representable evidence; outside the initial exact rendering profile.
   */
  blur?: number | TokenReference;
  clip?: Clip;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Typography".
 */
export interface Typography {
  fontId: StableId;
  fontSize: Dimension;
  fontWeight: number;
  lineHeight: Dimension;
  letterSpacing: SignedLength;
  alignment: "start" | "center" | "end";
  color: Paint;
  wrap: "wrap" | "no-wrap";
  styleToken?: TokenReference;
}
/**
 * Zero-based half-open UTF-16 code units; no implicit Unicode normalization. F02 checks order, coverage and surrogate boundaries. Grapheme editing is adapter policy.
 *
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "StyledRange".
 */
export interface StyledRange {
  start: number;
  end: number;
  typography: Typography;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ControlState".
 */
export interface ControlState {
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  error?: string;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Accessibility".
 */
export interface Accessibility {
  role:
    | "none"
    | "heading"
    | "text"
    | "image"
    | "button"
    | "toggle"
    | "input"
    | "list"
    | "list-item"
    | "link"
    | "dialog"
    | "navigation";
  label?: string;
  hint?: string;
  state?: ControlState;
  focusOrder?: number;
  minimumTarget?: Bounds;
  contrast?: {
    ratio: number;
    evidenceId: StableId;
  };
  evidence: "declared-intent" | "source-exact" | "inferred" | "runtime-measured" | "unresolved";
  evidenceIds?: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Behavior".
 */
export interface Behavior {
  status: "declared" | "reviewed" | "unresolved";
  critical: boolean;
  intent: "none" | "navigate" | "open-overlay" | "close-overlay" | "update-demo-state";
  targetId?: StableId;
  targetRevision?: ArtifactReference;
  stateField?: StableId;
  value?: PropertyValue;
  requiresConfirmation?: boolean;
  simulatedOnly?: true;
  evidenceIds?: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ComponentReference".
 */
export interface ComponentReference {
  id: StableId;
  version: Version;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NodeMetadata".
 */
export interface NodeMetadata {
  sourceAbsoluteBounds?: Bounds;
  sourceTextMetrics?: {
    bounds: Bounds;
    baselines?: number[];
    evidenceId: StableId;
  };
  rawSource?: ArtifactReference;
  sourceNodeId?: string;
  critical?: boolean;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "VisualBinding".
 */
export interface VisualBinding {
  property: StableId;
  target:
    | "content"
    | "accessibility.label"
    | "accessibility.state.checked"
    | "accessibility.state.disabled"
    | "appearance.fill"
    | "appearance.opacity";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ContainerNode".
 */
export interface ContainerNode {
  id: StableId;
  name?: string;
  type: "frame" | "column" | "row" | "stack" | "group";
  layout: Layout;
  /**
   * Required semantically for frame; row/column/stack have intrinsic direction and group does not allocate layout.
   */
  flow?: "horizontal" | "vertical" | "absolute";
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  behavior?: Behavior;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  bindings?: VisualBinding[];
  children: DesignNode[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ScrollNode".
 */
export interface ScrollNode {
  id: StableId;
  name?: string;
  type: "scroll";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  scroll: {
    direction: "horizontal" | "vertical" | "both";
    viewportBounds: Bounds;
    contentBounds: Bounds;
    captureOffset: Point;
  };
  children: DesignNode[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TextNode".
 */
export interface TextNode {
  id: StableId;
  name?: string;
  type: "text";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  behavior?: Behavior;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  bindings?: VisualBinding[];
  content: string;
  indexing: "utf-16";
  typography: Typography;
  styledRanges?: StyledRange[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ImageNode".
 */
export interface ImageNode {
  id: StableId;
  name?: string;
  type: "image" | "icon";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  behavior?: Behavior;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  assetId: StableId;
  fit: "contain" | "cover" | "fill" | "crop";
  crop?: Bounds1;
  assetTransform?: Transform;
}
/**
 * Explicit source-pixel crop, distinct from node transform; semantic bounds checks belong to F02/F05.
 */
export interface Bounds1 {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "design-unit" | "pixel" | "dp" | "point";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ShapeNode".
 */
export interface ShapeNode {
  id: StableId;
  name?: string;
  type: "shape";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  behavior?: Behavior;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  bindings?: VisualBinding[];
  shape: "rectangle" | "ellipse";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SimpleNode".
 */
export interface SimpleNode {
  id: StableId;
  name?: string;
  type: "divider" | "spacer";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  metadata?: NodeMetadata;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ComponentNode".
 */
export interface ComponentNode {
  id: StableId;
  name?: string;
  type: "component";
  layout: Layout;
  appearance?: Appearance;
  transform?: Transform;
  accessibility?: Accessibility;
  behavior?: Behavior;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  componentReference: ComponentReference;
  properties: PropertyValues;
  variant?: StableId;
  slots: {
    [k: string]: DesignNode[];
  };
  snapshotExpansion?: {
    kind: "snapshot-only";
    source: ArtifactReference;
    root: DesignNode;
    /**
     * @maxItems 0
     */
    editableProperties: [];
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "PropertyValues".
 */
export interface PropertyValues {
  [k: string]: PropertyValue;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "UnsupportedNode".
 */
export interface UnsupportedNode {
  id: StableId;
  name?: string;
  type: "unsupported";
  layout: Layout;
  transform?: Transform;
  metadata?: NodeMetadata;
  extensions?: Extensions;
  feature: string;
  reason: string;
  evidenceStatus: "raw-preserved" | "missing";
  inspectionCrop?: {
    assetId: StableId;
    bounds: Bounds;
    purpose: "inspection-only";
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ResourceLock".
 */
export interface ResourceLock {
  snapshotId: StableId;
  sha256: Sha256;
  componentRegistryRevision: Version;
  tokenRegistryRevision: Version;
  selectedModes: {
    [k: string]: StableId;
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DesignIR".
 */
export interface DesignIR {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  screen: {
    id: StableId;
    name: string;
    viewport: {
      width: number;
      height: number;
      unit: "design-unit";
    };
    capture?: CaptureRegion;
  };
  resources: ResourceLock;
  root: DesignNode;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureRegion".
 */
export interface CaptureRegion {
  bounds: Bounds;
  scrollOffset: Point;
  insets: Insets;
  systemBars: "included" | "excluded" | "unknown";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "PropertyDefinition".
 */
export interface PropertyDefinition {
  name: StableId;
  type: "string" | "boolean" | "number" | "dimension" | "color" | "typography" | "shadow" | "asset" | "component";
  required: boolean;
  default?: PropertyValue;
  /**
   * @minItems 1
   */
  allowedValues?: [PropertyValue, ...PropertyValue[]];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SlotDefinition".
 */
export interface SlotDefinition {
  name: StableId;
  targetNodeId: StableId;
  insertion: "children" | "replace";
  minItems: number;
  maxItems: number;
  /**
   * @minItems 1
   */
  allowedNodeTypes: [
    (
      | "frame"
      | "column"
      | "row"
      | "stack"
      | "scroll"
      | "text"
      | "image"
      | "icon"
      | "divider"
      | "shape"
      | "component"
      | "spacer"
      | "group"
      | "unsupported"
    ),
    ...(
      | "frame"
      | "column"
      | "row"
      | "stack"
      | "scroll"
      | "text"
      | "image"
      | "icon"
      | "divider"
      | "shape"
      | "component"
      | "spacer"
      | "group"
      | "unsupported"
    )[],
  ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "VisualDefinition".
 */
export interface VisualDefinition {
  id: StableId;
  version: Version;
  properties: PropertyDefinition[];
  slots: SlotDefinition[];
  variants: {
    id: StableId;
    when: PropertyValues;
    expansion: DesignNode;
  }[];
  expansion: DesignNode;
  dependencies: DependencyDeclaration;
  accessibility?: Accessibility;
  behavior?: Behavior;
  evidenceIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DependencyDeclaration".
 */
export interface DependencyDeclaration {
  components: ComponentReference[];
  tokens: StableId[];
  assets: StableId[];
  fonts: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RepositoryIdentity".
 */
export interface RepositoryIdentity {
  id: StableId;
  revision:
    | {
        kind: "commit";
        commit: string;
      }
    | {
        kind: "working-tree";
        baseCommit: string;
        sha256: Sha256;
      };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TypedAdapter".
 */
export interface TypedAdapter {
  kind: "property" | "event" | "slot" | "token";
  source: StableId;
  target: string;
  sourceType:
    | "string"
    | "boolean"
    | "number"
    | "dimension"
    | "color"
    | "typography"
    | "shadow"
    | "asset"
    | "component"
    | "slot"
    | "event";
  targetType: string;
  conversion: "identity" | "rename" | "enum-map" | "design-unit-to-target-unit";
  enumMap?: {
    [k: string]: PropertyValue;
  };
  targetUnit?: "dp" | "point" | "css-pixel";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TokenDefinition".
 */
export interface TokenDefinition {
  id: StableId;
  collection: StableId;
  type: "string" | "boolean" | "number" | "dimension" | "color" | "typography" | "shadow";
  values: {
    [k: string]: TokenValue;
  };
  sourceVariableId?: string;
  sourceCollectionId?: string;
  evidenceIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "LicenseEvidence".
 */
export interface LicenseEvidence {
  id: string;
  source: string;
  redistribution: "permitted" | "prohibited" | "unknown";
  embedding: "permitted" | "prohibited" | "unknown";
  notice: Artifact;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "AssetResource".
 */
export interface AssetResource {
  id: StableId;
  artifact: Artifact;
  width: number;
  height: number;
  colorSpace: "srgb" | "unknown";
  alpha: "opaque" | "straight" | "premultiplied" | "unknown";
  license: LicenseEvidence;
  source: ArtifactReference;
  usageNodeIds: StableId[];
  verification: "declared" | "decoded" | "sanitized" | "rejected";
  derivativeOf?: ArtifactReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ComponentSnapshot".
 */
export interface ComponentSnapshot {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  revision: Version;
  definitions: VisualDefinition[];
  mappings: TargetCodeMapping[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "TokenSnapshot".
 */
export interface TokenSnapshot {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  revision: Version;
  collections: {
    id: StableId;
    /**
     * @minItems 1
     */
    modes: [StableId, ...StableId[]];
  }[];
  selectedModes: {
    [k: string]: StableId;
  };
  definitions: TokenDefinition[];
  resolved: TokenResolution[];
  adapters: {
    tokenId: StableId;
    target: "android" | "ios" | "web";
    state: MappingState;
    adapter: TypedAdapter;
    repository?: RepositoryIdentity;
    path?: RelativePath;
    symbol?: string;
    reviewer?: StableId;
    approvalRevision?: StableId;
    evidenceIds: StableId[];
  }[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ResourceSnapshot".
 */
export interface ResourceSnapshot {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  components: ComponentSnapshot;
  tokens: TokenSnapshot;
  assets: AssetResource[];
  fonts: FontResource[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export interface Evidence {
  id: StableId;
  artifact: ArtifactReference;
  kind:
    | "source-property"
    | "source-image"
    | "synthetic-authored"
    | "manual-decision"
    | "repository-inspection"
    | "runtime-measurement"
    | "inference-output";
  sourceNodeId?: string;
  pointer?: JsonPointer;
  region?: Bounds;
  snapshotId?: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ProvenanceEntry".
 */
export interface ProvenanceEntry {
  id: StableId;
  type:
    | "figma-exact"
    | "figma-component"
    | "figma-style"
    | "screenshot-inference"
    | "token-registry"
    | "user-input"
    | "ai-generated"
    | "manual-edit";
  authority: "exact-source" | "inferred" | "manual" | "approved-manual";
  /**
   * @minItems 1
   */
  evidenceIds: [StableId, ...StableId[]];
  acceptedAt: Timestamp;
  supersedes: StableId[];
  actorId?: StableId;
  inferenceRunId?: StableId;
  confidence?: number;
  confidenceMeaning?: "uncalibrated-score";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ProvenanceSnapshot".
 */
export interface ProvenanceSnapshot {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  designId: StableId;
  nodes: {
    [k: string]: {
      [k: string]: ProvenanceEntry;
    };
  };
  evidence: Evidence[];
  history: ProvenanceEntry[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaCaptureRequest".
 */
export interface FigmaCaptureRequest {
  schemaVersion: SchemaVersion;
  captureId: StableId;
  projectId: StableId;
  policyId: StableId;
  selectionUrl: string;
  policySha256: Sha256;
  credential: CredentialReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CredentialReference".
 */
export interface CredentialReference {
  id: StableId;
  providerId: StableId;
  store: "windows-credential-manager" | "macos-keychain" | "configured-secure-store" | "test-fake";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaCaptureManifest".
 */
export interface FigmaCaptureManifest {
  schemaVersion: SchemaVersion;
  format: "figma-rest-capture-v1";
  referenceDiagnostic?: ReferenceDiagnostic;
  policySha256: Sha256;
  captureId: StableId;
  projectId: StableId;
  policyId: StableId;
  request: ArtifactReference;
  selection: {
    fileKey: string;
    nodeId: string;
  };
  startedAt: Timestamp;
  endedAt: Timestamp;
  sourceVersion?: Version;
  source?: ArtifactReference;
  completeness: "complete" | "partial" | "unavailable";
  referenceStatus: "complete" | "partial" | "unavailable";
  readiness: "not-evaluated";
  /**
   * @maxItems 4
   */
  observations:
    | []
    | [
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
      ]
    | [
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
      ]
    | [
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
      ]
    | [
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
        {
          call: number;
          operation: "metadata" | "nodes" | "reference-render" | "reference-download";
          outcome: "complete" | "denied" | "rate-limited" | "null-result" | "partial" | "unavailable" | "downscaled";
          statusCode?: number;
          receivedBytes: number;
          /**
           * @maxItems 20000
           */
          nodeIds: string[];
          requestedVersion?: Version;
          returnedVersion?: Version;
        },
      ];
  /**
   * @maxItems 5
   */
  artifacts:
    | []
    | [
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
      ]
    | [
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
      ]
    | [
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
      ]
    | [
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
      ]
    | [
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
        {
          role: "metadata" | "nodes" | "render-map" | "reference" | "source";
          artifact: Artifact;
        },
      ];
  reference?: {
    artifact: ArtifactReference;
    bounds: Bounds;
    scale: 1;
    pixelWidth: number;
    pixelHeight: number;
    colorSpace: "srgb" | "unknown";
  };
  /**
   * @maxItems 64
   */
  missing: string[];
  /**
   * @maxItems 64
   */
  limitations: string[];
  remediationOrigin?: string;
  nextEligibleAt?: Timestamp;
  retry?: "explicit-action-required" | "retry-after-unknown";
  usage: {
    externalCalls: number;
    dnsQueries: number;
    networkReceivedBytes: number;
    networkBodyBytes: number;
    /**
     * Cumulative staged bytes through this manifest; the final capture result additionally accounts for its own bytes.
     */
    persistedBytes: number;
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaCaptureResult".
 */
export interface FigmaCaptureResult {
  schemaVersion: SchemaVersion;
  captureId: StableId;
  projectId: StableId;
  manifest: ArtifactReference;
  persistedBytes: number;
  errorCode?: ErrorCode;
  referenceDiagnostic?: ReferenceDiagnostic;
  source?: ArtifactReference;
  completeness: "complete" | "partial" | "unavailable";
  referenceStatus: "complete" | "partial" | "unavailable";
  readiness: "not-evaluated";
  nextEligibleAt?: Timestamp;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureRecoveryProposal".
 */
export interface CaptureRecoveryProposal {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  actorId: StableId;
  originalRequestId: StableId;
  originalJobId: StableId;
  nextRequestId: StableId;
  nextJobId: StableId;
  originalVersion: number;
  originalGeneration: number;
  proofSha256: Sha256;
  externalCalls: number;
  responseEvidence: "unknown";
  quotaEvidence: "unknown";
  credentialValidity: "unknown";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureRecoveryBinding".
 */
export interface CaptureRecoveryBinding {
  originalJobId: StableId;
  authorization: ArtifactReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureRecoveryResource".
 */
export interface CaptureRecoveryResource {
  key: StableId;
  generation: number;
  state: "released";
  jobId: null;
  leaseId: null;
  fencingToken: null;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureRecoveryAuthorization".
 */
export interface CaptureRecoveryAuthorization {
  schemaVersion: SchemaVersion;
  proposal: CaptureRecoveryProposal;
  recordedAt: Timestamp;
  confirmation: "AUTHORIZE-ONE-CAPTURE-WITH-UNKNOWN-RESPONSE-AND-QUOTA";
  artifactRootId: StableId;
  permissionScope: StableId;
  basePolicySha256: Sha256;
  recoveryPolicySha256: Sha256;
  credentialSha256: Sha256;
  originalRecordSha256: Sha256;
  storageSha256: Sha256;
  filesystemSha256: Sha256;
  nextRequest: FigmaCaptureRequest;
  nextResources: ResourceSnapshot;
  /**
   * @maxItems 32
   */
  resourceStates: CaptureRecoveryResource[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaIntakeManifest".
 */
export interface FigmaIntakeManifest {
  schemaVersion: SchemaVersion;
  format: "figma-rest-nodes-v1";
  selectionUrl: string;
  structure: Artifact;
  reference?: {
    artifact: Artifact;
    sourceNodeId: string;
    sourceBounds: Bounds;
    scale: number;
    pixelWidth: number;
    pixelHeight: number;
    colorSpace: "srgb" | "unknown";
  };
  /**
   * @maxItems 1024
   */
  assets: {
    imageRef: string;
    artifact: Artifact;
    rightsEvidenceId?: StableId;
  }[];
  /**
   * @maxItems 1024
   */
  fonts: {
    family: string;
    style: string;
    artifact: Artifact;
    rightsEvidenceId?: StableId;
  }[];
  declaredCapture?: {
    transport?: "figma-rest" | "figma-plugin";
    sourceVersion?: Version;
    capturedAt?: Timestamp;
    captureEndedAt?: Timestamp;
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaSourceMap".
 */
export interface FigmaSourceMap {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  snapshot: ArtifactReference;
  /**
   * @maxItems 20000
   */
  entries: {
    adapter: string;
    document: string;
    branch?: StableId;
    sourceNodeId: string;
    nodeId: StableId;
  }[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaConversionEvidence".
 */
export interface FigmaConversionEvidence {
  schemaVersion: SchemaVersion;
  adapter:
    "figma-offline-fixed-v1" | "figma-structure-fixed-v1" | "figma-offline-fixed-v2" | "figma-structure-fixed-v2";
  source: ArtifactReference;
  /**
   * @maxItems 200000
   */
  entries: {
    sourceNodeId: string;
    nodeId: StableId;
    sourcePointer: JsonPointer;
    outputPointer: JsonPointer;
    rule: "identity" | "fixed-layout" | "solid-appearance" | "node-kind" | "text-style" | "styled-ranges";
    value: JsonValue;
  }[];
  /**
   * @maxItems 200000
   */
  ignoredProperties: {
    pointer: JsonPointer;
    reason: "nonvisual-metadata";
  }[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SourceStatus".
 */
export interface SourceStatus {
  snapshotId: StableId;
  status: "unchanged" | "changed" | "node-removed" | "access-unavailable" | "unknown" | "not-checked";
  observedVersion?: Version;
  diagnosticIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReferenceBinding".
 */
export interface FigmaReferenceBinding {
  projectId: StableId;
  actorId: StableId;
  originalRequestId: StableId;
  originalJobId: StableId;
  originalRecordSha256: Sha256;
  originalReceiptSha256: Sha256;
  request: ArtifactReference;
  source: ArtifactReference;
  manifest: ArtifactReference;
  result: ArtifactReference;
  nodes: ArtifactReference;
  renderMap: ArtifactReference;
  fileKey: string;
  nodeId: string;
  sourceVersion: Version;
  bounds: Bounds;
  scale: 1;
  origin: "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
  acquisitionId: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReferenceProposal".
 */
export interface FigmaReferenceProposal {
  schemaVersion: SchemaVersion;
  format: "figma-reference-proposal-v1";
  approvalGeneration: number;
  previousApproval?: ArtifactReference;
  diagnosticPredecessor?: FigmaDiagnosticPredecessor;
  binding: FigmaReferenceBinding;
  capturePolicySha256: Sha256;
  referencePolicySha256: Sha256;
  limits: Budget;
  proofSha256: Sha256;
  urlExpiresAt?: Timestamp;
  /**
   * @maxItems 16
   */
  limitations:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaDiagnosticPredecessor".
 */
export interface FigmaDiagnosticPredecessor {
  jobId: StableId;
  recordSha256: Sha256;
  receiptSha256: Sha256;
  request: ArtifactReference;
  approval: ArtifactReference;
  evidence: ArtifactReference;
  policySha256: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Budget".
 */
export interface Budget {
  maxInputBytes: number;
  maxRasterPixels: number;
  maxExpandedNodes: number;
  maxDepth: number;
  maxSnapshotAssetBytes: number;
  maxAttempts: number;
  maxExternalCalls: number;
  maxOutputBytes: number;
  maxDurationMs: number;
  maxModelTokens: number;
  maxCostMicros: number;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReferenceApproval".
 */
export interface FigmaReferenceApproval {
  schemaVersion: SchemaVersion;
  proposal: FigmaReferenceProposal;
  confirmation: "APPROVE-ONE-SELECTED-REFERENCE" | "APPROVE-ONE-DIAGNOSTIC-REFERENCE";
  recordedAt: Timestamp;
  expiresAt: Timestamp;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReferenceRequest".
 */
export interface FigmaReferenceRequest {
  schemaVersion: SchemaVersion;
  binding: FigmaReferenceBinding;
  approval: ArtifactReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReferenceEvidence".
 */
export interface FigmaReferenceEvidence {
  schemaVersion: SchemaVersion;
  format: "figma-reference-evidence-v1";
  referenceDiagnostic?: ReferenceDiagnostic;
  request: FigmaReferenceRequest;
  startedAt: Timestamp;
  endedAt: Timestamp;
  deadline: Timestamp;
  referenceStatus: "complete" | "partial" | "unavailable";
  readiness: "not-evaluated";
  reference?: {
    artifact: ArtifactReference;
    bounds: Bounds;
    scale: 1;
    pixelWidth: number;
    pixelHeight: number;
    colorSpace: "srgb" | "unknown";
  };
  statusCode?: number;
  errorCode?: ErrorCode;
  nextEligibleAt?: Timestamp;
  retry?: "explicit-action-required" | "retry-after-unknown";
  usage: {
    localInputBytes: number;
    externalCalls: number;
    dnsQueries: number;
    networkReceivedBytes: number;
    networkBodyBytes: number;
    persistedBytes: number;
  };
  /**
   * @maxItems 32
   */
  missing: string[];
  /**
   * @maxItems 16
   */
  limitations:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceJobUsage".
 */
export interface ReferenceJobUsage {
  inputBytes: number;
  outputBytes: number;
  externalCalls: number;
  modelTokens: 0;
  costMicros: 0;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReferenceJobMetadata".
 */
export interface ReferenceJobMetadata {
  verification: "metadata-only";
  jobId: StableId;
  jobSha256: Sha256;
  status: JobStatus;
  attempt: number;
  errorCode?: ErrorCode;
  usage: ReferenceJobUsage;
  /**
   * @maxItems 1
   */
  effects:
    | []
    | [
        {
          id: "reference-image-get";
          state: "reserved" | "settled" | "no-effect" | "unknown";
          reserved: ReferenceJobUsage;
          actual?: ReferenceJobUsage;
        },
      ];
  /**
   * @maxItems 2
   */
  stages:
    | []
    | [
        {
          sha256: Sha256;
          byteLength: number;
          disposition: "retained" | "recovery-needed" | "authorized-abandoned";
        },
      ]
    | [
        {
          sha256: Sha256;
          byteLength: number;
          disposition: "retained" | "recovery-needed" | "authorized-abandoned";
        },
        {
          sha256: Sha256;
          byteLength: number;
          disposition: "retained" | "recovery-needed" | "authorized-abandoned";
        },
      ];
  receiptPresent: boolean;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NativeReferenceRecoveryPlanEnvelope".
 */
export interface NativeReferenceRecoveryPlanEnvelope {
  schemaVersion: SchemaVersion;
  operation: "reference-recovery-plan";
  projectId: StableId;
  requestId: StableId;
  status: "complete" | "failed" | "interrupted" | "cancelled";
  value?: ReferenceRecoveryPlan;
  reason?: ReferenceRecoveryPlanReason;
  inputAccounting?: ReferenceInputAccounting;
  error?: ContractError;
  inventoryFailure?: RetainedInventoryFailure;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "NativeReferenceEnvelope".
 */
export interface NativeReferenceEnvelope {
  schemaVersion: SchemaVersion;
  operation:
    | "reference-plan"
    | "reference-approve"
    | "reference-download"
    | "reference-inspect"
    | "reference-diagnostic-plan"
    | "reference-diagnostic-approve"
    | "reference-diagnostic-download"
    | "reference-diagnostic-inspect";
  projectId: StableId;
  requestId: StableId;
  inputAccounting?: ReferenceInputAccounting;
  referenceDiagnostic?: ReferenceDiagnostic;
  status: "complete" | "partial" | "failed" | "interrupted" | "cancelled" | "unavailable";
  value?: {
    phase: "proposed" | "approved" | "admitted" | "completed";
    consumed: boolean;
    proposal?: FigmaReferenceProposal;
    approval?: ArtifactReference;
    expiresAt?: Timestamp;
    job?: Job;
    evidence?: FigmaReferenceEvidence;
    receipt?: CommitReceipt;
    metadata?: ReferenceJobMetadata;
  };
  error?: ContractError;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Lease".
 */
export interface Lease {
  id: StableId;
  ownerId: StableId;
  resourceId: StableId;
  fencingToken: number;
  heartbeatAt: Timestamp;
  expiresAt: Timestamp;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Diagnostic".
 */
export interface Diagnostic {
  schemaVersion: SchemaVersion;
  id: StableId;
  code: ErrorCode;
  severity: "info" | "warning" | "error";
  message: string;
  operations: Operation[];
  nodeIds: StableId[];
  pointer?: JsonPointer;
  evidenceIds: StableId[];
  recovery: string;
  limit?: {
    measured: number;
    allowed: number;
    unit: "byte" | "pixel" | "node" | "depth" | "millisecond" | "attempt";
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Loss".
 */
export interface Loss {
  id: StableId;
  nodeId: StableId;
  sourceNodeId?: string;
  pointer: JsonPointer;
  support: "exact" | "approximated" | "opaque" | "unsupported";
  reason: string;
  /**
   * @minItems 1
   */
  operations: [Operation, ...Operation[]];
  recovery: string;
  evidenceIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "StageAssessment".
 */
export interface StageAssessment {
  stage: "schema-valid" | "dependency-resolved" | "renderable" | "exportable" | "implementation-ready";
  status: "pass" | "fail" | "not-evaluated" | "inconclusive";
  diagnosticIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DiagnosticReport".
 */
export interface DiagnosticReport {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  readiness: "ready" | "needs-review" | "blocked";
  assessments: StageAssessment[];
  diagnostics: Diagnostic[];
  losses: Loss[];
  waiverEventIds: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Revision".
 */
export interface Revision {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  designId: StableId;
  /**
   * @maxItems 2
   */
  parents: [] | [StableId] | [StableId, StableId];
  content: ArtifactReference;
  resources: ResourceLock;
  createdAt: Timestamp;
  actorId: StableId;
  changeSource: "import" | "manual" | "model-proposal" | "resource-change" | "merge" | "migration" | "detach";
  provenance: ArtifactReference;
  patchId?: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ExpectedBase".
 */
export interface ExpectedBase {
  expectedBaseRevision: StableId;
  /**
   * Strong quoted ETag of the base content. Both fields must resolve to the same base; F03/F08 enforce atomically.
   */
  ifMatch: string;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SemanticPatch".
 */
export interface SemanticPatch {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  designId: StableId;
  base: ExpectedBase;
  /**
   * @minItems 1
   * @maxItems 20000
   */
  operations: [SemanticOperation, ...SemanticOperation[]];
  actorId: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SemanticDiff".
 */
export interface SemanticDiff {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  before: ArtifactReference;
  after: ArtifactReference;
  changes: SemanticOperation[];
  conflicts: Diagnostic[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ApprovalContext".
 */
export interface ApprovalContext {
  projectId: StableId;
  designId: StableId;
  revision: ArtifactReference;
  resources: ResourceLock;
  target: "android" | "ios" | "web";
  repository: RepositoryIdentity;
  scenario: ArtifactReference;
  reference: ArtifactReference;
  renderProfile: ArtifactReference;
  validationPolicy: ArtifactReference;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "Waiver".
 */
export interface Waiver {
  diagnosticId: StableId;
  reason: string;
  instructions: string;
  scope: "noncritical-mapping" | "decorative-asset-fallback" | "reviewed-limitation";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReviewEvent".
 */
export interface ReviewEvent {
  schemaVersion: SchemaVersion;
  id: StableId;
  sequence: number;
  previousEvent: ArtifactReference | null;
  context: ApprovalContext;
  actor: {
    id: StableId;
    trust: "local-actor" | "authenticated-issuer";
    issuerId?: StableId;
  };
  createdAt: Timestamp;
  kind: "draft" | "in-review" | "changes-requested" | "approved" | "superseded" | "comment" | "waiver";
  nodeId?: StableId;
  imageRegion?: Bounds;
  comment?: string;
  waivers: Waiver[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RenderProfile".
 */
export interface RenderProfile {
  schemaVersion: SchemaVersion;
  id: StableId;
  renderer: ToolIdentity;
  browser: ToolIdentity;
  host: HostIdentity;
  viewport: Bounds;
  deviceScale: number;
  locale: string;
  theme: StableId;
  colorSpace: "srgb";
  fontHashes: ArtifactReference[];
  assetHashes: ArtifactReference[];
  frozenTime: Timestamp;
  state: PropertyValues;
  capture: CaptureRegion;
  motion: "disabled";
  network: "deny";
  fontFallback: "forbidden" | "inspection-with-diagnostics";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ToolIdentity".
 */
export interface ToolIdentity {
  name: string;
  version: Version;
  sha256?: Sha256;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "HostIdentity".
 */
export interface HostIdentity {
  os: "windows" | "macos" | "linux" | "synthetic";
  version: Version;
  architecture: "x64" | "arm64" | "synthetic";
  evidence: "observed" | "declared" | "unverified" | "test-fake";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "BoundsMap".
 */
export interface BoundsMap {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  renderId: StableId;
  revision: ArtifactReference;
  preview: ArtifactReference;
  profile: ArtifactReference;
  nodes: {
    [k: string]: {
      localBounds: Bounds;
      measuredBounds: Bounds;
      sourceAbsoluteBounds?: Bounds;
      transform: Transform;
      clipChain: StableId[];
      paintOrder: number;
      overflow: boolean;
      evidence: "renderer-measurement";
    };
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureScenario".
 */
export interface CaptureScenario {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  platform: "android" | "ios-simulator" | "ios-device";
  applicationId: string;
  repositoryId: StableId;
  fixture: ArtifactReference;
  deviceProfileId: StableId;
  expectedScreenId: StableId;
  requiredControls: RequiredControl[];
  locale: string;
  theme: StableId;
  fontScale: number;
  orientation: "portrait" | "landscape";
  fonts: ArtifactReference[];
  navigate: {
    kind: "test-route" | "deep-link" | "test-adapter";
    routeId: StableId;
    deepLink?: string;
  };
  wait: {
    method: "app-signal" | "test-adapter" | "image-stability-heuristic";
    signal: StableId;
    stableFrames: number;
    intervalMs: number;
    timeoutMs: number;
    maxAttempts: number;
  };
  capture: CaptureRegion;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RequiredControl".
 */
export interface RequiredControl {
  nodeId: StableId;
  label: string;
  state: ControlState;
  critical: boolean;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ReadinessReceipt".
 */
export interface ReadinessReceipt {
  schemaVersion: SchemaVersion;
  runNonce: StableId;
  scenario: ArtifactReference;
  fixture: ArtifactReference;
  applicationId: string;
  buildId: StableId;
  screenId: StableId;
  status: "loading" | "ready" | "error";
  generation: number;
  foreground: boolean;
  focused: boolean;
  fontsReady: boolean;
  assetsReady: boolean;
  layoutReady: boolean;
  controls: RequiredControl[];
  viewport: Bounds;
  error?: ContractError;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "CaptureMetadata".
 */
export interface CaptureMetadata {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  jobId: StableId;
  runNonce: StableId;
  device: DeviceIdentity;
  applicationId: string;
  build: {
    id: StableId;
    repository: RepositoryIdentity;
    artifact: ArtifactReference;
    installationReceipt: ArtifactReference;
  };
  scenario: ArtifactReference;
  reference: ArtifactReference;
  capturedAt: Timestamp;
  raw: Artifact;
  normalized?: Artifact;
  profileEvidence:
    | {
        status: "measured";
        pixelRatio: number;
        pixelBounds: Bounds;
        logicalBounds: Bounds;
        capture: CaptureRegion;
        evidenceId: StableId;
      }
    | {
        status: "unknown";
        reason: string;
      };
  screenEvidence: {
    status: "verified" | "wrong-screen" | "unverified" | "changed-during-capture";
    method: "app-signal" | "test-adapter" | "image-stability-heuristic" | "none";
    before?: ReadinessReceipt;
    after?: ReadinessReceipt;
  };
  locale: string;
  theme: StableId;
  fontScale: number;
  orientation: "portrait" | "landscape";
  tools: ToolIdentity[];
  normalization: {
    status: "not-applied" | "applied" | "unavailable";
    uniformScale?: number;
    rotation?: 0 | 90 | 180 | 270;
    contentCrop?: Bounds;
    colorConversion: "none-srgb" | "unverified" | "unsupported";
    resampling: "none" | "nearest" | "bilinear";
    alphaBackground?: Color;
  };
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DeviceIdentity".
 */
export interface DeviceIdentity {
  id: StableId;
  platform: "android-emulator" | "android-device" | "ios-simulator" | "ios-device";
  model: string;
  osVersion: Version;
  state: "available" | "offline" | "unauthorized" | "locked" | "unknown";
  serverId: StableId;
  ownership: "explicitly-authorized" | "unverified";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ValidationPolicy".
 */
export interface ValidationPolicy {
  schemaVersion: SchemaVersion;
  id: "mobile-static-v1";
  pixel: {
    predicate: "max-absolute-srgb-channel-delta";
    operator: ">";
    threshold: 0.06274509803921569;
  };
  globalChangedFraction: {
    operator: ">";
    threshold: 0.01;
  };
  criticalChangedFraction: {
    operator: ">";
    threshold: 0.005;
  };
  exactGeometry: {
    operator: ">";
    threshold: 2;
    unit: "design-unit";
    evidence: "actual-view-hierarchy";
  };
  ssim: "diagnostic-only";
  calibration: "unverified" | "calibrated";
  calibrationEvidence?: ArtifactReference;
  background: Color;
  maxMaskedAreaFraction: number;
  requiredLabelsAndStates: "exact-match-when-measured";
  regionDenominator: "region-unmasked-pixels";
  missingEvidence: "inconclusive";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ComparisonRegion".
 */
export interface ComparisonRegion {
  id: StableId;
  referenceBounds: Bounds;
  nodeIds: StableId[];
  critical: boolean;
  authority: "trusted-reference-geometry" | "reviewed-annotation";
  evidenceId: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ValidationReport".
 */
export interface ValidationReport {
  schemaVersion: SchemaVersion;
  id: StableId;
  projectId: StableId;
  bundleId: Sha256;
  policyId: StableId;
  comparison: "source-to-preview" | "approved-reference-to-app";
  status: "pass" | "fail" | "inconclusive";
  scope: "visual-only" | "visual-and-geometry" | "visual-geometry-accessibility";
  reference: ArtifactReference;
  actual: ArtifactReference;
  scenario: ArtifactReference;
  coverage: {
    pixels: Measurement;
    geometry: Measurement;
    labelsAndStates: Measurement;
    accessibility: Measurement;
    interaction: Measurement;
    componentReuse: Measurement;
    maskedAreaFraction: number;
  };
  metrics?: PixelMetrics;
  regions: {
    region: ComparisonRegion;
    status: "pass" | "fail" | "inconclusive";
    metrics?: PixelMetrics;
    geometryDelta?: number;
    diagnosticIds: StableId[];
  }[];
  masks: {
    bounds: Bounds;
    reason: string;
    owner: StableId;
    reviewEventId: StableId;
    areaFraction: number;
  }[];
  diagnosticIds: StableId[];
  artifacts: Artifact[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "PixelMetrics".
 */
export interface PixelMetrics {
  eligiblePixels: number;
  changedPixels: number;
  changedFraction: number;
  implementation: ToolIdentity;
  ssim?: number;
  ssimImplementation?: ToolIdentity;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ImplementationPlan".
 */
export interface ImplementationPlan {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  target: "android" | "ios" | "web";
  repository: RepositoryIdentity;
  readiness: "ready" | "needs-review" | "blocked";
  usage: DependencyDeclaration;
  requiredControls: RequiredControl[];
  behavior: Behavior[];
  unresolved: Diagnostic[];
  constraints: string[];
  maxCorrectionAttempts: number;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "HandoffMetadata".
 */
export interface HandoffMetadata {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  designId: StableId;
  source: SourceSnapshot;
  provenance: ProvenanceSnapshot;
  renderProfile: RenderProfile;
  capture: CaptureRegion;
  resources: ResourceLock;
  referenceOrigin: "unchanged-source-snapshot" | "approved-edited-render" | "unapproved-draft";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "AuthorizationContext".
 */
export interface AuthorizationContext {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  actorId: StableId;
  sessionId: StableId;
  expiresAt: Timestamp;
  grants: {
    resourceKind:
      "design" | "revision" | "artifact" | "job" | "device" | "repository" | "source" | "credential" | "provider";
    resourceId: StableId;
    /**
     * @minItems 1
     */
    operations: [Operation, ...Operation[]];
  }[];
  egress: "deny" | "explicit-grant-required";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationRevisionResponseData".
 */
export interface FoundationRevisionResponseData {
  kind: "revision";
  warnings: Diagnostic[];
  revision: Revision;
  design: DesignIR;
  receipt?: CommitReceipt;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationHelpResponseData".
 */
export interface FoundationHelpResponseData {
  kind: "help";
  warnings: Diagnostic[];
  /**
   * Fixed command registry name, never echoed arbitrary argv. F08 validates registry membership.
   */
  command: string;
  /**
   * Usage generated from the fixed command registry, not user input.
   */
  usage: string;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationVersionResponseData".
 */
export interface FoundationVersionResponseData {
  kind: "version";
  warnings: Diagnostic[];
  cliVersion: Version;
  contractVersion: Version;
  apiVersion: "v1";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationApiDescriptionResponseData".
 */
export interface FoundationApiDescriptionResponseData {
  kind: "api-description";
  warnings: Diagnostic[];
  openapiVersion: "3.1.0";
  apiVersion: "v1";
  documentSha256: Sha256;
  path: "/v1/openapi.json";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationServiceResponseData".
 */
export interface FoundationServiceResponseData {
  kind: "service";
  warnings: Diagnostic[];
  state: "stopped";
  projectId: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ProviderCapabilities".
 */
export interface ProviderCapabilities {
  schemaVersion: SchemaVersion;
  providerId: StableId;
  projectId: StableId;
  implementation: "production" | "test-fake";
  host: HostIdentity;
  operations: {
    operation: string;
    availability: "available" | "unavailable" | "unverified" | "action-required";
    evidence: "observed" | "documented" | "test-fake" | "unverified";
    limitations: string[];
    error?: ContractError;
    retryAfter?: Timestamp;
  }[];
  cancellation: "cooperative" | "unsupported";
  deadline: "required";
  limits: Budget;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "OperationRequestContext".
 */
export interface OperationRequestContext {
  schemaVersion: SchemaVersion;
  projectId: StableId;
  requestId: StableId;
  jobId?: StableId;
  deadline: Timestamp;
  budget: Budget;
  authorization: AuthorizationContext;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FigmaReadRequest".
 */
export interface FigmaReadRequest {
  fileKey: StableId;
  branchKey?: StableId;
  nodeId: string;
  version: Version;
  authorizedDependencyIds?: StableId[];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "PluginSnapshotRequest".
 */
export interface PluginSnapshotRequest {
  artifact: Artifact;
  binding: FigmaBinding;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationAcceptFixtureRequest".
 */
export interface FoundationAcceptFixtureRequest {
  fixtureId: StableId;
  branch: StableId;
  base: ExpectedBase | null;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationRenderSubmissionRequest".
 */
export interface FoundationRenderSubmissionRequest {
  revision: ArtifactReference;
  base: ExpectedBase;
  mode: "strict" | "inspection";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FoundationCancelJobRequest".
 */
export interface FoundationCancelJobRequest {}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RenderRequest".
 */
export interface RenderRequest {
  design: DesignIR;
  resources: ResourceSnapshot;
  revision: ArtifactReference;
  profile: RenderProfile;
  mode: "strict" | "inspection";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "RenderResult".
 */
export interface RenderResult {
  renderId: StableId;
  preview: Artifact;
  boundsMap: BoundsMap;
  profile: RenderProfile;
  diagnostics: DiagnosticReport;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DeviceRequest".
 */
export interface DeviceRequest {
  deviceId: StableId;
  scenarioId: StableId;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "DeviceScenarioRequest".
 */
export interface DeviceScenarioRequest {
  deviceId: StableId;
  scenario: CaptureScenario;
  runNonce: StableId;
  lease: Lease;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ProcessRequest".
 */
export interface ProcessRequest {
  toolId: StableId;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  shell: false;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FileRequest".
 */
export interface FileRequest {
  artifactRootId: StableId;
  path: RelativePath;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ModelCapabilities".
 */
export interface ModelCapabilities {
  schemaVersion: SchemaVersion;
  providerId: StableId;
  modelId: StableId;
  version: Version;
  vision: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  usageReporting: boolean;
  costReporting: boolean;
  retention: string;
  residency: string;
  cancellation: "cooperative" | "unsupported";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ModelRequest".
 */
export interface ModelRequest {
  schemaVersion: SchemaVersion;
  providerId: StableId;
  modelId: StableId;
  evidence: ArtifactReference[];
  egressDecisionId: StableId;
  outputContract: string;
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "IndexRequest".
 */
export interface IndexRequest {
  schemaVersion: SchemaVersion;
  repository: RepositoryIdentity;
  rootId: StableId;
  paths: RelativePath[];
  executeSource: false;
  egress: "deny";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "SemanticCase".
 */
export interface SemanticCase {
  id: StableId;
  owner: "F02" | "F03" | "F04" | "F05" | "F06" | "F07" | "F08" | "later-integration";
  requirement: string;
  expected: string;
  evidence: "contract-only-not-executed";
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "FixtureManifest".
 */
export interface FixtureManifest {
  schemaVersion: SchemaVersion;
  id: StableId;
  provenance: string;
  files: Artifact[];
  /**
   * @minItems 5
   * @maxItems 5
   */
  cases: [
    {
      id: StableId;
      design: RelativePath;
      resources: RelativePath;
      provenance: RelativePath;
      diagnostics: RelativePath;
      /**
       * @minItems 1
       */
      semanticExpectations: [SemanticCase, ...SemanticCase[]];
    },
    {
      id: StableId;
      design: RelativePath;
      resources: RelativePath;
      provenance: RelativePath;
      diagnostics: RelativePath;
      /**
       * @minItems 1
       */
      semanticExpectations: [SemanticCase, ...SemanticCase[]];
    },
    {
      id: StableId;
      design: RelativePath;
      resources: RelativePath;
      provenance: RelativePath;
      diagnostics: RelativePath;
      /**
       * @minItems 1
       */
      semanticExpectations: [SemanticCase, ...SemanticCase[]];
    },
    {
      id: StableId;
      design: RelativePath;
      resources: RelativePath;
      provenance: RelativePath;
      diagnostics: RelativePath;
      /**
       * @minItems 1
       */
      semanticExpectations: [SemanticCase, ...SemanticCase[]];
    },
    {
      id: StableId;
      design: RelativePath;
      resources: RelativePath;
      provenance: RelativePath;
      diagnostics: RelativePath;
      /**
       * @minItems 1
       */
      semanticExpectations: [SemanticCase, ...SemanticCase[]];
    },
  ];
}
/**
 * This interface was referenced by `ContractCatalog`'s JSON-Schema
 * via the `definition` "ContractExamples".
 */
export interface ContractExamples {
  schemaVersion: SchemaVersion;
  artifacts: {
    contract: string;
    value: JsonValue;
  }[];
}
