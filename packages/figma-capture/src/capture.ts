import { createHash } from "node:crypto";
import type {
  ArtifactReference,
  Bounds,
  CredentialStore,
  ErrorCode,
  FigmaCaptureManifest,
  FigmaCaptureResult,
  JsonObject,
  JsonValue,
  SourceSnapshot,
  StagedArtifact,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  type Authority,
  HostBoundaryError,
  Redactor,
} from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import type { JobUsage } from "@design-studio/storage";
import {
  CaptureBudget,
  type CapturePolicy,
  fail,
  ownRequest,
} from "./boundary.js";
import { decodeReference, parseCaptureJson } from "./decode.js";
import {
  type ApiOperation,
  CaptureHttpError,
  FigmaHttpsTransport,
} from "./transport.js";

export interface CapturePreparation {
  result: FigmaCaptureResult;
  manifest: FigmaCaptureManifest;
  staged: StagedArtifact[];
  hashes: string[];
}
const CALL: JobUsage = Object.freeze({
  inputBytes: 0,
  outputBytes: 0,
  externalCalls: 1,
  modelTokens: 0,
  costMicros: 0,
});
const ref = (artifact: ArtifactReference): ArtifactReference => ({
  id: artifact.id,
  sha256: artifact.sha256,
});
const object = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
function version(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && validateContract("Version", value).success
    ? value
    : undefined;
}
function retryAt(value: string | undefined, now: number): string | undefined {
  if (
    !value ||
    !/^(0|[1-9][0-9]{0,7})$/.test(value) ||
    Number(value) > 31536000
  )
    return undefined;
  const result = new Date(now + Number(value) * 1000).toISOString();
  return validateContract("Timestamp", result).success ? result : undefined;
}
function selectedFrame(
  root: JsonObject,
  policy: CapturePolicy,
  budget: CaptureBudget,
) {
  const nodes = object(root.nodes);
  if (!nodes)
    fail("INVALID_INPUT", "Selected nodes response has no node inventory.");
  const nodeIds = Object.keys(nodes);
  if (
    nodeIds.length > budget.context.budget.maxExpandedNodes ||
    nodeIds.some((id) => id.length > 160)
  )
    fail("NODE_LIMIT", "Returned node inventory exceeds the capture budget.");
  const selected = object(nodes[policy.nodeId]);
  const document = object(selected?.document);
  if (!document || document.id !== policy.nodeId || document.type !== "FRAME")
    return { nodeIds, frame: undefined, images: false, fonts: false };
  const stack = [{ value: document, depth: 1 }];
  const ids = new Set<string>();
  let images = false;
  let fonts = false;
  while (stack.length) {
    budget.check();
    const next = stack.pop();
    if (
      !next ||
      next.depth > budget.context.budget.maxDepth ||
      ids.size >= budget.context.budget.maxExpandedNodes
    )
      fail(
        "NODE_LIMIT",
        "Selected subtree exceeds the capture node/depth budget.",
      );
    const node = next.value;
    if (typeof node.id !== "string" || node.id.length > 160 || ids.has(node.id))
      fail(
        "INVALID_INPUT",
        "Selected subtree contains invalid node identities.",
      );
    ids.add(node.id);
    if (node.type === "TEXT") fonts = true;
    const scan: JsonValue[] = [node];
    let members = 0;
    while (scan.length) {
      const value = scan.pop();
      if (++members > 640000)
        fail("NODE_LIMIT", "Node property evidence exceeds bounds.");
      if (!value || typeof value !== "object") continue;
      if (!Array.isArray(value) && typeof value.imageRef === "string")
        images = true;
      if ((members & 63) === 0) budget.check();
      if (Array.isArray(value)) for (const child of value) scan.push(child);
      else
        for (const [key, entry] of Object.entries(value))
          if (key !== "children") scan.push(entry);
    }
    if (Array.isArray(node.children))
      for (const child of node.children) {
        const value = object(child);
        if (!value)
          fail("INVALID_INPUT", "Selected subtree contains invalid children.");
        stack.push({ value, depth: next.depth + 1 });
      }
    else if (
      ["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(
        String(node.type),
      )
    ) {
      fail("EVIDENCE_MISSING", "Selected container children are missing.");
    }
  }
  const box = object(document.absoluteBoundingBox);
  const values = box && [box.x, box.y, box.width, box.height];
  const bounds: Bounds | undefined =
    box &&
    values?.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    typeof box.width === "number" &&
    box.width > 0 &&
    typeof box.height === "number" &&
    box.height > 0
      ? {
          x: Number(box.x),
          y: Number(box.y),
          width: box.width,
          height: box.height,
          unit: "design-unit",
        }
      : undefined;
  return { nodeIds, frame: bounds, images, fonts };
}
function bytesWithTotal<T>(
  value: T,
  prior: number,
  update: (total: number) => void,
): Uint8Array {
  let bytes = canonicalBytes(value);
  for (let count = 0; count < 8; count++) {
    const total = prior + bytes.length;
    update(total);
    const next = canonicalBytes(value);
    if (next.length === bytes.length) return next;
    bytes = next;
  }
  fail("OUTPUT_LIMIT", "Capture accounting did not stabilize.");
}

