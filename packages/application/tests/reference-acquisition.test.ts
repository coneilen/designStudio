import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeReferenceEnvelope } from "@design-studio/contracts";
import { fakeComplete } from "@design-studio/contracts/testing";
import { canonicalBytes } from "@design-studio/design-ir";
import { HostBoundaryError, ProjectFileSystem } from "@design-studio/host";
import { JobService } from "@design-studio/jobs";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { afterEach, expect, it, vi } from "vitest";
import {
  image as authoredPng,
  chunk,
  srgb,
} from "../../assets/tests/png-fixtures.js";
import * as referenceDecoder from "../../figma-capture/dist/decode.js";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { png } from "../../figma-capture/tests/support.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { CAPTURE_DIAGNOSTIC_POLICY_SHA256 } from "../../project-host/src/capture-diagnostic-profile.js";
import { CAPTURE_POLICY_SHA256 } from "../../project-host/src/capture-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../../project-host/src/capture-reference-profile.js";
import {
  assembleNativeCapture,
  type NativeCaptureRuntime,
} from "../src/capture-runtime-internal.js";
import { ReferenceReader } from "../src/reference-proof.js";
import {
  DIAGNOSTIC_APPROVAL_CONFIRMATION,
  DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
  REFERENCE_APPROVAL_CONFIRMATION,
  REFERENCE_DOWNLOAD_CONFIRMATION,
} from "../src/reference-runtime.js";

