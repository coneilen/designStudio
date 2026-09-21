import type {
  FigmaReferenceEvidence,
  FigmaReferenceRequest,
  OperationContext,
  StagedArtifact,
} from "@design-studio/contracts";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { canonicalBytes } from "@design-studio/design-ir";
import {
  type Authority,
  authorizeOperation,
  HostBoundaryError,
  OperationGuard,
  snapshotOperationContext,
} from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import type { JobUsage } from "@design-studio/storage";
import { fail, type ImageBudget } from "./boundary.js";
import { decodeReference } from "./decode.js";
import { CaptureHttpError, FigmaHttpsTransport } from "./transport.js";

export const REFERENCE_ORIGIN =
  "https://figma-alpha-api.s3.us-west-2.amazonaws.com" as const;
export const REFERENCE_HANDLER = "figma-reference-download-v1";
export const REFERENCE_LIMITS = Object.freeze({
  ...DEFAULT_BUDGETS,
  maxExternalCalls: 1,
  maxAttempts: 1,
  maxDurationMs: 30000,
  maxRasterPixels: 6553600,
});
export const REFERENCE_LIMITATIONS = Object.freeze([
  "Separate selected-reference acquisition; the original partial capture is immutable.",
  "The render was requested at the pinned version; absent returned version is not an independent server attestation.",
  "No fonts, image fills, resource rights, API refresh, conversion or readiness evaluation.",
  "Signed URL freshness is unverified except for recognized explicit expiry metadata.",
] as const);
export class ReferenceBudget implements ImageBudget {
  readonly context: OperationContext;
  readonly signal: AbortSignal;
  readonly policy = Object.freeze({
    imageOrigins: Object.freeze([REFERENCE_ORIGIN]),
  });
  readonly guard: OperationGuard;
  private readonly watch: ReturnType<OperationGuard["watch"]>;
  dns = 0;
  received = 0;
  body = 0;
  persisted = 0;
  constructor(
    context: OperationContext,
    sourceId: string,
    artifactRootId: string,
    authority: Authority,
    readonly localInputBytes: number,
  ) {
    this.context = snapshotOperationContext(context);
    if (
      !Number.isSafeInteger(localInputBytes) ||
      localInputBytes < 0 ||
      localInputBytes > this.context.budget.maxInputBytes ||
      this.context.budget.maxExternalCalls !== 1 ||
      this.context.authorization.egress !== "explicit-grant-required" ||
      Date.parse(context.deadline) > context.clock.now() + 30000
    )
      fail(
        "FORBIDDEN",
        "Reference budget is not an admitted one-shot operation.",
      );
    authorizeOperation(
      this.context,
      {
        projectId: context.projectId,
        resourceKind: "artifact",
        resourceId: artifactRootId,
        operation: "write",
      },
      authority,
    );
    this.guard = new OperationGuard(
      this.context,
      {
        projectId: context.projectId,
        resourceKind: "source",
        resourceId: sourceId,
        operation: "reference-download",
      },
      authority,
      undefined,
      REFERENCE_LIMITS,
    );
    this.watch = this.guard.watch();
    this.signal = this.watch.signal;
  }
  check() {
    this.guard.check();
    if (this.signal.aborted)
      throw this.signal.reason instanceof HostBoundaryError
        ? this.signal.reason
        : new HostBoundaryError("CANCELLED", "Reference interrupted.");
  }
  dnsQuery() {
    this.check();
    if (this.dns !== 0) fail("INPUT_LIMIT", "Reference DNS budget exceeded.");
    this.dns++;
  }
  receive(bytes: number) {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes >
        this.context.budget.maxInputBytes - this.localInputBytes - this.received
    )
      fail("INPUT_LIMIT", "Aggregate reference input budget exceeded.");
    this.received += bytes;
  }
  decoded(bytes: number) {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes >
        this.context.budget.maxInputBytes - this.localInputBytes - this.body
    )
      fail("INPUT_LIMIT", "Reference body budget exceeded.");
    this.body += bytes;
  }
  output(bytes: number) {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.context.budget.maxOutputBytes - this.persisted
    )
      fail("OUTPUT_LIMIT", "Reference output budget exceeded.");
    this.persisted += bytes;
  }
  async close() {
    await this.watch.close();
  }
}