export async function captureSelectedFrame(
  input: unknown,
  execution: JobExecution,
  options: {
    policy: Readonly<CapturePolicy>;
    authority: Authority;
    credentials: CredentialStore;
  },
): Promise<CapturePreparation> {
  const request = ownRequest(input, options.policy);
  const budget = new CaptureBudget(
    execution.context,
    options.policy,
    options.authority,
  );
  const staged: StagedArtifact[] = [];
  const hashes: string[] = [];
  const record = execution.record;
  if (
    record.job.id !== request.captureId ||
    budget.context.jobId !== record.job.id ||
    budget.context.requestId !== record.requestId ||
    record.job.actorId !== budget.context.authorization.actorId ||
    record.job.status !== "running" ||
    record.job.attempt !== 1 ||
    record.effects.length ||
    record.usage.externalCalls ||
    canonicalDigest(request) !== record.job.input.sha256
  ) {
    await budget.close();
    fail(
      "FORBIDDEN",
      "Capture must use one fresh, byte-bound explicit job attempt; effects cannot be replayed.",
    );
  }
  const startedAt = new Date(budget.context.clock.now()).toISOString();
  const missing = new Set<string>();
  const limitations = new Set<string>([
    "This is selected-frame source/reference capture, not rendering or implementation readiness.",
    "No variables, fills, libraries, history, fonts or resource-rights acquisition was performed.",
    "Requested file keys may identify files or branches; no branch discovery was performed.",
    "HTTP message completion uses the maintained parser; socket reuse is disabled and unreceived post-close bytes are not attested.",
  ]);
  const observations: FigmaCaptureManifest["observations"][number][] = [];
  const artifacts: FigmaCaptureManifest["artifacts"][number][] = [];
  let sourceVersion: string | undefined;
  let nodesVersion: string | undefined;
  let bounds: Bounds | undefined;
  let reference: FigmaCaptureManifest["reference"];
  let referenceStatus: FigmaCaptureManifest["referenceStatus"] = "unavailable";
  let nextEligibleAt: string | undefined;
  let retry: FigmaCaptureManifest["retry"];
  let remediationOrigin: string | undefined;
  let errorCode: ErrorCode | undefined;
  const transport = new FigmaHttpsTransport();
  const stage = async (bytes: Uint8Array): Promise<StagedArtifact> => {
    budget.check();
    await execution.checkpoint();
    budget.check();
    budget.output(bytes.length);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const result = await execution.stage(bytes);
    budget.check();
    if (result.status !== "complete")
      fail("INTERRUPTED", "Capture staging requires authorized recovery.");
    if (
      result.value.artifact.sha256 !== expected ||
      result.value.artifact.byteLength !== bytes.length
    )
      fail(
        "ARTIFACT_INTEGRITY",
        "Capture stage does not match original bytes.",
      );
    staged.push(result.value);
    hashes.push(expected);
    return result.value;
  };
  try {
    await execution.checkpoint();
    budget.check();
    const consume = options.credentials.use.bind(options.credentials);
    const outcome = await consume(
      request.credential,
      budget.context,
      async (secret) => {
        const redactor = new Redactor();
        const release = redactor.addSecret(secret);
        const safe = (bytes: Uint8Array, value?: unknown) => {
          if (
            redactor.containsSecret(
              Buffer.from(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
              ).toString("utf8"),
            ) ||
            (value !== undefined && redactor.containsSecretValue(value))
          )
            fail(
              "FORBIDDEN",
              "Response contains credential material and cannot be persisted.",
            );
        };
        const perform = async (
          operation: ApiOperation | "reference-download",
          action: () => ReturnType<FigmaHttpsTransport["api"]>,
        ) => {
          budget.check();
          budget.call();
          const effect = `figma_http_${budget.calls}`;
          await execution.reserve(effect, CALL);
          budget.check();
          const observation: FigmaCaptureManifest["observations"][number] = {
            call: budget.calls,
            operation,
            outcome: "unavailable",
            receivedBytes: 0,
            nodeIds: operation === "metadata" ? [] : [options.policy.nodeId],
            ...(sourceVersion &&
            (operation === "nodes" || operation === "reference-render")
              ? { requestedVersion: sourceVersion }
              : {}),
          };
          observations.push(observation);
          const before = budget.body;
          let status: number | undefined;
          let captured:
            | Awaited<ReturnType<FigmaHttpsTransport["api"]>>
            | undefined;
          let problem: unknown;
          try {
            const response = await action();
            status = response.status;
            captured = response;
            observation.statusCode = response.status;
            observation.receivedBytes = budget.body - before;
            observation.outcome = "complete";
          } catch (error) {
            problem = error;
            if (error instanceof CaptureHttpError) {
              status = error.status;
              if (status !== undefined) observation.statusCode = status;
              observation.receivedBytes = budget.body - before;
              observation.outcome =
                status === 429
                  ? "rate-limited"
                  : status === 401 || status === 403
                    ? "denied"
                    : "partial";
              if (status === 429) {
                nextEligibleAt = retryAt(
                  error.retryAfter,
                  budget.context.clock.now(),
                );
                retry = nextEligibleAt
                  ? "explicit-action-required"
                  : "retry-after-unknown";
              }
            }
          }
          try {
            await execution.settle(
              effect,
              status === undefined ? "unknown" : CALL,
            );
          } catch {
            captured?.bytes.fill(0);
            fail(
              "INTERRUPTED",
              "Capture network accounting requires authorized recovery.",
            );
          }
          try {
            budget.check();
          } catch (error) {
            captured?.bytes.fill(0);
            throw error;
          }
          if (problem) {
            if (status === undefined)
              fail(
                "INTERRUPTED",
                "Capture network effect is unresolved and cannot be retried automatically.",
              );
            throw problem;
          }
          if (!captured)
            fail("INTERRUPTED", "Capture response was not observed.");
          return captured;
        };
        const json = async (
          operation: ApiOperation,
          role: "metadata" | "nodes" | "render-map",
        ) => {
          const response = await perform(operation, () =>
            transport.api(operation, sourceVersion, secret, budget),
          );
          try {
            safe(response.bytes);
            const value = await parseCaptureJson(response.bytes, budget);
            budget.check();
            safe(response.bytes, value);
            const original = await stage(response.bytes);
            budget.check();
            artifacts.push({ role, artifact: original.artifact });
            return value;
          } finally {
            response.bytes.fill(0);
          }
        };
        try {
          try {
            const metadata = await json("metadata", "metadata");
            budget.check();
            sourceVersion = version(object(metadata.file)?.version);
            if (!sourceVersion) {
              missing.add("source-version-missing");
              errorCode = "ACTION_REQUIRED";
            } else {
              const metadataObservation = observations[0];
              if (metadataObservation)
                metadataObservation.returnedVersion = sourceVersion;
              const nodes = await json("nodes", "nodes");
              budget.check();
              nodesVersion = version(nodes.version);
              const observed = observations.at(-1);
              if (observed && nodesVersion)
                observed.returnedVersion = nodesVersion;
              const selected = selectedFrame(nodes, options.policy, budget);
              if (observed) observed.nodeIds = selected.nodeIds;
              bounds = selected.frame;
              if (!bounds) {
                missing.add("selected-frame-unresolved");
                if (observed) observed.outcome = "null-result";
              }
              if (selected.images)
                missing.add("unresolved-image-fills-and-rights");
              if (selected.fonts) missing.add("unresolved-fonts-and-rights");
              if (nodesVersion !== sourceVersion)
                missing.add(
                  nodesVersion
                    ? "nodes-version-mismatch"
                    : "nodes-version-unreported",
                );
              if (bounds && nodesVersion === sourceVersion) {
                const render = await json("reference-render", "render-map");
                budget.check();
                const renderVersion = version(render.version);
                const rendered = observations.at(-1);
                if (rendered && renderVersion)
                  rendered.returnedVersion = renderVersion;
                if (renderVersion && renderVersion !== sourceVersion) {
                  missing.add("reference-version-mismatch");
                } else {
                  limitations.add(
                    "The render endpoint was requested at the pinned version; absent returned render version is not a separate server version attestation.",
                  );
                  const image = object(render.images)?.[options.policy.nodeId];
                  if (typeof image !== "string" || image.length > 8192) {
                    missing.add("reference-missing");
                    if (rendered) rendered.outcome = "null-result";
                  } else {
                    let url: URL | undefined;
                    try {
                      url = new URL(image);
                    } catch {
                      /* Recorded as unavailable below. */
                    }
                    if (
                      url?.protocol !== "https:" ||
                      url.username ||
                      url.password ||
                      url.hash ||
                      url.port ||
                      !options.policy.imageOrigins.includes(url.origin)
                    ) {
                      missing.add("reference-origin-not-approved");
                      if (
                        url?.protocol === "https:" &&
                        /^https:\/\/[a-z0-9.-]+$/.test(url.origin) &&
                        !redactor.containsSecret(url.origin)
                      )
                        remediationOrigin = url.origin;
                    } else {
                      const image = await perform("reference-download", () =>
                        transport.image(url.href, budget),
                      );
                      try {
                        safe(image.bytes);
                        const info = await decodeReference(image.bytes, budget);
                        budget.check();
                        const original = await stage(image.bytes);
                        artifacts.push({
                          role: "reference",
                          artifact: original.artifact,
                        });
                        reference = {
                          artifact: ref(original.artifact),
                          bounds,
                          scale: 1,
                          pixelWidth: info.width,
                          pixelHeight: info.height,
                          colorSpace: info.colorSpace,
                        };
                        referenceStatus = "complete";
                        if (
                          !Number.isInteger(bounds.width) ||
                          !Number.isInteger(bounds.height) ||
                          info.width !== bounds.width ||
                          info.height !== bounds.height
                        ) {
                          referenceStatus = "partial";
                          missing.add("reference-dimensions-mismatch");
                          const latest = observations.at(-1);
                          if (latest) latest.outcome = "downscaled";
                        }
                        if (info.colorSpace !== "srgb") {
                          referenceStatus = "partial";
                          missing.add("reference-color-unknown");
                        }
                      } finally {
                        image.bytes.fill(0);
                      }
                    }
                  }
                }
              }
            }
          } catch (error) {
            budget.check();
            const deniedResponse =
              error instanceof CaptureHttpError &&
              (error.status === 401 || error.status === 403);
            if (
              !(error instanceof HostBoundaryError) ||
              (!deniedResponse &&
                [
                  "INTERRUPTED",
                  "FORBIDDEN",
                  "AUTH_REQUIRED",
                  "CANCELLED",
                  "DEADLINE_EXCEEDED",
                  "OUTPUT_LIMIT",
                  "INPUT_LIMIT",
                ].includes(error.code))
            )
              throw error;
            errorCode = error.code;
            missing.add("capture-step-unavailable");
          }
          budget.check();
          if (referenceStatus !== "complete")
            missing.add("verified-reference-unavailable");
          const completeness = missing.size
            ? artifacts.length
              ? "partial"
              : "unavailable"
            : "complete";
          errorCode ??=
            completeness === "complete" ? undefined : "ACTION_REQUIRED";
          let source: ArtifactReference | undefined;
          if (sourceVersion && nodesVersion === sourceVersion && bounds) {
            const value: SourceSnapshot = {
              schemaVersion: "1.0",
              id: `source_${canonicalDigest([request.captureId, sourceVersion])}`,
              projectId: request.projectId,
              identity: {
                transport: "figma-rest",
                fileKey: options.policy.fileKey,
                nodeId: options.policy.nodeId,
                sourceVersion,
              },
              capturedAt: startedAt,
              captureEndedAt: new Date(
                budget.context.clock.now(),
              ).toISOString(),
              consistency: {
                guarantee: observations.some(
                  (item) =>
                    item.requestedVersion &&
                    item.returnedVersion &&
                    item.requestedVersion !== item.returnedVersion,
                )
                  ? "unstable"
                  : "version-pinned",
                limitations: [...limitations],
              },
              completeness,
              requests: observations
                .filter((item) => item.operation !== "reference-download")
                .map((item) => ({
                  id: `request_${canonicalDigest([request.captureId, item.call])}`,
                  operation:
                    item.operation === "metadata"
                      ? "metadata"
                      : item.operation === "nodes"
                        ? "nodes"
                        : "reference-render",
                  nodeIds: item.nodeIds,
                  versionSupport:
                    item.operation === "metadata" ? "not-applicable" : "pinned",
                  outcome:
                    item.outcome === "rate-limited"
                      ? "unavailable"
                      : item.outcome,
                  ...(item.requestedVersion
                    ? { requestedVersion: item.requestedVersion }
                    : {}),
                  ...(item.returnedVersion
                    ? { returnedVersion: item.returnedVersion }
                    : {}),
                })),
              artifacts: artifacts.map((item) => item.artifact),
              missing: [...missing],
              diagnosticIds: [],
            };
            if (!validateContract("SourceSnapshot", value).success)
              fail("INVALID_SCHEMA", "Capture source evidence is invalid.");
            const saved = await stage(canonicalBytes(value));
            source = ref(saved.artifact);
            artifacts.push({ role: "source", artifact: saved.artifact });
          }
          const candidate = {
            schemaVersion: "1.0",
            format: "figma-rest-capture-v1",
            captureId: request.captureId,
            projectId: request.projectId,
            policyId: request.policyId,
            policySha256: request.policySha256,
            request: record.job.input,
            selection: {
              fileKey: options.policy.fileKey,
              nodeId: options.policy.nodeId,
            },
            startedAt,
            endedAt: new Date(budget.context.clock.now()).toISOString(),
            ...(sourceVersion ? { sourceVersion } : {}),
            ...(source ? { source } : {}),
            completeness,
            referenceStatus,
            readiness: "not-evaluated",
            observations,
            artifacts,
            missing: [...missing],
            limitations: [...limitations],
            usage: {
              externalCalls: budget.calls,
              dnsQueries: budget.dns,
              networkReceivedBytes: budget.received,
              networkBodyBytes: budget.body,
              persistedBytes: 0,
            },
            ...(reference ? { reference } : {}),
            ...(remediationOrigin ? { remediationOrigin } : {}),
            ...(nextEligibleAt ? { nextEligibleAt } : {}),
            ...(retry ? { retry } : {}),
          };
          const manifestBytes = bytesWithTotal(
            candidate,
            budget.persisted,
            (total) => {
              candidate.usage.persistedBytes = total;
            },
          );
          const checked = validateContract("FigmaCaptureManifest", candidate);
          if (!checked.success)
            fail("INVALID_SCHEMA", "Capture manifest is invalid.");
          const manifest = checked.value;
          const savedManifest = await stage(manifestBytes);
          const result: FigmaCaptureResult = {
            schemaVersion: "1.0",
            captureId: request.captureId,
            projectId: request.projectId,
            manifest: ref(savedManifest.artifact),
            ...(source ? { source } : {}),
            completeness,
            referenceStatus,
            readiness: "not-evaluated",
            persistedBytes: 0,
            ...(errorCode ? { errorCode } : {}),
            ...(nextEligibleAt ? { nextEligibleAt } : {}),
          };
          const resultBytes = bytesWithTotal(
            result,
            budget.persisted,
            (total) => {
              result.persistedBytes = total;
            },
          );
          if (!validateContract("FigmaCaptureResult", result).success)
            fail("INVALID_SCHEMA", "Capture result is invalid.");
          await stage(resultBytes);
          budget.check();
          return {
            result: structuredClone(result),
            manifest: structuredClone(manifest),
            staged: structuredClone(staged),
            hashes: [...hashes],
          };
        } finally {
          release();
        }
      },
    );
    budget.check();
    if (outcome.status !== "complete") {
      if (outcome.status === "partial")
        fail(outcome.error.code, "Credential-bound capture was partial.");
      fail(
        outcome.error.code,
        `Credential-bound capture failed (${outcome.error.code}); sensitive details withheld.`,
      );
    }
    return outcome.value;
  } finally {
    await budget.close();
  }
}
