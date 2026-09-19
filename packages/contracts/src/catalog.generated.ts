/* Generated from schemas/foundation.schema.json. Do not edit. */
import type * as Types from "./generated.js";

export interface ContractTypes {
  SchemaVersion: Types.SchemaVersion;
  StableId: Types.StableId;
  Sha256: Types.Sha256;
  Version: Types.Version;
  Timestamp: Types.Timestamp;
  JsonPointer: Types.JsonPointer;
  RelativePath: Types.RelativePath;
  JsonValue: Types.JsonValue;
  JsonArray: Types.JsonArray;
  JsonObject: Types.JsonObject;
  Extensions: Types.Extensions;
  Artifact: Types.Artifact;
  ArtifactReference: Types.ArtifactReference;
  Point: Types.Point;
  Bounds: Types.Bounds;
  Transform: Types.Transform;
  TokenReference: Types.TokenReference;
  Dimension: Types.Dimension;
  SignedLength: Types.SignedLength;
  Size: Types.Size;
  Insets: Types.Insets;
  Layout: Types.Layout;
  Color: Types.Color;
  Paint: Types.Paint;
  Shadow: Types.Shadow;
  Clip: Types.Clip;
  Appearance: Types.Appearance;
  Typography: Types.Typography;
  StyledRange: Types.StyledRange;
  ControlState: Types.ControlState;
  Accessibility: Types.Accessibility;
  Behavior: Types.Behavior;
  NodeMetadata: Types.NodeMetadata;
  VisualBinding: Types.VisualBinding;
  ContainerNode: Types.ContainerNode;
  ScrollNode: Types.ScrollNode;
  TextNode: Types.TextNode;
  ImageNode: Types.ImageNode;
  ShapeNode: Types.ShapeNode;
  SimpleNode: Types.SimpleNode;
  ComponentReference: Types.ComponentReference;
  PropertyValue: Types.PropertyValue;
  PropertyValues: Types.PropertyValues;
  ComponentNode: Types.ComponentNode;
  UnsupportedNode: Types.UnsupportedNode;
  DesignNode: Types.DesignNode;
  ResourceLock: Types.ResourceLock;
  DesignIR: Types.DesignIR;
  PropertyDefinition: Types.PropertyDefinition;
  SlotDefinition: Types.SlotDefinition;
  VisualDefinition: Types.VisualDefinition;
  DependencyDeclaration: Types.DependencyDeclaration;
  RepositoryIdentity: Types.RepositoryIdentity;
  MappingState: Types.MappingState;
  TypedAdapter: Types.TypedAdapter;
  TargetCodeMapping: Types.TargetCodeMapping;
  TokenValue: Types.TokenValue;
  TokenDefinition: Types.TokenDefinition;
  TokenResolution: Types.TokenResolution;
  LicenseEvidence: Types.LicenseEvidence;
  AssetResource: Types.AssetResource;
  FontResource: Types.FontResource;
  ComponentSnapshot: Types.ComponentSnapshot;
  TokenSnapshot: Types.TokenSnapshot;
  ResourceSnapshot: Types.ResourceSnapshot;
  Evidence: Types.Evidence;
  ProvenanceEntry: Types.ProvenanceEntry;
  ProvenanceSnapshot: Types.ProvenanceSnapshot;
  FigmaBinding: Types.FigmaBinding;
  SourceIdentity: Types.SourceIdentity;
  SourceSnapshot: Types.SourceSnapshot;
  FigmaCaptureRequest: Types.FigmaCaptureRequest;
  FigmaCaptureManifest: Types.FigmaCaptureManifest;
  FigmaCaptureResult: Types.FigmaCaptureResult;
  FigmaIntakeManifest: Types.FigmaIntakeManifest;
  FigmaSourceMap: Types.FigmaSourceMap;
  FigmaConversionEvidence: Types.FigmaConversionEvidence;
  SourceStatus: Types.SourceStatus;
  Operation: Types.Operation;
  Diagnostic: Types.Diagnostic;
  Loss: Types.Loss;
  StageAssessment: Types.StageAssessment;
  DiagnosticReport: Types.DiagnosticReport;
  Revision: Types.Revision;
  ExpectedBase: Types.ExpectedBase;
  SemanticOperation: Types.SemanticOperation;
  SemanticPatch: Types.SemanticPatch;
  SemanticDiff: Types.SemanticDiff;
  ApprovalContext: Types.ApprovalContext;
  Waiver: Types.Waiver;
  ReviewEvent: Types.ReviewEvent;
  CaptureRegion: Types.CaptureRegion;
  RenderProfile: Types.RenderProfile;
  ToolIdentity: Types.ToolIdentity;
  HostIdentity: Types.HostIdentity;
  BoundsMap: Types.BoundsMap;
  CaptureScenario: Types.CaptureScenario;
  RequiredControl: Types.RequiredControl;
  ReadinessReceipt: Types.ReadinessReceipt;
  CaptureMetadata: Types.CaptureMetadata;
  DeviceIdentity: Types.DeviceIdentity;
  ValidationPolicy: Types.ValidationPolicy;
  Measurement: Types.Measurement;
  ComparisonRegion: Types.ComparisonRegion;
  ValidationReport: Types.ValidationReport;
  PixelMetrics: Types.PixelMetrics;
  ImplementationPlan: Types.ImplementationPlan;
  HandoffMetadata: Types.HandoffMetadata;
  HandoffManifest: Types.HandoffManifest;
  ErrorCode: Types.ErrorCode;
  ContractError: Types.ContractError;
  Budget: Types.Budget;
  AuthorizationContext: Types.AuthorizationContext;
  IdempotencyScope: Types.IdempotencyScope;
  Lease: Types.Lease;
  CommitReceipt: Types.CommitReceipt;
  JobStatus: Types.JobStatus;
  Job: Types.Job;
  JobVersion: Types.JobVersion;
  FoundationRevisionResponseData: Types.FoundationRevisionResponseData;
  FoundationHelpResponseData: Types.FoundationHelpResponseData;
  FoundationVersionResponseData: Types.FoundationVersionResponseData;
  FoundationApiDescriptionResponseData: Types.FoundationApiDescriptionResponseData;
  FoundationServiceResponseData: Types.FoundationServiceResponseData;
  LegacyResponseData: Types.LegacyResponseData;
  ResponseEnvelope: Types.ResponseEnvelope;
  FoundationVersionedJobResponse: Types.FoundationVersionedJobResponse;
  ProviderCapabilities: Types.ProviderCapabilities;
  OperationRequestContext: Types.OperationRequestContext;
  ProviderOutcome: Types.ProviderOutcome;
  FigmaReadRequest: Types.FigmaReadRequest;
  PluginSnapshotRequest: Types.PluginSnapshotRequest;
  FoundationAcceptFixtureRequest: Types.FoundationAcceptFixtureRequest;
  FoundationRenderSubmissionRequest: Types.FoundationRenderSubmissionRequest;
  FoundationCancelJobRequest: Types.FoundationCancelJobRequest;
  RenderRequest: Types.RenderRequest;
  RenderResult: Types.RenderResult;
  DeviceRequest: Types.DeviceRequest;
  DeviceScenarioRequest: Types.DeviceScenarioRequest;
  ProcessRequest: Types.ProcessRequest;
  FileRequest: Types.FileRequest;
  CredentialReference: Types.CredentialReference;
  ModelCapabilities: Types.ModelCapabilities;
  ModelRequest: Types.ModelRequest;
  IndexRequest: Types.IndexRequest;
  SemanticCase: Types.SemanticCase;
  FixtureManifest: Types.FixtureManifest;
  ContractExamples: Types.ContractExamples;
}

