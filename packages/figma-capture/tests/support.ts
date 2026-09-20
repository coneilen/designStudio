import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type {
  FigmaCaptureRequest,
  OperationContext,
  Outcome,
  StagedArtifact,
} from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { canonicalBytes, canonicalDigest } from "@design-studio/design-ir";
import {
  HostBoundaryError,
  Redactor,
  ScopedCredentialStore,
} from "@design-studio/host";
import type { JobExecution } from "@design-studio/jobs";
import type {
  JobEffect,
  JobSubmission,
  JobUsage,
  StoredJob,
} from "@design-studio/storage";
import { CAPTURE_LIMITS, ownPolicy } from "../src/boundary.js";
import { CAPTURE_HANDLER_ID, CAPTURE_HANDLER_VERSION } from "../src/service.js";

export const PAT = "synthetic-capture-private-pat-123456789";
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const zero = (): JobUsage => ({
  inputBytes: 0,
  outputBytes: 0,
  externalCalls: 0,
  modelTokens: 0,
  costMicros: 0,
});
export function captureFixture(imageOrigins: string[] = []) {
  const policy = ownPolicy({
    id: "policy_one",
    projectId: "project_synthetic",
    sourceId: "source_one",
    artifactRootId: "artifact_root",
    fileKey: "SyntheticFile",
    nodeId: "1:2",
    credential: {
      id: "credential_one",
      providerId: "figma_rest",
      store: "windows-credential-manager",
    },
    imageOrigins,
  });
  const request: FigmaCaptureRequest = {
    schemaVersion: "1.0",
    captureId: "capture_one",
    projectId: policy.projectId,
    policyId: policy.id,
    policySha256: canonicalDigest(policy),
    selectionUrl:
      "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
    credential: policy.credential,
  };
  const context = syntheticContext({
    budget: { ...CAPTURE_LIMITS },
    requestId: "capture_request",
    jobId: request.captureId,
  });
  context.authorization.egress = "explicit-grant-required";
  context.authorization.grants.push(
    {
      resourceKind: "source",
      resourceId: policy.sourceId,
      operations: ["capture"],
    },
    {
      resourceKind: "provider",
      resourceId: "figma_rest",
      operations: ["read"],
    },
    {
      resourceKind: "credential",
      resourceId: policy.credential.id,
      operations: ["credential-use"],
    },
    {
      resourceKind: "artifact",
      resourceId: policy.artifactRootId,
      operations: ["read", "write"],
    },
    {
      resourceKind: "job",
      resourceId: request.captureId,
      operations: ["read", "write"],
    },
  );
  let authorized = true;
  const authority = () => authorized;
  const inputBytes = canonicalBytes(request);
  const input = {
    id: `sha256_${digest(inputBytes)}`,
    sha256: digest(inputBytes),
  };
  const resources = {
    snapshotId: "resources",
    sha256: "a".repeat(64),
    componentRegistryRevision: "none",
    tokenRegistryRevision: "none",
    selectedModes: {},
  };
  const submission: JobSubmission = {
    id: request.captureId,
    operation: "capture",
    input,
    resources,
    handlerId: CAPTURE_HANDLER_ID,
    handlerVersion: CAPTURE_HANDLER_VERSION,
    authorityRef: "capture_authority",
    resourceKeys: ["capture_resource"],
    deadline: context.deadline,
    budget: context.budget,
  };
  const now = new Date(context.clock.now()).toISOString();
  const record: StoredJob = {
    submission,
    job: {
      schemaVersion: "1.0",
      id: request.captureId,
      projectId: policy.projectId,
      actorId: context.authorization.actorId,
      operation: "capture",
      status: "running",
      input,
      resources,
      attempt: 1,
      idempotency: {
        key: context.requestId,
        projectId: policy.projectId,
        actorId: context.authorization.actorId,
        operation: "capture",
        payloadSha256: canonicalDigest(submission),
      },
      deadline: context.deadline,
      budget: context.budget,
      progress: 0,
      diagnosticIds: [],
      lease: {
        id: "lease_one",
        ownerId: "owner_one",
        resourceId: request.captureId,
        fencingToken: 1,
        heartbeatAt: now,
        expiresAt: context.deadline,
      },
    },
    requestId: context.requestId,
    handlerId: CAPTURE_HANDLER_ID,
    handlerVersion: CAPTURE_HANDLER_VERSION,
    authorityRef: "capture_authority",
    resourceKeys: ["capture_resource"],
    resources: [],
    rowVersion: 1,
    generation: 1,
    createdAt: now,
    updatedAt: now,
    progressSequence: 0,
    lastProgressAt: null,
    usage: zero(),
    effects: [],
  };
  const blobs = new Map<string, Buffer>([
    [input.sha256, Buffer.from(inputBytes)],
  ]);
  let stages = 0;
  const checkpoint = async () => {
    if (!authorized)
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "Synthetic authority revoked.",
      );
    if (context.signal.aborted)
      throw new HostBoundaryError("CANCELLED", "Synthetic cancellation.");
  };
  const stage = async (bytes: Uint8Array): Promise<Outcome<StagedArtifact>> => {
    await checkpoint();
    const hash = digest(bytes);
    blobs.set(hash, Buffer.from(bytes));
    record.usage.inputBytes += bytes.length;
    record.usage.outputBytes += bytes.length;
    return {
      schemaVersion: "1.0",
      projectId: policy.projectId,
      requestId: context.requestId,
      status: "complete",
      diagnosticIds: [],
      value: {
        stagingId: `stage_${++stages}`,
        artifact: {
          id: `sha256_${hash}`,
          sha256: hash,
          path: `blobs/${hash}`,
          mediaType: "application/octet-stream",
          byteLength: bytes.length,
        },
      },
    };
  };
  const execution: JobExecution = {
    context,
    get record() {
      return structuredClone(record);
    },
    checkpoint,
    stage,
    progress: async () => {},
    reserve: async (id, reserved) => {
      await checkpoint();
      record.effects.push({ id, reserved, state: "reserved" });
      record.usage.externalCalls += reserved.externalCalls;
    },
    settle: async (id, result) => {
      await checkpoint();
      const effect = record.effects.find((entry) => entry.id === id);
      if (effect?.state !== "reserved")
        throw new Error("Synthetic duplicate settlement");
      effect.state = typeof result === "string" ? result : "settled";
      if (typeof result !== "string") effect.actual = result;
    },
    filesystem: { stage: async (_request, bytes) => stage(bytes) },
  };
  let credentialReads = 0;
  const credentialBytes: Uint8Array[] = [];
  const credentials = new ScopedCredentialStore({
    projectId: policy.projectId,
    authority,
    references: [policy.credential],
    redactor: new Redactor(),
    budgetLimits: CAPTURE_LIMITS,
    backend: {
      store: "windows-credential-manager",
      capability: "native-binding",
      read: async () => {
        credentialReads++;
        const bytes = Buffer.from(PAT);
        credentialBytes.push(bytes);
        return bytes;
      },
    },
  });
  return {
    policy,
    request,
    context,
    record,
    execution,
    credentials,
    authority,
    blobs,
    inputBytes,
    revoke() {
      authorized = false;
    },
    reads: () => credentialReads,
    assertZeroed: () =>
      credentialBytes.every((bytes) => bytes.every((byte) => byte === 0)),
    body: (reference: { sha256: string }) =>
      JSON.parse(blobs.get(reference.sha256)?.toString() ?? "null"),
    replaceEffects(effects: JobEffect[]) {
      record.effects = effects;
    },
  };
}
export function png(srgb = true, width = 1, height = 1) {
  const chunk = (kind: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), bytes]);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([prefix, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const offset = row * (width * 4 + 1) + 1 + column * 4;
      pixels[offset] = 255;
      pixels[offset + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(srgb ? [chunk("sRGB", Buffer.of(0))] : []),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export const nodes = {
  version: "version_7",
  nodes: {
    "1:2": {
      document: {
        id: "1:2",
        type: "FRAME",
        children: [],
        absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
      },
      schemaVersion: 0,
    },
  },
};
export type CaptureFixture = ReturnType<typeof captureFixture>;
export type CaptureContext = OperationContext;
