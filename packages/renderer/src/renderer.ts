import {
  AssetError,
  decodeRaster,
  type RightsAuthority,
} from "@design-studio/assets";
import {
  type Artifact,
  type ArtifactReference,
  type Budget,
  type CommitReceipt,
  ContractBoundaryError,
  DEFAULT_BUDGETS,
  type ErrorCode,
  type FileSystemBoundary,
  type OperationContext,
  type Outcome,
  type Renderer,
  type RenderRequest,
  type RenderResult,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
  KernelError,
} from "@design-studio/design-ir";
import {
  type Authority,
  boundary,
  HostBoundaryError,
  OperationGuard,
  snapshotOperationContext,
} from "@design-studio/host";
import type {
  CleanupReport,
  RendererWorkerHost,
  RendererWorkerLease,
} from "@design-studio/renderer-host";
import { validateFaces } from "./faces.js";
import { children } from "./layout.js";
import { installedBuildIdentity } from "./profile.js";
import { type AcceptedInputs, prepareInputs } from "./resources.js";
import { encodeResourceWire, logicalBytes } from "./wire.js";

export interface RenderEvidence {
  version: 1;
  artifactRootId: string;
  revision: ArtifactReference;
  acceptedDesignSha256: string;
  resourceSnapshotSha256: string;
  artifacts: {
    role:
      | "preview"
      | "profile"
      | "expanded-input"
      | "bounds"
      | "diagnostics"
      | "render-evidence";
    artifact: Artifact;
    mediaType: "image/png" | "application/json";
  }[];
}
export interface StagedRender {
  outcome: Outcome<RenderResult>;
  staged: StagedArtifact[];
  evidence?: RenderEvidence;
  cleanup?: Outcome<CleanupReport>;
  recoveryRequired: boolean;
  stageFailure?: Exclude<Outcome<StagedArtifact>, { status: "complete" }>;
  executionFailure?: { code: ErrorCode; message: string };
}
export interface StagedRendererOptions {
  projectId: string;
  providerId: string;
  artifactRootId: string;
  authority: Authority;
  rightsAuthority: RightsAuthority;
  budgetLimits?: Readonly<Budget>;
  resolveInputs(
    request: RenderRequest,
    context: OperationContext,
  ): Promise<AcceptedInputs>;
  filesystem: Pick<FileSystemBoundary, "stage">;
  worker: Pick<RendererWorkerHost, "open">;
}
export interface RendererOptions extends StagedRendererOptions {
  observePreparation(
    preparation: StagedRender,
    context: OperationContext,
  ): Promise<void>;
  publish(
    preparation: StagedRender,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt>>;
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status === "complete") return outcome.value;
  throw new HostBoundaryError(
    outcome.error.code,
    outcome.error.message,
    outcome.status === "unavailable",
  );
}
const reference = (artifact: Artifact): ArtifactReference => ({
  id: artifact.id,
  sha256: artifact.sha256,
});
function freezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
export async function renderStaged(
  input: RenderRequest,
  originalContext: OperationContext,
  options: StagedRendererOptions,
): Promise<StagedRender> {
  const staged: StagedArtifact[] = [];
  let cleanup: Outcome<CleanupReport> | undefined;
  let evidence: RenderEvidence | undefined;
  let recoveryRequired = false;
  let executionFailure: StagedRender["executionFailure"];
  const failures: { stage?: StagedRender["stageFailure"] } = {};
  const outcome = await boundary(originalContext, async (context) => {
    const guard = new OperationGuard(
      context,
      {
        projectId: options.projectId,
        resourceKind: "provider",
        resourceId: options.providerId,
        operation: "execute",
      },
      options.authority,
      context.budget.maxDurationMs,
      options.budgetLimits ?? DEFAULT_BUDGETS,
    );
    context = guard.context;
    const build = await installedBuildIdentity();
    guard.check();
    if (!validateContract("RenderRequest", input).success)
      throw new HostBoundaryError("INVALID_INPUT", "Invalid render request.");
    const request = freezeJson(structuredClone(input));
    if (
      canonicalDigest(request.profile.renderer) !==
      canonicalDigest(build.renderer)
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Render profile does not pin this installed compiler.",
      );
    if (
      request.design.projectId !== context.projectId ||
      request.resources.projectId !== context.projectId
    )
      throw new HostBoundaryError("FORBIDDEN", "Cross-project render denied.");
    guard.consume("input", canonicalBytes(request).byteLength);
    const received = await options.resolveInputs(request, context);
    guard.check();
    const accepted: AcceptedInputs = {
      revision: structuredClone(received.revision),
      designBytes: Uint8Array.from(received.designBytes),
      resourceBytes: Uint8Array.from(received.resourceBytes),
      artifacts: received.artifacts.map((a) => ({
        artifact: structuredClone(a.artifact),
        bytes: Uint8Array.from(a.bytes),
      })),
    };
    const prepared = (() => {
      try {
        return prepareInputs(
          request,
          accepted,
          options.rightsAuthority,
          context.budget,
        );
      } catch (error) {
        if (error instanceof KernelError)
          throw new HostBoundaryError(error.diagnostic.code, error.message);
        if (
          error instanceof ContractBoundaryError ||
          error instanceof TypeError
        )
          throw new HostBoundaryError(
            "INVALID_SCHEMA",
            "Accepted render bytes are malformed.",
            false,
            { cause: error },
          );
        throw error;
      }
    })();
    guard.check();
    const wire = encodeResourceWire({
      version: 1,
      design: prepared.expanded,
      fonts: prepared.fonts,
      images: prepared.images,
      profile: request.profile,
      mode: request.mode,
      budget: context.budget,
    });
    if (logicalBytes(wire) > context.budget.maxInputBytes)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Logical render input exceeds request budget.",
      );
    guard.consume("input", wire.byteLength);
    let lease: RendererWorkerLease | undefined;
    let response: Uint8Array | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const opened = await options.worker.open(context);
      if (opened.status === "complete" || opened.status === "partial")
        lease = opened.value;
      unwrap(opened);
      if (!lease)
        throw new HostBoundaryError(
          "PROCESS_FAILED",
          "Missing owned worker lease.",
        );
      guard.check();
      response = unwrap(await lease.exchange(wire, context));
    } catch (error) {
      failure = { error };
      if (error instanceof HostBoundaryError)
        executionFailure = { code: error.code, message: error.message };
    }
    if (lease) cleanup = await lease.close();
    if (cleanup && cleanup.status !== "complete") {
      recoveryRequired = true;
      throw new HostBoundaryError(
        "INTERRUPTED",
        "Renderer worker cleanup could not be established.",
        false,
        { cause: failure?.error },
      );
    }
    if (failure) throw failure.error;
    if (cleanup?.status === "complete" && cleanup.value.terminalFailure)
      throw new HostBoundaryError(
        cleanup.value.terminalFailure.code,
        cleanup.value.terminalFailure.message,
      );
    if (!response)
      throw new HostBoundaryError("PROCESS_FAILED", "Missing worker response.");
    guard.check();
    guard.consume("output", response.byteLength);
    const raw: unknown = (() => {
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response),
        );
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError)
          throw new HostBoundaryError(
            "PROCESS_FAILED",
            "Worker response is not valid UTF-8 JSON.",
            false,
            { cause: error },
          );
        throw error;
      }
    })();
    if (typeof raw !== "object" || raw === null || !("ok" in raw))
      throw new HostBoundaryError("PROCESS_FAILED", "Invalid worker response.");
    if (raw.ok === false) {
      if (
        !("code" in raw) ||
        !validateContract("ErrorCode", raw.code).success ||
        !("message" in raw) ||
        typeof raw.message !== "string"
      )
        throw new HostBoundaryError(
          "PROCESS_FAILED",
          "Malformed worker failure.",
        );
      const code = validateContract("ErrorCode", raw.code);
      if (!code.success)
        throw new HostBoundaryError(
          "PROCESS_FAILED",
          "Malformed worker error code.",
        );
      throw new HostBoundaryError(code.value, raw.message);
    }
    if (
      raw.ok !== true ||
      !("png" in raw) ||
      typeof raw.png !== "string" ||
      !("profile" in raw) ||
      canonicalDigest(raw.profile) !== canonicalDigest(request.profile) ||
      !("nodes" in raw) ||
      !("fonts" in raw) ||
      !Array.isArray(raw.fonts) ||
      !("overflow" in raw) ||
      !Array.isArray(raw.overflow) ||
      !raw.overflow.every((id) => typeof id === "string")
    )
      throw new HostBoundaryError(
        "PROCESS_FAILED",
        "Incomplete or mismatched worker capture.",
      );
    const png = Buffer.from(raw.png, "base64");
    validateFaces(prepared.expanded.root, prepared.fonts, raw.fonts);
    if (png.toString("base64") !== raw.png)
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Malformed PNG encoding.",
      );
    const pixels = (() => {
      try {
        return decodeRaster(png, context.budget);
      } catch (error) {
        if (error instanceof AssetError)
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            `Invalid PNG capture: ${error.diagnostic.code}.`,
            false,
            { cause: error },
          );
        throw error;
      }
    })();
    if (
      pixels.width !==
        request.profile.capture.bounds.width * request.profile.deviceScale ||
      pixels.height !==
        request.profile.capture.bounds.height * request.profile.deviceScale
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Capture dimensions differ from profile.",
      );
    const renderId = `render_${canonicalDigest([request.revision, request.design.resources, request.profile, request.mode])}`;
    const report = structuredClone(prepared.report);
    for (const id of raw.overflow)
      report.diagnostics.push({
        schemaVersion: "1.0",
        operations: ["render"],
        id: `overflow_${canonicalDigest(id)}`,
        code: "INVALID_LAYOUT",
        severity: "error",
        message: "Measured content exceeds its allocation.",
        nodeIds: [id],
        evidenceIds: [],
        recovery:
          "Correct layout constraints or explicitly declare clipping/scroll intent.",
      });
    const blocked = report.diagnostics.some((d) => d.severity === "error");
    report.readiness = blocked ? "blocked" : "needs-review";
    report.assessments = report.assessments.map((assessment) =>
      assessment.stage === "renderable"
        ? {
            stage: "renderable",
            status: blocked ? "fail" : "pass",
            diagnosticIds: report.diagnostics
              .filter((d) => d.severity === "error")
              .map((d) => d.id),
          }
        : assessment,
    );
    if (blocked && request.mode === "strict")
      throw new HostBoundaryError(
        "INVALID_LAYOUT",
        "Strict render retains blocking diagnostics.",
      );
    const mapValidation = validateContract("BoundsMap", {
      schemaVersion: "1.0",
      projectId: context.projectId,
      renderId,
      revision: request.revision,
      preview: { id: "preview_validation", sha256: hashBytes(png) },
      profile: {
        id: request.profile.id,
        sha256: hashBytes(canonicalBytes(request.profile)),
      },
      nodes: raw.nodes,
    });
    if (!mapValidation.success)
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Invalid capture bounds map.",
      );
    const ids: string[] = [];
    function collect(node: RenderRequest["design"]["root"]) {
      ids.push(node.id);
      for (const child of children(node)) collect(child);
    }
    collect(prepared.expanded.root);
    const actualIds = Object.keys(mapValidation.value.nodes);
    if (
      canonicalDigest([...ids].sort()) !== canonicalDigest(actualIds.sort()) ||
      Object.values(mapValidation.value.nodes).some((n) =>
        n.clipChain.some((id) => !ids.includes(id)),
      )
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Incomplete node/clip correspondence.",
      );
    evidence = {
      version: 1,
      artifactRootId: options.artifactRootId,
      revision: request.revision,
      acceptedDesignSha256: hashBytes(accepted.designBytes),
      resourceSnapshotSha256: hashBytes(accepted.resourceBytes),
      artifacts: [],
    };
    async function stage(
      role: RenderEvidence["artifacts"][number]["role"],
      bytes: Uint8Array,
      mediaType: "image/png" | "application/json",
    ) {
      guard.check();
      guard.consume("output", bytes.byteLength);
      const sha256 = hashBytes(bytes);
      const result = await options.filesystem.stage(
        { artifactRootId: options.artifactRootId, path: `blobs/${sha256}` },
        bytes,
        context,
      );
      if (result.status !== "complete") {
        recoveryRequired = true;
        failures.stage = result;
        throw new HostBoundaryError(
          result.error.code,
          result.error.message,
          result.status === "unavailable",
        );
      }
      // Preserve the exact physical receipt; never replace its generic MIME with semantic media.
      staged.push(result.value);
      if (
        !validateContract("Artifact", result.value.artifact).success ||
        result.value.artifact.sha256 !== sha256 ||
        result.value.artifact.byteLength !== bytes.byteLength ||
        result.value.artifact.path !== `blobs/${sha256}`
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Stage receipt does not match actual render bytes.",
        );
      evidence?.artifacts.push({
        role,
        artifact: result.value.artifact,
        mediaType,
      });
      guard.check();
      return result.value.artifact;
    }
    const preview = await stage("preview", png, "image/png");
    const profile = await stage(
      "profile",
      canonicalBytes(request.profile),
      "application/json",
    );
    await stage(
      "expanded-input",
      canonicalBytes({
        kernel: build.kernel,
        renderer: request.profile.renderer,
        revision: request.revision,
        acceptedDesignSha256: evidence.acceptedDesignSha256,
        resourceSnapshotSha256: evidence.resourceSnapshotSha256,
        resources: request.resources,
        expanded: prepared.expanded,
        instances: prepared.instances,
      }),
      "application/json",
    );
    const boundsMap = {
      ...mapValidation.value,
      preview: reference(preview),
      profile: reference(profile),
    };
    await stage("bounds", canonicalBytes(boundsMap), "application/json");
    await stage("diagnostics", canonicalBytes(report), "application/json");
    await stage(
      "render-evidence",
      canonicalBytes({
        ...evidence,
        actualFaces: raw.fonts,
        fontInspections: prepared.fonts.map((f) => ({
          id: f.id,
          face: f.face,
        })),
        imageDerivatives: prepared.images.map((a) => ({
          id: a.id,
          sha256: a.sha256,
          mediaType: a.mediaType,
        })),
      }),
      "application/json",
    );
    const result: RenderResult = {
      renderId,
      preview,
      boundsMap,
      profile: request.profile,
      diagnostics: report,
    };
    if (!validateContract("RenderResult", result).success)
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Invalid staged render result.",
      );
    guard.check();
    return result;
  });
  const final: Outcome<RenderResult> =
    failures.stage && failures.stage.status !== "partial"
      ? failures.stage
      : outcome.status === "complete" &&
          outcome.value.diagnostics.readiness === "blocked"
        ? {
            ...outcome,
            status: "partial",
            missing: ["strict-render-fidelity"],
            error: {
              code:
                outcome.value.diagnostics.diagnostics.find(
                  (d) => d.severity === "error",
                )?.code ?? "VALIDATION_INCONCLUSIVE",
              message: "Inspection output is not a strict render.",
              retryable: false,
              diagnosticIds: outcome.value.diagnostics.diagnostics
                .filter((d) => d.severity === "error")
                .map((d) => d.id),
            },
          }
        : outcome;
  return {
    outcome: final,
    staged,
    ...(evidence ? { evidence } : {}),
    ...(cleanup ? { cleanup } : {}),
    recoveryRequired:
      recoveryRequired ||
      (final.status !== "complete" &&
        final.status !== "partial" &&
        staged.length > 0),
    ...(failures.stage ? { stageFailure: failures.stage } : {}),
    ...(executionFailure ? { executionFailure } : {}),
  };
}