export type ContractName = keyof ContractTypes;

export const contractNames: readonly ContractName[] = [
  "SchemaVersion",
  "StableId",
  "Sha256",
  "Version",
  "Timestamp",
  "JsonPointer",
  "RelativePath",
  "JsonValue",
  "JsonArray",
  "JsonObject",
  "Extensions",
  "Artifact",
  "ArtifactReference",
  "Point",
  "Bounds",
  "Transform",
  "TokenReference",
  "Dimension",
  "SignedLength",
  "Size",
  "Insets",
  "Layout",
  "Color",
  "Paint",
  "Shadow",
  "Clip",
  "Appearance",
  "Typography",
  "StyledRange",
  "ControlState",
  "Accessibility",
  "Behavior",
  "NodeMetadata",
  "VisualBinding",
  "ContainerNode",
  "ScrollNode",
  "TextNode",
  "ImageNode",
  "ShapeNode",
  "SimpleNode",
  "ComponentReference",
  "PropertyValue",
  "PropertyValues",
  "ComponentNode",
  "UnsupportedNode",
  "DesignNode",
  "ResourceLock",
  "DesignIR",
  "PropertyDefinition",
  "SlotDefinition",
  "VisualDefinition",
  "DependencyDeclaration",
  "RepositoryIdentity",
  "MappingState",
  "TypedAdapter",
  "TargetCodeMapping",
  "TokenValue",
  "TokenDefinition",
  "TokenResolution",
  "LicenseEvidence",
  "AssetResource",
  "FontResource",
  "ComponentSnapshot",
  "TokenSnapshot",
  "ResourceSnapshot",
  "Evidence",
  "ProvenanceEntry",
  "ProvenanceSnapshot",
  "FigmaBinding",
  "SourceIdentity",
  "SourceSnapshot",
  "FigmaCaptureRequest",
  "FigmaCaptureManifest",
  "FigmaCaptureResult",
  "FigmaIntakeManifest",
  "FigmaSourceMap",
  "FigmaConversionEvidence",
  "SourceStatus",
  "Operation",
  "Diagnostic",
  "Loss",
  "StageAssessment",
  "DiagnosticReport",
  "Revision",
  "ExpectedBase",
  "SemanticOperation",
  "SemanticPatch",
  "SemanticDiff",
  "ApprovalContext",
  "Waiver",
  "ReviewEvent",
  "CaptureRegion",
  "RenderProfile",
  "ToolIdentity",
  "HostIdentity",
  "BoundsMap",
  "CaptureScenario",
  "RequiredControl",
  "ReadinessReceipt",
  "CaptureMetadata",
  "DeviceIdentity",
  "ValidationPolicy",
  "Measurement",
  "ComparisonRegion",
  "ValidationReport",
  "PixelMetrics",
  "ImplementationPlan",
  "HandoffMetadata",
  "HandoffManifest",
  "ErrorCode",
  "ContractError",
  "Budget",
  "AuthorizationContext",
  "IdempotencyScope",
  "Lease",
  "CommitReceipt",
  "JobStatus",
  "Job",
  "JobVersion",
  "FoundationRevisionResponseData",
  "FoundationHelpResponseData",
  "FoundationVersionResponseData",
  "FoundationApiDescriptionResponseData",
  "FoundationServiceResponseData",
  "LegacyResponseData",
  "ResponseEnvelope",
  "FoundationVersionedJobResponse",
  "ProviderCapabilities",
  "OperationRequestContext",
  "ProviderOutcome",
  "FigmaReadRequest",
  "PluginSnapshotRequest",
  "FoundationAcceptFixtureRequest",
  "FoundationRenderSubmissionRequest",
  "FoundationCancelJobRequest",
  "RenderRequest",
  "RenderResult",
  "DeviceRequest",
  "DeviceScenarioRequest",
  "ProcessRequest",
  "FileRequest",
  "CredentialReference",
  "ModelCapabilities",
  "ModelRequest",
  "IndexRequest",
  "SemanticCase",
  "FixtureManifest",
  "ContractExamples"
];
