import type {
  Artifact,
  ArtifactReference,
  Bounds,
  CaptureMetadata,
  CommitReceipt,
  CredentialReference,
  DesignIR,
  DeviceIdentity,
  DeviceRequest,
  DeviceScenarioRequest,
  FigmaReadRequest,
  FileRequest,
  IndexRequest,
  JsonValue,
  ModelCapabilities,
  ModelRequest,
  OperationRequestContext,
  PluginSnapshotRequest,
  ProcessRequest,
  ProviderCapabilities,
  ProviderOutcome,
  ReadinessReceipt,
  RenderRequest,
  RenderResult,
  SourceSnapshot,
  TargetCodeMapping,
  ToolIdentity,
} from "./generated.js";

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface OperationContext extends OperationRequestContext {
  signal: AbortSignal;
  clock: Clock;
}

type Complete = Extract<ProviderOutcome, { status: "complete" }>;
type Partial = Extract<ProviderOutcome, { status: "partial" }>;
export type Outcome<T> =
  | (Omit<Complete, "value"> & { value: T })
  | (Omit<Partial, "value"> & { value: T })
  | Exclude<ProviderOutcome, Complete | Partial>;

export interface FigmaProvider {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ProviderCapabilities>;
  readSnapshot(
    request: FigmaReadRequest,
    context: OperationContext,
  ): Promise<Outcome<SourceSnapshot>>;
  acceptPluginSnapshot(
    request: PluginSnapshotRequest,
    context: OperationContext,
  ): Promise<Outcome<SourceSnapshot>>;
}

export interface Renderer {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ProviderCapabilities>;
  render(
    request: RenderRequest,
    context: OperationContext,
  ): Promise<Outcome<RenderResult>>;
}

export interface PngBytes {
  mediaType: "image/png";
  bytes: Uint8Array;
}

export interface CapturedPng extends PngBytes {
  metadata: CaptureMetadata;
}

export interface DeviceProvider {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ProviderCapabilities>;
  listDevices(context: OperationContext): Promise<Outcome<DeviceIdentity[]>>;
  launchApp(
    request: DeviceScenarioRequest,
    context: OperationContext,
  ): Promise<Outcome<ReadinessReceipt>>;
  openDeepLink(
    request: DeviceScenarioRequest,
    context: OperationContext,
  ): Promise<Outcome<ReadinessReceipt>>;
  waitForIdle(
    request: DeviceScenarioRequest,
    context: OperationContext,
  ): Promise<Outcome<ReadinessReceipt>>;
  captureScreenshot(
    request: DeviceRequest,
    context: OperationContext,
  ): Promise<Outcome<CapturedPng>>;
  getViewport(
    request: DeviceRequest,
    context: OperationContext,
  ): Promise<Outcome<Bounds>>;
  getMetadata(
    request: DeviceRequest,
    context: OperationContext,
  ): Promise<Outcome<DeviceIdentity>>;
}

export interface LocatedTool {
  identity: ToolIdentity;
  executable: string;
  hostSupported: boolean;
}

export interface ToolLocator {
  locate(
    toolId: string,
    context: OperationContext,
  ): Promise<Outcome<LocatedTool>>;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
}

export interface ProcessRunner {
  run(
    request: ProcessRequest,
    context: OperationContext,
  ): Promise<Outcome<ProcessResult>>;
}

export interface StagedArtifact {
  stagingId: string;
  artifact: Artifact;
}

export interface FileSystemBoundary {
  read(
    request: FileRequest,
    context: OperationContext,
  ): Promise<Outcome<Uint8Array>>;
  stage(
    request: FileRequest,
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<StagedArtifact>>;
  publish(
    staged: StagedArtifact,
    context: OperationContext,
  ): Promise<Outcome<Artifact>>;
  discard(
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<{ discarded: true }>>;
}

export interface CredentialStore {
  use<T>(
    reference: CredentialReference,
    context: OperationContext,
    consumer: (secret: Uint8Array) => Promise<T>,
  ): Promise<Outcome<T>>;
}

export interface ArtifactStore {
  verify(
    reference: ArtifactReference,
    context: OperationContext,
  ): Promise<Outcome<Artifact>>;
  commit(
    outputs: StagedArtifact[],
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt>>;
}

export interface DesignModelProvider {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ModelCapabilities>;
  propose(
    request: ModelRequest,
    context: OperationContext,
  ): Promise<Outcome<DesignIR>>;
}

export interface VisionModelProvider {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ModelCapabilities>;
  analyze(
    request: ModelRequest,
    context: OperationContext,
  ): Promise<Outcome<JsonValue>>;
}

export interface EmbeddingProvider {
  readonly contractVersion: "1.0";
  getCapabilities(context: OperationContext): Promise<ModelCapabilities>;
  embed(
    request: ModelRequest,
    context: OperationContext,
  ): Promise<Outcome<number[][]>>;
}

export interface RepositoryIndexer {
  readonly contractVersion: "1.0";
  index(
    request: IndexRequest,
    context: OperationContext,
  ): Promise<Outcome<TargetCodeMapping[]>>;
}