export class StaticRenderer implements Renderer {
  readonly contractVersion = "1.0" as const;
  constructor(private readonly options: RendererOptions) {
    if (
      typeof options.publish !== "function" ||
      typeof options.observePreparation !== "function"
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Verified publisher and stage ownership observer are mandatory.",
      );
  }
  async render(
    request: RenderRequest,
    original: OperationContext,
  ): Promise<Outcome<RenderResult>> {
    const context = snapshotOperationContext(original);
    const preparation = freezeJson(
      await renderStaged(request, context, this.options),
    );
    await this.options.observePreparation(preparation, context);
    if (
      preparation.outcome.status !== "complete" &&
      preparation.outcome.status !== "partial"
    )
      return preparation.outcome;
    const receipt = await this.options.publish(preparation, context);
    if (receipt.status !== "complete")
      return receipt.status === "partial"
        ? {
            schemaVersion: "1.0",
            projectId: context.projectId,
            requestId: context.requestId,
            status: "interrupted",
            error: receipt.error,
            diagnosticIds: receipt.diagnosticIds,
          }
        : receipt;
    const check = await boundary(context, async () => {
      const r = receipt.value;
      const ordered = (artifacts: Artifact[]) =>
        [...artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (
        !validateContract("CommitReceipt", r).success ||
        r.projectId !== context.projectId ||
        r.idempotency.actorId !== context.authorization.actorId ||
        r.idempotency.projectId !== context.projectId ||
        r.idempotency.key !== context.requestId ||
        (context.jobId !== undefined && r.jobId !== context.jobId) ||
        canonicalDigest(ordered(r.outputs)) !==
          canonicalDigest(ordered(preparation.staged.map((s) => s.artifact)))
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Publisher receipt does not match exact render artifacts.",
        );
      return true;
    });
    if (check.status !== "complete") return { ...check, status: "interrupted" };
    // A verified committed receipt wins cancellation; do not recheck cancellation after commit.
    return preparation.outcome;
  }
  async getCapabilities(context: OperationContext) {
    new OperationGuard(
      context,
      {
        projectId: this.options.projectId,
        resourceKind: "provider",
        resourceId: this.options.providerId,
        operation: "execute",
      },
      this.options.authority,
    );
    return {
      schemaVersion: "1.0" as const,
      providerId: this.options.providerId,
      projectId: this.options.projectId,
      implementation: "production" as const,
      host: {
        os: "windows" as const,
        version: "windows-x64-profile",
        architecture: "x64" as const,
        evidence: "declared" as const,
      },
      operations: [
        {
          operation: "render",
          availability: "unverified" as const,
          evidence: "unverified" as const,
          limitations: [
            "Requires verified installed payload and rights, actual observed profile and trusted atomic publisher.",
            "Static subset only; no source-Figma equivalence or macOS execution claim.",
          ],
        },
      ],
      cancellation: "cooperative" as const,
      deadline: "required" as const,
      limits: this.options.budgetLimits ?? DEFAULT_BUDGETS,
    };
  }
}