const seam = vi.hoisted(() => ({
  work: undefined as CaptureWork | undefined,
  physicalReads: 0,
  measureReads: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read;
      Object.defineProperty(handle, "read", {
        value: async (...input: unknown[]) => {
          const result: unknown = await Reflect.apply(read, handle, input);
          if (
            seam.measureReads &&
            result &&
            typeof result === "object" &&
            "bytesRead" in result &&
            typeof result.bytesRead === "number"
          )
            seam.physicalReads += result.bytesRead;
          return result;
        },
      });
      return handle;
    },
  };
});
vi.mock("@design-studio/project-host", async (original) => ({
  ...(await original<typeof import("@design-studio/project-host")>()),
  acquireCaptureWork: () => {
    if (!seam.work) throw new Error("No synthetic owner");
    return seam.work;
  },
}));
vi.mock("../../project-host/dist/capture-work.js", () => ({
  assertCaptureWork: (work: CaptureWork) => {
    if (work !== seam.work) throw new Error("Synthetic owner changed");
  },
}));
const cleanups: (() => Promise<void>)[] = [];
vi.setConfig({ testTimeout: 60000 });
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    seam.work = undefined;
    seam.measureReads = false;
    seam.physicalReads = 0;
  }
});
const origin = "https://figma-alpha-api.s3.us-west-2.amazonaws.com";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic evidence");
  return value;
}
async function fixture(
  options: {
    large?: boolean;
    url?: string;
    dimensions?: number;
    nodeVersion?: string;
    renderNode?: string;
    diagnostic?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "reference-synthetic-"));
  for (const name of ["artifacts", "outputs"])
    await mkdir(path.join(root, name));
  const project = {
    projectId: "project_synthetic",
    artifactRootId: "artifacts_synthetic",
    paths: {
      database: path.join(root, "state.sqlite"),
      artifacts: path.join(root, "artifacts"),
      outputs: path.join(root, "outputs"),
      inputs: root,
      temp: root,
    },
    principal: { actorId: "actor_synthetic" },
    reference: {
      id: "credential_synthetic",
      providerId: "figma_rest",
      store: "windows-credential-manager",
    },
    recheck: async () => {},
    close: async () => {},
  } as CaptureProject;
  let runtime: NativeCaptureRuntime;
  let admitted = true;
  let vaultAllowed = true;
  let fault: string | undefined;
  let clockOffset = 0;
  let diagnosticPolicy = CAPTURE_DIAGNOSTIC_POLICY_SHA256;
  const vault = vi.fn();
  const ready = vi.fn(async () => undefined);
  const reads: { bytes: number; allowed: boolean }[] = [];
  const create = ProjectFileSystem.create.bind(ProjectFileSystem);
  vi.spyOn(ProjectFileSystem, "create").mockImplementation((o) =>
    create({
      ...o,
      publicationProfile: "portable-atomic",
      reserveRead: (bytes, context) => {
        const event = { bytes, allowed: false };
        reads.push(event);
        o.reserveRead?.(bytes, context);
        event.allowed = true;
      },
    }),
  );
  vi.spyOn(
    ProjectFileSystem.prototype,
    "ensurePublicationDurable",
  ).mockImplementation(async (_root, _artifacts, context) =>
    fakeComplete(context, { durable: true }),
  );
  const openStore = LocalStore.open.bind(LocalStore);
  let currentStore: LocalStore | undefined;
  vi.spyOn(LocalStore, "open").mockImplementation(async (o) => {
    currentStore = await openStore({
      ...o,
      fault: (point) => {
        if (point === fault) throw new Error("Synthetic publication fault");
      },
    });
    return currentStore;
  });
  const open = async () => {
    let current = true;
    let policy: ReturnType<typeof nativeCapturePolicy>;
    const work: CaptureWork = {
      project,
      actorId: project.principal.actorId,
      permissionScope: "synthetic",
      sqliteBinding: path.resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      policyId: "figma-capture-v1",
      policySha256: CAPTURE_POLICY_SHA256,
      imageOrigins: [],
      apiOrigins: ["https://api.figma.com"],
      get policy() {
        return policy;
      },
      current: async () => {
        if (!current)
          throw new HostBoundaryError("FORBIDDEN", "Closed synthetic owner");
      },
      isCurrent: () => current,
      ...(options.diagnostic
        ? {
            diagnosticAuthority: async () => {
              if (!admitted)
                throw new HostBoundaryError(
                  "FORBIDDEN",
                  "Synthetic diagnostic authority revoked.",
                );
              return diagnosticPolicy;
            },
          }
        : {}),
      readyCredential: ready,
      recoveryAuthority: async () => {
        throw new Error("Reference must not read recovery/credential state");
      },
      referenceAuthority: async () => {
        if (!admitted)
          throw new HostBoundaryError("FORBIDDEN", "Old synthetic lease");
        return CAPTURE_REFERENCE_POLICY_SHA256;
      },
      attestDatabase: async () => {},
      credentials: () => ({
        use: async (_ref, context, consume) => {
          vault();
          if (!vaultAllowed)
            throw new Error("Reference must not read credentials");
          return fakeComplete(
            context,
            await consume(Buffer.from("synthetic-pat")),
          );
        },
      }),
      close: () => {
        current = false;
      },
    };
    seam.work = work;
    policy = nativeCapturePolicy(work);
    const originalNow = policy.clock.now.bind(policy.clock);
    vi.spyOn(policy.clock, "now").mockImplementation(
      () => originalNow() + clockOffset,
    );
    runtime = await assembleNativeCapture(project);
    return runtime;
  };
  const api = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockImplementation(async (operation, _v, _secret, budget) => {
      const value =
        operation === "metadata"
          ? { file: { version: "v1" } }
          : operation === "nodes"
            ? {
                version: options.nodeVersion ?? "v1",
                nodes: {
                  "1:2": {
                    document: {
                      id: "1:2",
                      type: "FRAME",
                      children: [],
                      absoluteBoundingBox: {
                        x: 10,
                        y: 20,
                        width: 2,
                        height: 2,
                      },
                      ...(options.large
                        ? { description: "x".repeat(300000) }
                        : {}),
                    },
                  },
                },
              }
            : {
                images: {
                  [options.renderNode ?? "1:2"]:
                    options.url ??
                    `${origin}/synthetic.png?private=synthetic-only`,
                },
              };
      const bytes = Buffer.from(JSON.stringify(value));
      budget.decoded(bytes.length);
      return { status: 200, mediaType: "application/json", bytes };
    });
  const image = vi
    .spyOn(FigmaHttpsTransport.prototype, "image")
    .mockImplementation(async (_url, budget) => {
      budget.check();
      budget.dnsQuery();
      const bytes = png(true, options.dimensions ?? 2, 2);
      budget.receive(bytes.length);
      budget.decoded(bytes.length);
      return { status: 200, mediaType: "image/png", bytes };
    });
  const initial = await open();
  cleanups.push(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const capture = await initial.execute(
    {
      operation: "capture",
      requestId: "original",
      url: "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2",
    },
    new AbortController().signal,
  );
  expect(capture.status, JSON.stringify(capture)).toBe("partial");
  expect(capture.value?.capture?.referenceStatus).toBe("unavailable");
  expect(image).not.toHaveBeenCalled();
  vaultAllowed = false;
  api.mockClear();
  vault.mockClear();
  ready.mockClear();
  reads.length = 0;
  seam.physicalReads = 0;
  seam.measureReads = true;
  const run = (
    input: Parameters<NonNullable<NativeCaptureRuntime["reference"]>>[0],
    signal = new AbortController().signal,
  ) => required(runtime.reference).call(runtime, input, signal);
  const plan = () =>
    run({ operation: "reference-plan", requestId: "original" });
  const approve = async () => {
    const proposal = await plan();
    expect(proposal.status, JSON.stringify(proposal)).toBe("complete");
    const result = await run({
      operation: "reference-approve",
      requestId: "original",
      origin,
      expectedProof: required(proposal.value?.proposal?.proofSha256),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    });
    expect(result.status, JSON.stringify(result)).toBe("complete");
    return result;
  };
  const download = (approval: NativeReferenceEnvelope, signal?: AbortSignal) =>
    run(
      {
        operation: "reference-download",
        requestId: "original",
        expectedApproval: required(approval.value?.approval?.sha256),
        confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
      },
      signal,
    );
  const diagnosticPlan = () =>
    run({ operation: "reference-diagnostic-plan", requestId: "original" });
  const diagnosticApprove = async () => {
    const plan = await diagnosticPlan();
    expect(plan.status, JSON.stringify(plan)).toBe("complete");
    const approved = await run({
      operation: "reference-diagnostic-approve",
      requestId: "original",
      origin,
      expectedProof: required(plan.value?.proposal?.proofSha256),
      confirmation: DIAGNOSTIC_APPROVAL_CONFIRMATION,
    });
    expect(approved.status, JSON.stringify(approved)).toBe("complete");
    return approved;
  };
  const diagnosticDownload = (approval: NativeReferenceEnvelope) =>
    run({
      operation: "reference-diagnostic-download",
      requestId: "original",
      expectedApproval: required(approval.value?.approval?.sha256),
      confirmation: DIAGNOSTIC_DOWNLOAD_CONFIRMATION,
    });
  const blobs = async () => {
    const dir = path.join(root, "artifacts", "blobs");
    return Promise.all(
      (await readdir(dir))
        .sort()
        .map(
          async (name) => [name, await readFile(path.join(dir, name))] as const,
        ),
    );
  };
  return {
    plan,
    approve,
    download,
    diagnosticPlan,
    diagnosticApprove,
    diagnosticDownload,
    changeDiagnosticPolicy: () => {
      diagnosticPolicy = "d".repeat(64);
    },
    corruptReferenceRead: (kind: "receipt" | "unknown" | "reserved") => {
      const jobs = required(currentStore).jobs;
      const get = jobs.get.bind(jobs);
      vi.spyOn(jobs, "get").mockImplementation(async (jobId, context) => {
        const result = await get(jobId, context);
        if (
          result.status === "complete" &&
          result.value.handlerId === "figma-reference-download-v1"
        ) {
          if (kind === "receipt" && result.value.job.receipt)
            result.value.job.receipt.id = "wrong_receipt";
          else if (result.value.effects[0])
            result.value.effects[0].state =
              kind === "unknown" ? "unknown" : "reserved";
        }
        return result;
      });
    },
    retainSyntheticStage: async () => {
      const ctx = await required(seam.work).policy.issue({
        jobId: "synthetic_pending",
        requestId: "synthetic_pending",
        signal: new AbortController().signal,
      });
      expect(
        (
          await required(currentStore).stage(
            Buffer.from("synthetic uncommitted publication"),
            ctx,
          )
        ).status,
      ).toBe("complete");
    },
    seedCooldown: async (predecessor: NativeReferenceEnvelope) => {
      const work = required(seam.work);
      const db = required(currentStore);
      const jobId = required(predecessor.value?.job?.id);
      const ctx = await work.policy.issue({
        jobId: "synthetic_cooldown",
        requestId: "synthetic_cooldown",
        jobReads: [jobId],
        signal: new AbortController().signal,
      });
      const evidence = {
        ...required(predecessor.value?.evidence),
        statusCode: 429,
        errorCode: "RATE_LIMITED",
        nextEligibleAt: new Date(work.policy.clock.now() + 60000).toISOString(),
        retry: "explicit-action-required",
      };
      const staged = await db.stage(canonicalBytes(evidence), ctx);
      if (staged.status !== "complete")
        throw new Error("Synthetic cooldown stage failed");
      const receipt = await db.commit([staged.value], ctx);
      if (receipt.status !== "complete")
        throw new Error("Synthetic cooldown receipt failed");
      const history = await db.jobs.discoverOwned({ jobId, limit: 1 }, ctx);
      if (history.status !== "complete")
        throw new Error("Synthetic history unavailable");
      const descriptor = required(history.value.descriptors[0]);
      const discover = db.jobs.discoverOwned.bind(db.jobs);
      // Only discovery is synthetic; the cooldown artifact/receipt and physical reads use SQLite.
      vi.spyOn(db.jobs, "discoverOwned").mockImplementation(
        async (query, context) => {
          const result = await discover(query, context);
          if (!query.jobId && result.status === "complete")
            result.value.descriptors.push({
              ...descriptor,
              jobId: "synthetic_cooldown",
              outputs: receipt.value.outputs,
            });
          return result;
        },
      );
    },
    run,
    image,
    api,
    vault,
    ready,
    reads,
    get runtime() {
      return runtime;
    },
    blobs,
    advanceClock: (milliseconds: number) => {
      clockOffset += milliseconds;
    },
    corruptNodes: async () => {
      const artifact = required(
        capture.value?.artifacts.find((a) => a.role === "nodes"),
      ).artifact;
      await writeFile(
        path.join(root, "artifacts", "blobs", artifact.sha256),
        Buffer.from("tampered synthetic nodes"),
      );
    },
    deny: () => {
      admitted = false;
    },
    setFault: (value?: string) => {
      fault = value;
    },
    reopen: async () => {
      await runtime.close();
      await open();
    },
  };
}
it("requires exact explicit offline approval and attaches once without modifying a large committed capture", async () => {
  const f = await fixture({ large: true });
  const old = await f.blobs();
  const plan = await f.plan();
  expect(plan.status, JSON.stringify(plan)).toBe("complete");
  expect(JSON.stringify(plan)).not.toContain("synthetic-only");
  expect(
    await f.run({
      operation: "reference-download",
      requestId: "original",
      expectedApproval: "0".repeat(64),
      confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  expect(
    await f.run({
      operation: "reference-approve",
      requestId: "original",
      origin: `${origin}/`,
      expectedProof: required(plan.value?.proposal?.proofSha256),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  const approved = await f.approve();
  expect(f.image).not.toHaveBeenCalled();
  const result = await f.download(approved);
  expect(result.status, JSON.stringify(result)).toBe("complete");
  expect(result.value?.evidence).toMatchObject({
    referenceStatus: "complete",
    readiness: "not-evaluated",
    reference: {
      bounds: { x: 10, y: 20 },
      pixelWidth: 2,
      pixelHeight: 2,
      colorSpace: "srgb",
    },
    usage: { externalCalls: 1, dnsQueries: 1 },
  });

  expect(f.image).toHaveBeenCalledTimes(1);
  expect(f.api).not.toHaveBeenCalled();
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
  await f.reopen();
  expect((await f.download(approved)).value?.receipt).toEqual(
    result.value?.receipt,
  );
  expect(f.image).toHaveBeenCalledTimes(1);
  const after = new Map(await f.blobs());
  for (const [name, bytes] of old) expect(after.get(name)).toEqual(bytes);
});

it.each([
  ["image/png", "png", true],
  ["application/octet-stream", "generic-binary", true],
  ["binary/octet-stream", "generic-binary", true],
  [undefined, "missing", false],
  ["text/html", "other", false],
  ["application/json", "other", false],
] as const)(
  "persists safe MIME %s evidence and original bytes without renewing consumed authority",
  async (mediaType, mimeClass, accepted) => {
    const f = await fixture();
    const approval = await f.approve();
    const before = await f.blobs();
    const original = authoredPng(
      6,
      8,
      Buffer.from([
        0, 10, 20, 30, 255, 10, 20, 30, 255, 0, 10, 20, 30, 255, 10, 20, 30,
        255,
      ]),
      [
        srgb(),
        chunk("tEXt", Buffer.from("Synthetic\0diagnostic-private-marker")),
      ],
      [],
      2,
      2,
    );
    f.image.mockImplementation(async (_url, budget) => {
      budget.dnsQuery();
      budget.receive(original.length + 100);
      budget.decoded(original.length);
      return {
        status: 200,
        bytes: Buffer.from(original),
        ...(mediaType ? { mediaType } : {}),
      };
    });
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe(
      accepted ? "complete" : "unavailable",
    );
    expect(result.value?.evidence).toMatchObject({
      statusCode: 200,
      referenceDiagnostic: {
        stage: accepted ? "png" : "mime",
        reason: accepted
          ? "validated"
          : mediaType
            ? "mime-rejected"
            : "mime-missing",
        mimeClass,
      },
    });
    expect(JSON.stringify(result)).not.toContain("diagnostic-private-marker");
    const after = new Map(await f.blobs());
    for (const [hash, bytes] of before) expect(after.get(hash)).toEqual(bytes);
    if (accepted)
      expect(
        after.get(required(result.value?.evidence?.reference?.artifact.sha256)),
      ).toEqual(original);
    else {
      expect(result.value?.receipt?.outputs).toHaveLength(1);
      expect(result.value?.evidence?.errorCode).toBe("UNSUPPORTED_FEATURE");
    }
    await f.reopen();
    expect((await f.download(approval)).value?.receipt).toEqual(
      result.value?.receipt,
    );
    expect(f.image).toHaveBeenCalledTimes(1);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);
it("returns terminal raster diagnostic without claiming a durable receipt or replaying", async () => {
  const f = await fixture();
  const approval = await f.approve();
  const bytes = png(true, 1, 1);
  const { header, signature } = await import(
    "../../assets/tests/png-fixtures.js"
  );
  const oversized = Buffer.concat([
    signature,
    header(6, 8, 6553601),
    bytes.subarray(33),
  ]);
  f.image.mockResolvedValue({
    status: 200,
    bytes: oversized,
    mediaType: "image/png",
  });
  const result = await f.download(approval);
  expect(result).toMatchObject({
    status: "failed",
    error: {
      code: "RASTER_LIMIT",
      referenceDiagnostic: {
        stage: "png",
        reason: "raster-limit",
        mimeClass: "png",
      },
    },
  });
  expect(result.value?.receipt).toBeUndefined();
  await f.download(approval);
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("reads legacy unknown HTTP200 decoder failure without rewriting its evidence or consumed slot", async () => {
  const f = await fixture();
  const approval = await f.approve();
  const legacy = vi
    .spyOn(referenceDecoder, "decodeReference")
    .mockRejectedValue(
      new HostBoundaryError(
        "INVALID_INPUT",
        "Synthetic legacy decoder collision.",
      ),
    );
  const result = await f.download(approval);
  legacy.mockRestore();
  expect(result.status, JSON.stringify(result)).toBe("unavailable");
  expect(result.value?.evidence).toMatchObject({
    statusCode: 200,
    errorCode: "INVALID_INPUT",
    referenceStatus: "unavailable",
  });
  expect(result.value?.evidence?.referenceDiagnostic).toBeUndefined();
  expect(result.referenceDiagnostic).toEqual({
    stage: "legacy",
    reason: "legacy-unknown",
    mimeClass: "not-observed",
  });
  const before = await f.blobs();
  await f.reopen();
  const inspected = await f.download(approval);
  expect(inspected.value?.receipt).toEqual(result.value?.receipt);
  expect(inspected.value?.evidence).toEqual(result.value?.evidence);
  expect(await f.blobs()).toEqual(before);
  expect(f.image).toHaveBeenCalledTimes(1);
});

async function legacyReferenceFailure(f: Awaited<ReturnType<typeof fixture>>) {
  const approval = await f.approve();
  const legacy = vi
    .spyOn(referenceDecoder, "decodeReference")
    .mockRejectedValue(
      new HostBoundaryError(
        "INVALID_INPUT",
        "Synthetic legacy rejection, phase unknown.",
      ),
    );
  try {
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe("unavailable");
    expect(result.value?.evidence?.statusCode).toBe(200);
    expect(result.value?.evidence?.referenceDiagnostic).toBeUndefined();
    return result;
  } finally {
    legacy.mockRestore();
  }
}

it.each([false, true])(
  "consumes exactly one server-derived diagnostic slot, including failed successor=%s",
  async (failSuccessor) => {
    const f = await fixture({ diagnostic: true });
    const predecessor = await legacyReferenceFailure(f);
    f.advanceClock(300001);
    const originalBlobs = await f.blobs();
    const approved = await f.diagnosticApprove();
    expect(approved.value?.proposal?.diagnosticPredecessor?.jobId).toBe(
      predecessor.value?.job?.id,
    );
    expect(approved.value?.proposal?.binding.originalRequestId).toBe(
      "original",
    );
    expect(approved.value?.proposal?.binding.acquisitionId).not.toBe(
      predecessor.value?.job?.id,
    );
    expect(f.image).toHaveBeenCalledTimes(1);
    if (failSuccessor)
      f.image.mockResolvedValue({
        status: 200,
        bytes: Buffer.from("<html>synthetic</html>"),
        mediaType: "application/octet-stream",
      });
    const result = await f.diagnosticDownload(approved);
    expect(result.status, JSON.stringify(result)).toBe(
      failSuccessor ? "unavailable" : "complete",
    );
    expect(result.value?.consumed).toBe(true);
    expect(result.value?.job?.attempt).toBe(1);
    expect(result.value?.evidence?.usage.externalCalls).toBe(1);
    expect(f.image).toHaveBeenCalledTimes(2);
    expect(
      (
        await f.run({
          operation: "reference-diagnostic-plan",
          requestId: required(result.value?.job?.id),
        })
      ).status,
    ).toBe("failed");
    await f.reopen();
    expect((await f.diagnosticDownload(approved)).value?.receipt).toEqual(
      result.value?.receipt,
    );
    const after = new Map(await f.blobs());
    for (const [hash, bytes] of originalBlobs)
      expect(after.get(hash)).toEqual(bytes);
    const original = await f.run({
      operation: "reference-inspect",
      requestId: "original",
    });
    expect(original.value?.job).toEqual(predecessor.value?.job);
    expect(original.value?.receipt).toEqual(predecessor.value?.receipt);
    expect(original.value?.evidence).toEqual(predecessor.value?.evidence);
    f.changeDiagnosticPolicy();
    expect((await f.diagnosticPlan()).status).toBe("failed");
    expect(f.image).toHaveBeenCalledTimes(2);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.vault).not.toHaveBeenCalled();
  },
);
it("does not give legacy native capability diagnostic authority", async () => {
  const f = await fixture();
  await legacyReferenceFailure(f);
  expect(await f.diagnosticPlan()).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("refuses an acquired PNG as a diagnostic predecessor", async () => {
  const f = await fixture({ diagnostic: true });
  await f.download(await f.approve());
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it.each(["receipt", "unknown", "reserved"] as const)(
  "refuses diagnostic admission with %s predecessor evidence",
  async (kind) => {
    const f = await fixture({ diagnostic: true });
    await legacyReferenceFailure(f);
    f.corruptReferenceRead(kind);
    expect((await f.diagnosticPlan()).status).toBe("failed");
    expect(f.image).toHaveBeenCalledTimes(1);
  },
);
it("refuses a diagnostic successor while a synthetic publication remains uncommitted", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  await f.retainSyntheticStage();
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("requires current diagnostic authority and a fresh unexpired approval before contact", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  f.advanceClock(300001);
  expect((await f.diagnosticDownload(approved)).status).toBe("failed");
  f.deny();
  expect((await f.diagnosticPlan()).status).toBe("failed");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("burns the diagnostic slot on a terminal decoder limit without claiming a receipt", async () => {
  const f = await fixture({ diagnostic: true });
  await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  const { header, signature } = await import(
    "../../assets/tests/png-fixtures.js"
  );
  f.image.mockResolvedValue({
    status: 200,
    mediaType: "image/png",
    bytes: Buffer.concat([signature, header(6, 8, 6553601), chunk("IEND")]),
  });
  const result = await f.diagnosticDownload(approved);
  expect(result).toMatchObject({
    status: "failed",
    error: {
      code: "RASTER_LIMIT",
      referenceDiagnostic: { reason: "raster-limit" },
    },
  });
  expect(result.value?.receipt).toBeUndefined();
  await f.reopen();
  expect(await f.diagnosticDownload(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true, phase: "admitted", job: { status: "failed" } },
  });
  expect(f.image).toHaveBeenCalledTimes(2);
});

it("rechecks settled same-source cooldowns before diagnostic admission", async () => {
  const f = await fixture({ diagnostic: true });
  const predecessor = await legacyReferenceFailure(f);
  const approved = await f.diagnosticApprove();
  await f.seedCooldown(predecessor);
  expect(await f.diagnosticDownload(approved)).toMatchObject({
    status: "failed",
    error: { code: "RATE_LIMITED" },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("refuses old native capability and changed proof without network", async () => {
  const f = await fixture();
  expect(
    await f.run({
      operation: "reference-approve",
      requestId: "original",
      origin,
      expectedProof: "0".repeat(64),
      confirmation: REFERENCE_APPROVAL_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
  f.deny();
  expect(await f.plan()).toMatchObject({
    status: "failed",
    error: { code: "FORBIDDEN" },
  });
  expect(f.image).not.toHaveBeenCalled();
});
it.each([
  "https://foreign.invalid/synthetic.png",
  `${origin}/synthetic.png?X-Amz-Date=20000101T000000Z&X-Amz-Expires=60`,
])(
  "refuses unsupported origin or provable expiry without acquisition: %s",
  async (url) => {
    const f = await fixture({ url });
    const plan = await f.plan();
    if (plan.status === "complete")
      expect(
        await f.run({
          operation: "reference-approve",
          requestId: "original",
          origin,
          expectedProof: required(plan.value?.proposal?.proofSha256),
          confirmation: REFERENCE_APPROVAL_CONFIRMATION,
        }),
      ).toMatchObject({ status: "failed" });
    else expect(plan.status).toBe("failed");
    expect(f.image).not.toHaveBeenCalled();
  },
);
it.each([
  [401, "AUTH_REQUIRED"],
  [403, "FORBIDDEN"],
] as const)(
  "records remote %s honestly and never refreshes or retries after reopen",
  async (status, code) => {
    const f = await fixture();
    const approval = await f.approve();
    f.image.mockRejectedValue(new CaptureHttpError(code, status));
    const result = await f.download(approval);
    expect(result.status, JSON.stringify(result)).toBe("unavailable");
    expect(result.value?.evidence).toMatchObject({
      statusCode: status,
      referenceStatus: "unavailable",
    });
    await f.reopen();
    expect((await f.download(approval)).status).toBe("unavailable");
    expect(f.image).toHaveBeenCalledTimes(1);
    expect(f.api).not.toHaveBeenCalled();
  },
);
it("never retries a job with an unresolved effect after reopen or a different request", async () => {
  const f = await fixture();
  const approval = await f.approve();
  f.image.mockRejectedValue(new CaptureHttpError("PROVIDER_UNAVAILABLE"));
  await f.download(approval);
  await f.reopen();
  expect(await f.download(approval)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(
    await f.run({
      operation: "reference-download",
      requestId: "another",
      expectedApproval: required(approval.value?.approval?.sha256),
      confirmation: REFERENCE_DOWNLOAD_CONFIRMATION,
    }),
  ).toMatchObject({ status: "failed" });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("persists partial geometry rather than upgrading mismatched dimensions", async () => {
  const f = await fixture({ dimensions: 1 });
  const result = await f.download(await f.approve());
  expect(result.status, JSON.stringify(result)).toBe("partial");
  expect(result.value?.evidence?.missing).toContain(
    "reference-dimensions-mismatch",
  );
});
it.each([{ nodeVersion: "wrong-version" }, { renderNode: "7:8" }])(
  "rejects missing pinned source or mismatched selected image without contact: %j",
  async (options) => {
    const f = await fixture(options);
    expect(await f.plan()).toMatchObject({ status: "failed" });
    expect(f.image).not.toHaveBeenCalled();
  },
);
it("rejects changed original artifact bytes and expired approval without consuming a job", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.advanceClock(300001);
  expect(await f.download(approved)).toMatchObject({
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });
  expect(
    await f.run({ operation: "reference-inspect", requestId: "original" }),
  ).toMatchObject({ value: { consumed: false } });
  await f.corruptNodes();
  expect(await f.plan()).toMatchObject({ status: "failed" });
  expect(f.image).not.toHaveBeenCalled();
});
it("preserves proven no-effect failure as a consumed attempt rather than unknown or a new GET", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.image.mockRejectedValue(
    new CaptureHttpError("POLICY_FAILED", undefined, undefined, false),
  );
  const result = await f.download(approved);
  expect(result.status, JSON.stringify(result)).toBe("unavailable");
  expect(result.value?.evidence?.usage.externalCalls).toBe(0);
  expect(result.value?.consumed).toBe(true);
  await f.reopen();
  await f.download(approved);
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("cancels in-flight reference work, joins it and prevents a second admitted invocation", async () => {
  const f = await fixture();
  const approved = await f.approve();
  const abort = new AbortController();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.image.mockImplementation(async (_url, budget) => {
    entered?.();
    await new Promise<void>((resolve) => {
      budget.signal.addEventListener("abort", () => resolve(), { once: true });
      if (budget.signal.aborted) resolve();
    });
    throw new CaptureHttpError("CANCELLED");
  });
  const running = f.download(approved, abort.signal);
  await started;
  await expect(f.download(approved)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  abort.abort();
  expect((await running).status).not.toBe("complete");
  await f.reopen();
  expect(await f.download(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("keeps post-network publication failure non-successful and non-replayable after reopen", async () => {
  const f = await fixture();
  const approved = await f.approve();
  const original = f.image.getMockImplementation();
  f.image.mockImplementation(async (...args) => {
    const result = await required(original)(...args);
    f.setFault("before-commit");
    return result;
  });
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  f.setFault();
  await f.reopen();
  expect(await f.download(approved)).toMatchObject({
    status: "interrupted",
    value: { consumed: true },
  });
  expect(f.image).toHaveBeenCalledTimes(1);
});
it("renews only an unused expired approval through a fresh explicit proof, and replays lost responses without renewal", async () => {
  const f = await fixture();
  const first = await f.approve();
  const firstProof = required(first.value?.proposal?.proofSha256);
  const replay = await f.run({
    operation: "reference-approve",
    requestId: "original",
    origin,
    expectedProof: firstProof,
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  });
  expect(replay.value?.approval).toEqual(first.value?.approval);
  f.advanceClock(300001);
  expect((await f.download(first)).status).toBe("failed");
  const fresh = await f.plan();
  expect(fresh.value?.proposal).toMatchObject({
    approvalGeneration: 1,
    previousApproval: first.value?.approval,
  });
  expect(fresh.value?.proposal?.proofSha256).not.toBe(firstProof);
  const oldReplay = await f.run({
    operation: "reference-approve",
    requestId: "original",
    origin,
    expectedProof: firstProof,
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  });
  expect(oldReplay.value?.approval).toEqual(first.value?.approval);
  const renewal = {
    operation: "reference-approve" as const,
    requestId: "original",
    origin,
    expectedProof: required(fresh.value?.proposal?.proofSha256),
    confirmation: REFERENCE_APPROVAL_CONFIRMATION,
  };
  const racing = await Promise.allSettled([f.run(renewal), f.run(renewal)]);
  const successful = racing.filter((entry) => entry.status === "fulfilled");
  expect(successful).toHaveLength(1);
  const renewed = required(successful[0]).value;
  expect(renewed.status, JSON.stringify(renewed)).toBe("complete");
  expect((await f.run(renewal)).value?.approval).toEqual(
    renewed.value?.approval,
  );
  expect((await f.download(first)).status).toBe("failed");
  expect((await f.download(renewed)).status).toBe("complete");
  f.advanceClock(300001);
  expect((await f.plan()).value?.proposal?.approvalGeneration).toBe(1);
  expect((await f.download(renewed)).status).toBe("complete");
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("meters repeated receipt verification at the physical pre-read boundary before exceeding 25 MiB", async () => {
  const f = await fixture({ large: true });
  const proposal = ReferenceReader.prototype.proposal;
  vi.spyOn(ReferenceReader.prototype, "proposal").mockImplementation(
    async function (this: ReferenceReader, requestId) {
      const value = await proposal.call(this, requestId);
      for (let index = 0; index < 100; index++) {
        const receipt = await this.store.jobs.getJobReceipt(
          value.proposal.binding.originalJobId,
          this.context,
        );
        if (receipt.status !== "complete")
          throw new HostBoundaryError(
            receipt.error.code,
            "Synthetic repeated verification refused.",
          );
      }
      return value;
    },
  );
  const result = await f.plan();
  expect(result, JSON.stringify(f.reads)).toMatchObject({
    status: "failed",
    error: { code: "INPUT_LIMIT" },
  });
  const read = f.reads
    .filter((event) => event.allowed)
    .reduce((sum, event) => sum + event.bytes, 0);
  expect(read).toBeLessThanOrEqual(26214400);
  expect(seam.physicalReads).toBeLessThanOrEqual(read);
  expect(seam.physicalReads).toBeGreaterThan(25000000);
  expect(
    f.reads.filter((event) => event.bytes >= 300000 && event.allowed).length,
  ).toBeGreaterThanOrEqual(2);
  expect(f.reads.some((event) => !event.allowed)).toBe(true);
  expect(f.image).not.toHaveBeenCalled();
});

it("checks small control-artifact bounds before storage verification reads the body", async () => {
  const f = await fixture({ large: true });
  const proposal = ReferenceReader.prototype.proposal;
  vi.spyOn(ReferenceReader.prototype, "proposal").mockImplementation(
    async function (this: ReferenceReader, requestId) {
      const value = await proposal.call(this, requestId);
      f.reads.length = 0;
      seam.physicalReads = 0;
      await this.contract(
        "FigmaReferenceApproval",
        value.proposal.binding.nodes,
      );
      return value;
    },
  );
  expect(await f.plan()).toMatchObject({
    status: "failed",
    error: { code: "INPUT_LIMIT" },
  });
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]).toMatchObject({ allowed: false });
  expect(f.reads[0]?.bytes).toBeGreaterThan(262144);
  expect(seam.physicalReads).toBe(0);
  expect(f.image).not.toHaveBeenCalled();
});

it("shares actual private-read charges with image allowance and does not turn local revocation into remote denial", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.reads.length = 0;
  f.image.mockImplementation(async (_url, budget) => {
    const privateBytes = f.reads
      .filter((entry) => entry.allowed)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    expect(privateBytes).toBeGreaterThan(0);
    expect(() => budget.receive(26214400 - privateBytes + 1)).toThrow();
    f.deny();
    throw new CaptureHttpError("FORBIDDEN");
  });
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  expect(result.value?.evidence).toBeUndefined();
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("does not treat an input limit accompanying HTTP 403 as a remote-denial exception", async () => {
  const f = await fixture();
  const approved = await f.approve();
  f.image.mockRejectedValue(new CaptureHttpError("INPUT_LIMIT", 403));
  const result = await f.download(approved);
  expect(result.status).not.toBe("complete");
  expect(result.value?.evidence).toBeUndefined();
  expect(f.image).toHaveBeenCalledTimes(1);
});

it("retains uncooperative service ownership and original wait failure across stop timeout and close-only retry", async () => {
  const f = await fixture();
  const approved = await f.approve();
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stops = vi.spyOn(JobService.prototype, "stop");
  const closeFiles = vi.spyOn(
    ProjectFileSystem.prototype,
    "closePreservingStages",
  );
  f.image.mockImplementation(async () => {
    enter?.();
    await released;
    throw new CaptureHttpError("PROVIDER_UNAVAILABLE");
  });
  vi.spyOn(JobService.prototype, "waitForAttempt").mockImplementationOnce(
    async () => {
      await entered;
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Synthetic original wait failure",
      );
    },
  );
  const running = f.download(approved);
  try {
    await entered;
    expect(await running).toMatchObject({
      status: "interrupted",
      error: { code: "INTERRUPTED" },
    });
    await expect(f.download(approved)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.runtime.execute(
        { operation: "inspect", requestId: "original" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.runtime.close()).rejects.toMatchObject({
      operationCode: "PROVIDER_UNAVAILABLE",
      cleanupCode: "INTERRUPTED",
    });
    expect(stops.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closeFiles).not.toHaveBeenCalled();
    release?.();
    await f.runtime.close();
    expect(closeFiles).toHaveBeenCalledTimes(1);
    expect(f.image).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await running;
    await f.runtime.close();
  }
});
