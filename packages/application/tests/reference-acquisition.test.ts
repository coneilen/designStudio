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
import { HostBoundaryError, ProjectFileSystem } from "@design-studio/host";
import type { CaptureProject, CaptureWork } from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { afterEach, expect, it, vi } from "vitest";
import {
  CaptureHttpError,
  FigmaHttpsTransport,
} from "../../figma-capture/dist/transport.js";
import { png } from "../../figma-capture/tests/support.js";
import { nativeCapturePolicy } from "../../project-host/dist/capture-authority.js";
import { CAPTURE_POLICY_SHA256 } from "../../project-host/src/capture-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "../../project-host/src/capture-reference-profile.js";
import {
  assembleNativeCapture,
  type NativeCaptureRuntime,
} from "../src/capture-runtime-internal.js";
import {
  REFERENCE_APPROVAL_CONFIRMATION,
  REFERENCE_DOWNLOAD_CONFIRMATION,
} from "../src/reference-runtime.js";

const seam = vi.hoisted(() => ({ work: undefined as CaptureWork | undefined }));
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
  const vault = vi.fn();
  const ready = vi.fn(async () => undefined);
  const create = ProjectFileSystem.create.bind(ProjectFileSystem);
  vi.spyOn(ProjectFileSystem, "create").mockImplementation((o) =>
    create({ ...o, publicationProfile: "portable-atomic" }),
  );
  vi.spyOn(
    ProjectFileSystem.prototype,
    "ensurePublicationDurable",
  ).mockImplementation(async (_root, _artifacts, context) =>
    fakeComplete(context, { durable: true }),
  );
  const openStore = LocalStore.open.bind(LocalStore);
  vi.spyOn(LocalStore, "open").mockImplementation((o) =>
    openStore({
      ...o,
      fault: (point) => {
        if (point === fault) throw new Error("Synthetic publication fault");
      },
    }),
  );
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
    run,
    image,
    api,
    vault,
    ready,
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
it("records denied response honestly and never refreshes or retries after reopen", async () => {
  const f = await fixture();
  const approval = await f.approve();
  f.image.mockRejectedValue(new CaptureHttpError("PROVIDER_UNAVAILABLE", 403));
  const result = await f.download(approval);
  expect(result.status, JSON.stringify(result)).toBe("unavailable");
  expect(result.value?.evidence).toMatchObject({
    statusCode: 403,
    referenceStatus: "unavailable",
  });
  await f.reopen();
  expect((await f.download(approval)).status).toBe("unavailable");
  expect(f.image).toHaveBeenCalledTimes(1);
  expect(f.api).not.toHaveBeenCalled();
});
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