export function referenceUrl(input: string): {
  url: string;
  expiresAt?: string;
} {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail("INVALID_INPUT", "Invalid private reference URL.");
  }
  if (
    input.length > 8192 ||
    url.origin !== REFERENCE_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    url.hostname.endsWith(".") ||
    url.protocol !== "https:"
  )
    fail("ACTION_REQUIRED", "Reference origin or URL is not supported.");
  const date = url.searchParams.get("X-Amz-Date");
  const seconds = url.searchParams.get("X-Amz-Expires");
  let expiresAt: string | undefined;
  if (date !== null || seconds !== null) {
    if (
      url.searchParams.getAll("X-Amz-Date").length !== 1 ||
      url.searchParams.getAll("X-Amz-Expires").length !== 1 ||
      !date ||
      !/^\d{8}T\d{6}Z$/.test(date) ||
      !seconds ||
      !/^[1-9][0-9]{0,5}$/.test(seconds) ||
      Number(seconds) > 604800
    )
      fail("INVALID_INPUT", "Private reference expiry metadata is invalid.");
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}.000Z`;
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso)
      fail("INVALID_INPUT", "Private reference expiry metadata is invalid.");
    expiresAt = new Date(parsed + Number(seconds) * 1000).toISOString();
  }
  return { url: url.href, ...(expiresAt ? { expiresAt } : {}) };
}
const CALL: JobUsage = {
  inputBytes: 0,
  outputBytes: 0,
  externalCalls: 1,
  modelTokens: 0,
  costMicros: 0,
};
export async function acquireReference(
  request: FigmaReferenceRequest,
  url: string,
  execution: JobExecution,
  budget: ReferenceBudget,
): Promise<{ outputs: StagedArtifact[]; evidence: FigmaReferenceEvidence }> {
  const outputs: StagedArtifact[] = [];
  const context = execution.context;
  const evidence: FigmaReferenceEvidence = {
    schemaVersion: "1.0",
    format: "figma-reference-evidence-v1",
    request,
    startedAt: new Date(context.clock.now()).toISOString(),
    endedAt: new Date(context.clock.now()).toISOString(),
    deadline: context.deadline,
    referenceStatus: "unavailable",
    readiness: "not-evaluated",
    usage: {
      localInputBytes: budget.localInputBytes,
      externalCalls: 0,
      dnsQueries: 0,
      networkReceivedBytes: 0,
      networkBodyBytes: 0,
      persistedBytes: 0,
    },
    missing: [],
    limitations: [...REFERENCE_LIMITATIONS],
  };
  const stage = async (bytes: Uint8Array) => {
    budget.output(bytes.length);
    const result = await execution.stage(bytes);
    budget.check();
    if (result.status !== "complete")
      fail(result.error.code, "Reference staging requires review.");
    outputs.push(result.value);
    return result.value.artifact;
  };
  let image: Awaited<ReturnType<FigmaHttpsTransport["image"]>> | undefined;
  try {
    budget.check();
    const target = referenceUrl(url);
    if (target.expiresAt && context.clock.now() >= Date.parse(target.expiresAt))
      fail(
        "ACTION_REQUIRED",
        "Private reference URL has expired; no refresh is authorized.",
      );
    await execution.reserve("reference-image-get", CALL);
    await execution.checkpoint();
    let error: unknown;
    try {
      image = await new FigmaHttpsTransport().image(target.url, budget);
      evidence.statusCode = image.status;
    } catch (problem) {
      error = problem;
      if (problem instanceof CaptureHttpError && problem.status !== undefined)
        evidence.statusCode = problem.status;
    }
    const noEffect =
      error instanceof CaptureHttpError && error.requestIssued === false;
    evidence.usage.externalCalls = noEffect ? 0 : 1;
    await execution.settle(
      "reference-image-get",
      noEffect
        ? "no-effect"
        : evidence.statusCode === undefined
          ? "unknown"
          : CALL,
    );
    budget.check();
    if (!noEffect && evidence.statusCode === undefined)
      fail(
        "INTERRUPTED",
        "Reference network effect is unresolved; retry is forbidden.",
      );
    if (error) throw error;
    if (image?.mediaType !== "image/png")
      fail("INVALID_INPUT", "Reference response is not a PNG.");
    const info = await decodeReference(image.bytes, budget);
    const artifact = await stage(image.bytes);
    evidence.reference = {
      artifact: { id: artifact.id, sha256: artifact.sha256 },
      bounds: request.binding.bounds,
      scale: 1,
      pixelWidth: info.width,
      pixelHeight: info.height,
      colorSpace: info.colorSpace,
    };
    if (
      info.width !== request.binding.bounds.width ||
      info.height !== request.binding.bounds.height
    )
      evidence.missing.push("reference-dimensions-mismatch");
    if (info.colorSpace !== "srgb")
      evidence.missing.push("reference-color-unknown");
    evidence.referenceStatus = evidence.missing.length ? "partial" : "complete";
  } catch (error) {
    budget.check();
    if (
      !(error instanceof HostBoundaryError) ||
      [
        "INTERRUPTED",
        "FORBIDDEN",
        "AUTH_REQUIRED",
        "CANCELLED",
        "DEADLINE_EXCEEDED",
        "INPUT_LIMIT",
        "OUTPUT_LIMIT",
      ].includes(error.code)
    )
      throw error;
    evidence.errorCode = error.code;
    evidence.missing.push("verified-reference-unavailable");
    if (error instanceof CaptureHttpError && error.status === 429) {
      if (
        error.retryAfter &&
        /^(0|[1-9][0-9]{0,7})$/.test(error.retryAfter) &&
        Number(error.retryAfter) <= 31536000
      ) {
        evidence.nextEligibleAt = new Date(
          context.clock.now() + Number(error.retryAfter) * 1000,
        ).toISOString();
        evidence.retry = "explicit-action-required";
      } else evidence.retry = "retry-after-unknown";
    }
  } finally {
    image?.bytes.fill(0);
  }
  evidence.endedAt = new Date(context.clock.now()).toISOString();
  evidence.usage.dnsQueries = budget.dns;
  evidence.usage.networkReceivedBytes = budget.received;
  evidence.usage.networkBodyBytes = budget.body;
  let bytes = canonicalBytes(evidence);
  for (let i = 0; i < 8; i++) {
    evidence.usage.persistedBytes = budget.persisted + bytes.length;
    const next = canonicalBytes(evidence);
    if (next.length === bytes.length) {
      await stage(next);
      return { outputs, evidence };
    }
    bytes = next;
  }
  fail("OUTPUT_LIMIT", "Reference evidence accounting did not stabilize.");
}
