import { randomUUID } from "node:crypto";
import { AssetPipeline } from "@design-studio/assets";
import {
  type Artifact,
  type ArtifactReference,
  type AuthorizationContext,
  DEFAULT_BUDGETS,
  type OperationContext,
  parseContract,
  type Revision,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import {
  type Authority,
  authorizeOperation,
  LocalSessionAuthenticator,
  ProjectFileSystem,
  SystemClock,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import {
  createJobService,
  type ExecutionAuthority,
  type JobEvent,
  type RecoveryAuthority,
  type VersionedJob,
} from "@design-studio/jobs";
import type {
  FixtureProjectBinding,
  FixtureProjectRegistry,
} from "@design-studio/project-host";
import type { StagedRender } from "@design-studio/renderer";
import type { RendererWorkerHost } from "@design-studio/renderer-host";
import {
  type JobDiscoveryDescriptor,
  LocalStore,
  type LogicalArtifactBinding,
} from "@design-studio/storage";
import { createApplication } from "./application.js";
import { verifyPreviewBytes } from "./artifacts.js";
import { FIXTURE_IDS, type FixtureCatalog } from "./catalog.js";
import { logicalIdentity, verifyAcceptedRevision } from "./designs.js";
import { doctor } from "./doctor.js";
import { fixtureSemantics } from "./fixtures.js";
import {
  authorityPolicy,
  type INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS,
} from "./installed-profile.js";
import { stopApplication } from "./lifecycle.js";
import { OutputCapabilities } from "./output-capabilities.js";
import { createFixturePolicy, type Grants } from "./policy.js";
import { RecoveryDecisions } from "./recovery.js";
import { createRenderJobs } from "./render-jobs.js";
import { makeRenderRequest } from "./render-request.js";
import { ApplicationError, success, unwrap } from "./response.js";
import { startOwnedApplication } from "./startup.js";

export { StartupCleanupRequired } from "./startup.js";

import {
  ARTIFACT_ROOT,
  jobEtag,
  PERMISSION_SCOPE,
  PROJECT_ID,
} from "./routes.js";
import type {
  ApplicationFacade,
  ApplicationResult,
  Invocation,
} from "./types.js";

const ref = (artifact: Artifact): ArtifactReference => ({
  id: artifact.id,
  sha256: artifact.sha256,
});
const physical = (bytes: Uint8Array): ArtifactReference => ({
  id: `sha256_${hashBytes(bytes)}`,
  sha256: hashBytes(bytes),
});
const policyId = "installed-fixture-render-v1";
export async function openFixtureApplication(options: {
  registry: FixtureProjectRegistry;
  binding: FixtureProjectBinding;
  catalog: FixtureCatalog;
  nativeBinding: string;
  recheckInstallation(): Promise<void>;
  worker(authority: Authority): Pick<RendererWorkerHost, "open">;
  observePreparation?(preparation: Readonly<StagedRender>): void;
  onJobEvent?(event: Readonly<JobEvent>): void;
  authorityTimeoutMs?: typeof INSTALLED_FIXTURE_AUTHORITY_TIMEOUT_MS;
}) {
  const { registry, binding, catalog } = options;
  const jobAuthorityPolicy = authorityPolicy(options.authorityTimeoutMs);
  const recheckInstallation = options.recheckInstallation.bind(options);
  const workerFactory = options.worker.bind(options);
  const observePreparation = options.observePreparation?.bind(options);
  const onJobEvent = options.onJobEvent?.bind(options);
  const nativeBinding = options.nativeBinding;
  await recheckInstallation();
  await binding.recheck();
  if (
    binding.scope.projectId !== PROJECT_ID ||
    binding.scope.artifactRootId !== ARTIFACT_ROOT ||
    binding.scope.permissionScope !== PERMISSION_SCOPE ||
    binding.catalogIdentity !== catalog.identity
  )
    throw new ApplicationError("FORBIDDEN", 403);
  const clock = new SystemClock();
  let stopping = false;
  let retained = false;
  let active = 0;
  const invocations = new Set<AbortController>();
  let jobs: ReturnType<typeof createJobService> | undefined;
  const policy = createFixturePolicy({
    clock,
    expectedActor: binding.principal.actorId,
    currentActor: async () => {
      await binding.recheck();
      return registry.currentPrincipal().actorId;
    },
    onRevoked: () => {
      outputCapabilities.clear();
      for (const controller of invocations) controller.abort();
      void jobs?.stop();
    },
  });
  const outputCapabilities = new OutputCapabilities(
    ARTIFACT_ROOT,
    policy.verify,
  );
  const semantics = new Map(
    FIXTURE_IDS.map((id) => [id, fixtureSemantics(catalog, id)]),
  );
  const allowedReferences = new Map<string, Uint8Array>();
  for (const fixture of semantics.values())
    for (const entry of fixture.references)
      allowedReferences.set(
        `${entry.reference.id}:${entry.reference.sha256}`,
        entry.bytes,
      );
  const artifactGrants = (
    references: readonly ArtifactReference[],
    write = false,
  ): Grants =>
    [...new Set(references.map((reference) => reference.id))].map(
      (resourceId) => ({
        resourceKind: "artifact",
        resourceId,
        operations: write ? ["read", "write"] : ["read"],
      }),
    );
  const catalogGrants = artifactGrants(
    [...semantics.values()].flatMap((fixture) => [
      ...fixture.references.flatMap((entry) => [
        entry.reference,
        physical(entry.bytes),
      ]),
      physical(fixture.contentBytes),
      physical(fixture.provenanceBytes),
    ]),
    true,
  );
  let store: LocalStore;
  const files = await ProjectFileSystem.create({
    projectId: PROJECT_ID,
    authority: policy.verify,
    publicationProfile: WINDOWS_PUBLICATION_PROFILE,
    roots: [
      {
        id: ARTIFACT_ROOT,
        path: binding.paths.artifacts,
        access: "read-write",
        managedBlobs: true,
        trustedExclusiveAccess: true,
      },
    ],
    authorizeRemoval: async (artifact, context) =>
      store?.hasRemovalReservation(artifact, context) ?? false,
  });
  const outside = async (): Promise<never> => {
    throw new ApplicationError("ACTION_REQUIRED", 409);
  };
  const rootContext = (requestId: string, signal: AbortSignal) =>
    policy.issue({ requestId, signal, grants: [policy.rootGrant] });
  function checkDescriptor(descriptor: JobDiscoveryDescriptor) {
    const fixtureId = descriptor.inputRevision?.designId.replace(
      /^design_/,
      "",
    );
    const fixture = [...semantics.values()].find(
      (entry) => entry.design.designId === `design_${fixtureId}`,
    );
    if (
      !fixture ||
      descriptor.actorId !== policy.actorId ||
      descriptor.projectId !== PROJECT_ID ||
      descriptor.operation !== "render" ||
      descriptor.authorityRef !== policyId ||
      !["fixture-render-strict", "fixture-render-inspection"].includes(
        descriptor.handlerId,
      ) ||
      descriptor.handlerVersion !== "1.0.0" ||
      descriptor.input.sha256 !== hashBytes(fixture.contentBytes) ||
      canonicalDigest(descriptor.resources) !==
        canonicalDigest(fixture.design.resources) ||
      descriptor.inputRevision?.sha256 !== descriptor.input.sha256 ||
      descriptor.jobId !==
        logicalIdentity(policy.actorId, "render", descriptor.requestId).jobId
    )
      throw new ApplicationError("FORBIDDEN", 403);
    return fixture;
  }
  function descriptorGrants(descriptor: JobDiscoveryDescriptor): Grants {
    checkDescriptor(descriptor);
    return [
      {
        resourceKind: "job",
        resourceId: descriptor.jobId,
        operations: ["read", "write"],
      },
      ...artifactGrants(
        [
          descriptor.input,
          {
            id: descriptor.resources.snapshotId,
            sha256: descriptor.resources.sha256,
          },
          ...descriptor.physicalInputs.flatMap((entry) => [
            entry.reference,
            entry.artifact,
          ]),
          ...descriptor.outputs,
        ],
        true,
      ),
      ...(descriptor.inputRevision
        ? [
            {
              resourceKind: "revision" as const,
              resourceId: descriptor.inputRevision.id,
              operations: ["read", "write"] as ["read", "write"],
            },
            {
              resourceKind: "design" as const,
              resourceId: descriptor.inputRevision.designId,
              operations: ["read"] as ["read"],
            },
          ]
        : []),
    ];
  }
  async function discover(signal: AbortSignal, jobId?: string) {
    const ctx = await rootContext(randomUUID(), signal);
    return unwrap(
      await store.jobs.discoverOwned(
        { limit: 100, ...(jobId ? { jobId } : {}) },
        ctx,
      ),
    );
  }
  async function descriptor(jobId: string, signal: AbortSignal) {
    const page = await discover(signal, jobId);
    const item = page.descriptors[0];
    if (!item) throw new ApplicationError("NOT_FOUND", 404);
    checkDescriptor(item);
    return item;
  }
  const recoveryDecisions = new RecoveryDecisions(policy);
  const executionAuthority: ExecutionAuthority = {
    verify: policy.verify,
    async observe(signal) {
      const page = await discover(signal);
      if (page.nextCursor) throw new ApplicationError("ACTION_REQUIRED", 409);
      const grants = page.descriptors.flatMap(descriptorGrants);
      if (!grants.length)
        grants.push({
          resourceKind: "job",
          resourceId: "fixture_observer_empty",
          operations: ["read"],
        });
      return policy.issue({
        requestId: randomUUID(),
        signal,
        grants: [policy.rootGrant, ...grants],
      });
    },
    async issue(record, signal) {
      await recheckInstallation();
      const current = await descriptor(record.job.id, signal);
      if (
        current.requestId !== record.requestId ||
        current.actorId !== record.job.actorId ||
        current.authorityRef !== record.authorityRef ||
        current.handlerId !== record.handlerId
      )
        throw new ApplicationError("FORBIDDEN", 403);
      return policy.issue({
        requestId: record.requestId,
        jobId: record.job.id,
        signal,
        budget: record.job.budget,
        deadline: record.job.deadline,
        grants: [
          policy.rootGrant,
          ...descriptorGrants(current),
          ...catalogGrants,
          {
            resourceKind: "provider",
            resourceId: "renderer_static",
            operations: ["execute"],
          },
        ],
      });
    },
  };
  const recoveryAuthority: RecoveryAuthority = {
    async issue(record, signal) {
      const current = await descriptor(record.job.id, signal);
      const context = await policy.issue({
        requestId: current.requestId,
        jobId: current.jobId,
        signal,
        grants: [
          policy.rootGrant,
          ...descriptorGrants(current),
          ...catalogGrants,
        ],
      });
      recoveryDecisions.register(record, context);
      return context;
    },
    decide: (record, facts, context) =>
      recoveryDecisions.decide(record, facts, context),
  };
  async function readBytes(
    reference: ArtifactReference,
    context: OperationContext,
  ) {
    const artifact = unwrap(await store.verify(reference, context));
    const bytes = unwrap(
      await files.read(
        { artifactRootId: ARTIFACT_ROOT, path: artifact.path },
        context,
      ),
    );
    if (hashBytes(bytes) !== reference.sha256)
      throw new ApplicationError("ARTIFACT_INTEGRITY", 500);
    return { artifact, bytes };
  }
  const renderer = createRenderJobs({
    stageAdapter: (execution) => outputCapabilities.wrap(execution),
    ...(observePreparation ? { observePreparation } : {}),
    async loadRequest(record, context, mode) {
      if (!record.inputRevision) throw new ApplicationError("EVIDENCE_MISSING");
      const revision = unwrap(
        await store.getRevision(record.inputRevision.id, context),
      );
      return makeRenderRequest(
        catalog,
        revision.designId.replace(/^design_/, ""),
        record.inputRevision,
        mode,
      );
    },
    options: {
      projectId: PROJECT_ID,
      providerId: "renderer_static",
      artifactRootId: ARTIFACT_ROOT,
      authority: policy.verify,
      worker: workerFactory(policy.verify),
      rightsAuthority: (license, hash, use) =>
        [...semantics.values()].some((fixture) =>
          fixture.rightsAuthority(license, hash, use),
        ),
      async resolveInputs(request, context) {
        const revision = unwrap(
          await store.getRevision(request.revision.id, context),
        );
        if (
          revision.content.sha256 !== request.revision.sha256 ||
          revision.designId !== request.design.designId
        )
          throw new ApplicationError("CONFLICT", 412);
        const fixture = [...semantics.values()].find(
          (entry) => entry.design.designId === revision.designId,
        );
        if (!fixture) throw new ApplicationError("FORBIDDEN", 403);
        const content = await readBytes(revision.content, context);
        const resources = await readBytes(
          {
            id: revision.resources.snapshotId,
            sha256: revision.resources.sha256,
          },
          context,
        );
        const artifacts = [];
        for (const reference of fixture.renderReferences)
          artifacts.push(await readBytes(reference, context));
        return {
          revision: request.revision,
          designBytes: content.bytes,
          resourceBytes: resources.bytes,
          artifacts,
        };
      },
    },
  });
  try {
    store = await LocalStore.open({
      projectId: PROJECT_ID,
      artifactRootId: ARTIFACT_ROOT,
      permissionScope: PERMISSION_SCOPE,
      databasePath: binding.paths.database,
      nativeBinding,
      snapshotOperationContext,
      fileSystem: files,
      canonicalBytes,
      attestLocalDatabase: binding.attestLocalDatabase.bind(binding),
      authorize: async (context, scope) => {
        await policy.check();
        if (outputCapabilities.authorize(context, scope)) return;
        authorizeOperation(context, scope, policy.verify);
      },
      authorizeArtifactBinding: async (mapping, evidence, context) => {
        await policy.check();
        const bytes = allowedReferences.get(
          `${mapping.reference.id}:${mapping.reference.sha256}`,
        );
        if (
          !bytes ||
          mapping.artifact.id !== evidence.artifact.id ||
          mapping.artifact.sha256 !== hashBytes(bytes) ||
          hashBytes(evidence.bytes) !== hashBytes(bytes)
        )
          throw new ApplicationError("FORBIDDEN", 403);
        authorizeOperation(
          context,
          {
            projectId: PROJECT_ID,
            resourceKind: "artifact",
            resourceId: mapping.reference.id,
            operation: "write",
          },
          policy.verify,
        );
      },
      verifyRevision: async (revision, context, evidence) =>
        verifyAcceptedRevision(catalog, revision, context, evidence),
      ensurePublicationDurable: async (artifacts, context) => {
        unwrap(
          await files.ensurePublicationDurable(
            ARTIFACT_ROOT,
            artifacts,
            context,
          ),
        );
      },
      ensureDatabaseBackupDurable: outside,
      assessApproval: outside,
      authorizeRestore: outside,
      authorizeRetention: outside,
      canDiscardStage: async () => false,
      maintenance: {
        inventory: async (context, limit) =>
          unwrap(await files.inventory(ARTIFACT_ROOT, context, limit)),
        removeBlob: outside,
      },
      jobs: {
        clock,
        verifyCompletion: renderer.verifyCompletion,
        authorizeRecovery: (record, evidence, context) =>
          recoveryDecisions.authorize(record, evidence, context),
        discovery: {
          authorizeOwner: async (context) => {
            await policy.check();
            if (context.authorization.actorId !== binding.principal.actorId)
              throw new ApplicationError("FORBIDDEN", 403);
          },
        },
      },
    });
  } catch (error) {
    await files.close();
    policy.revoke();
    throw error;
  }
  jobs = createJobService({
    ...jobAuthorityPolicy,
    projectId: PROJECT_ID,
    repository: store.jobs,
    clock,
    executionAuthority,
    recoveryAuthority,
    handlers: renderer.handlers,
    artifactRootId: ARTIFACT_ROOT,
    ownerId: randomUUID(),
    leaseMs: 30000,
    heartbeatMs: 10000,
    pollMs: 250,
    onEvent: (event) => {
      onJobEvent?.(event);
      if (event.kind === "settled" && event.jobId) {
        renderer.releaseJob(event.jobId);
        outputCapabilities.dropJob(event.jobId);
      }
    },
  });
  const local = new LocalSessionAuthenticator({
    clock,
    hosts: ["127.0.0.1:47119"],
    origins: [],
  });
  const external = new Set<LocalSessionAuthenticator>([local]);
  const transportSessions: {
    authenticator: LocalSessionAuthenticator;
    authorization: AuthorizationContext;
  }[] = [];
  function newClient(
    authenticator: LocalSessionAuthenticator,
    host: string,
    mode: "cli" | "browser" = "cli",
  ) {
    if (stopping) throw new ApplicationError("ACTION_REQUIRED");
    for (let index = transportSessions.length - 1; index >= 0; index--) {
      const entry = transportSessions[index];
      if (entry && Date.parse(entry.authorization.expiresAt) <= clock.now()) {
        entry.authenticator.revoke(entry.authorization);
        transportSessions.splice(index, 1);
      }
    }
    if (transportSessions.length >= 256)
      throw new ApplicationError("ACTION_REQUIRED", 409);
    external.add(authenticator);
    const credentials = authenticator.createSession(
      {
        schemaVersion: "1.0",
        projectId: PROJECT_ID,
        actorId: policy.actorId,
        sessionId: randomUUID(),
        expiresAt: new Date(clock.now() + 300000).toISOString(),
        grants: [],
        egress: "deny",
      },
      mode,
    );
    const authorization = authenticator.authenticate({
      remoteAddress: "127.0.0.1",
      host,
      method: "GET",
      ...(mode === "cli"
        ? { bearer: credentials.credential }
        : {
            cookie: credentials.credential,
            origin: `http://${host}`,
            fetchSite: "same-origin",
          }),
    });
    transportSessions.push({ authenticator, authorization });
    return { ...credentials, host };
  }
  const localCredential = newClient(local, "127.0.0.1:47119");
  const localAuthorization = local.authenticate({
    remoteAddress: "127.0.0.1",
    host: localCredential.host,
    method: "GET",
    bearer: localCredential.credential,
  });
  async function contextFor(
    request: Invocation,
    auth: AuthorizationContext,
    signal: AbortSignal,
  ) {
    if (
      stopping ||
      ![...external].some((session) => session.authority(auth)) ||
      auth.actorId !== policy.actorId
    )
      throw new ApplicationError("AUTH_REQUIRED", 401);
    await recheckInstallation();
    await policy.check();
    const grants: Grants = [policy.rootGrant, ...catalogGrants];
    let jobId: string | undefined;
    if (request.operation === "acceptFixture") {
      const identity = logicalIdentity(
        policy.actorId,
        "write",
        request.requestId,
      );
      jobId = identity.jobId;
      grants.push(
        {
          resourceKind: "job",
          resourceId: jobId,
          operations: ["read", "write"],
        },
        {
          resourceKind: "revision",
          resourceId: identity.revisionId,
          operations: ["read", "write"],
        },
      );
      const body = validateContract(
        "FoundationAcceptFixtureRequest",
        request.body,
      );
      if (body.success && body.value.base)
        grants.push({
          resourceKind: "revision",
          resourceId: body.value.base.expectedBaseRevision,
          operations: ["read"],
        });
    }
    if (request.operation === "submitRender") {
      jobId = logicalIdentity(
        policy.actorId,
        "render",
        request.requestId,
      ).jobId;
      const checked = validateContract(
        "FoundationRenderSubmissionRequest",
        request.body,
      );
      if (!checked.success) throw new ApplicationError("INVALID_INPUT");
      grants.push(
        {
          resourceKind: "job",
          resourceId: jobId,
          operations: ["read", "write"],
        },
        {
          resourceKind: "revision",
          resourceId: checked.value.revision.id,
          operations: ["read"],
        },
      );
      const existing = await discover(signal, jobId);
      if (existing.descriptors[0])
        grants.push(...descriptorGrants(existing.descriptors[0]));
    }
    if (request.operation === "getRevision" && request.id)
      grants.push({
        resourceKind: "revision",
        resourceId: request.id,
        operations: ["read"],
      });
    if (
      ["acceptFixture", "submitRender", "getDesign"].includes(
        request.operation,
      ) &&
      request.id
    )
      grants.push({
        resourceKind: "design",
        resourceId: request.id,
        operations: ["read", "write"],
      });
    if (
      ["getJob", "waitJob", "cancelJob", "getPreview"].includes(
        request.operation,
      ) &&
      request.id
    ) {
      const current = await descriptor(request.id, signal);
      jobId = current.jobId;
      grants.push(...descriptorGrants(current));
    }
    if (
      ["getArtifact", "readArtifact"].includes(request.operation) &&
      request.id
    ) {
      const digest = request.parameters.sha256;
      const page = await discover(signal);
      const allowed =
        catalogGrants.some((grant) => grant.resourceId === request.id) ||
        page.descriptors.some((item) => {
          checkDescriptor(item);
          return item.outputs.some(
            (output) => output.id === request.id && output.sha256 === digest,
          );
        });
      if (!allowed) throw new ApplicationError("FORBIDDEN", 403);
      grants.push({
        resourceKind: "artifact",
        resourceId: request.id,
        operations: ["read"],
      });
    }
    return policy.issue({
      requestId: request.requestId,
      ...(jobId ? { jobId } : {}),
      signal,
      grants,
      sourceAuthority: () =>
        [...external].some((session) => session.authority(auth)),
      deadline: new Date(
        Math.min(
          Date.parse(auth.expiresAt),
          clock.now() +
            Math.min(30000, Number(request.parameters.timeoutMs ?? "30000")),
        ),
      ).toISOString(),
    });
  }
  const internalFacade = createApplication({
    authorize: contextFor,
    execute,
    capabilities: () => {
      const report = doctor();
      const storage = report.operations.find(
        (operation) => operation.operation === "storage",
      );
      if (storage) {
        storage.availability = "available";
        storage.evidence = "observed";
        storage.limitations = [
          "Registered private fixture store is open with the pinned SQLite backend; NTFS OS-request publication is not power-cut tested.",
        ];
      }
      return report;
    },
  });
  const facade: ApplicationFacade = {
    async invoke(request, auth, signal) {
      if (stopping) throw new ApplicationError("ACTION_REQUIRED", 409);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abort, { once: true });
      invocations.add(controller);
      active++;
      try {
        return await internalFacade.invoke(request, auth, controller.signal);
      } finally {
        active--;
        invocations.delete(controller);
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
  async function revisionResult(
    id: string,
    context: OperationContext,
  ): Promise<ApplicationResult> {
    const revision = unwrap(await store.getRevision(id, context));
    const actual = await readBytes(revision.content, context);
    const design = parseContract(
      "DesignIR",
      Buffer.from(actual.bytes).toString("utf8"),
      "json",
    );
    if (
      !FIXTURE_IDS.some((fixture) => revision.designId === `design_${fixture}`)
    )
      throw new ApplicationError("FORBIDDEN", 403);
    return {
      kind: "json",
      etag: `"${revision.content.sha256}"`,
      envelope: success(context.requestId, {
        kind: "revision",
        revision,
        design,
        warnings: [],
      }),
    };
  }
  async function execute(
    request: Invocation,
    context: OperationContext,
  ): Promise<ApplicationResult> {
    const id = request.id ?? "";
    if (!jobs) throw new ApplicationError("ACTION_REQUIRED");
    switch (request.operation) {
      case "acceptFixture": {
        const body = parseContract(
          "FoundationAcceptFixtureRequest",
          JSON.stringify(request.body),
          "json",
        );
        const fixture = [...semantics.entries()].find(
          ([key]) => key === body.fixtureId,
        )?.[1];
        if (!fixture || fixture.design.designId !== id)
          throw new ApplicationError("FORBIDDEN", 403);
        const identity = logicalIdentity(
          policy.actorId,
          "write",
          request.requestId,
        );
        const oldRevision = await store.getRevision(
          identity.revisionId,
          context,
        );
        const createdAt =
          oldRevision.status === "complete"
            ? oldRevision.value.createdAt
            : oldRevision.status !== "partial" &&
                oldRevision.error.code === "NOT_FOUND"
              ? new Date(clock.now()).toISOString()
              : unwrap(oldRevision).createdAt;
        const outputs = new Map<string, StagedArtifact>();
        retained = true;
        const pipeline = new AssetPipeline({
          filesystem: files,
          rightsAuthority: fixture.rightsAuthority,
          authorize: async (ctx, root, operation) => {
            authorizeOperation(
              ctx,
              {
                projectId: PROJECT_ID,
                resourceKind: "artifact",
                resourceId: root,
                operation,
              },
              policy.verify,
            );
            return { permissionScope: PERMISSION_SCOPE, offlineAllowed: true };
          },
        });
        const prepared = await pipeline.stageSnapshot(
          ARTIFACT_ROOT,
          fixture.assets,
          context,
        );
        for (const staged of prepared.staged)
          outputs.set(staged.artifact.sha256, staged);
        async function stage(bytes: Uint8Array) {
          const digest = hashBytes(bytes);
          let staged = outputs.get(digest);
          if (!staged) {
            staged = unwrap(await store.stage(bytes, context));
            outputs.set(digest, staged);
          }
          return staged;
        }
        for (const entry of fixture.references) await stage(entry.bytes);
        const content = await stage(fixture.contentBytes);
        const provenance = await stage(fixture.provenanceBytes);
        const bindings: LogicalArtifactBinding[] = fixture.references
          .map((entry) => ({
            reference: entry.reference,
            artifact: physical(entry.bytes),
          }))
          .filter((entry) => entry.reference.id !== entry.artifact.id);
        const revision: Revision = {
          schemaVersion: "1.0",
          id: identity.revisionId,
          projectId: PROJECT_ID,
          designId: id,
          parents: body.base ? [body.base.expectedBaseRevision] : [],
          content: ref(content.artifact),
          resources: fixture.design.resources,
          provenance: ref(provenance.artifact),
          actorId: policy.actorId,
          createdAt,
          changeSource: "import",
        };
        const receipt = unwrap(
          await store.commitRevision(
            {
              branch: body.branch,
              base: body.base,
              revision,
              outputs: [...outputs.values()],
              referenceBindings: bindings,
            },
            context,
          ),
        );
        return {
          kind: "json",
          status: 201,
          etag: `"${revision.content.sha256}"`,
          envelope: success(context.requestId, {
            kind: "revision",
            revision,
            design: fixture.design,
            receipt,
            warnings: fixture.diagnostics,
          }),
        };
      }
      case "getDesign": {
        const head = unwrap(
          await store.getHead(id, request.parameters.branch ?? "main", context),
        );
        if (!head) throw new ApplicationError("NOT_FOUND", 404);
        const scoped = await policy.issue({
          requestId: context.requestId,
          signal: context.signal,
          deadline: context.deadline,
          sourceAuthority: () => policy.verify(context.authorization),
          grants: [
            ...context.authorization.grants,
            {
              resourceKind: "revision",
              resourceId: head,
              operations: ["read"],
            },
          ],
        });
        return revisionResult(head, scoped);
      }
      case "getRevision":
        return revisionResult(id, context);
      case "submitRender": {
        const body = parseContract(
          "FoundationRenderSubmissionRequest",
          JSON.stringify(request.body),
          "json",
        );
        const revision = unwrap(
          await store.getRevision(body.revision.id, context),
        );
        if (
          revision.designId !== id ||
          revision.content.sha256 !== body.revision.sha256
        )
          throw new ApplicationError("CONFLICT", 412);
        const current = await discover(context.signal);
        const existing = current.descriptors.find(
          (entry) => entry.jobId === context.jobId,
        );
        if (
          !existing &&
          (current.nextCursor || current.descriptors.length >= 100)
        )
          throw new ApplicationError("ACTION_REQUIRED", 409);
        const prior = existing
          ? unwrap(await store.jobs.get(existing.jobId, context))
          : undefined;
        const job = unwrap(
          await jobs.submit(
            {
              id: context.jobId ?? "",
              operation: "render",
              input: revision.content,
              resources: revision.resources,
              inputRevision: body.revision,
              handlerId: `fixture-render-${body.mode}`,
              handlerVersion: "1.0.0",
              authorityRef: policyId,
              resourceKeys: ["fixture-renderer"],
              deadline: prior?.submission.deadline ?? context.deadline,
              budget: { ...DEFAULT_BUDGETS },
            },
            context,
          ),
        );
        if (
          job.status !== "queued" &&
          job.status !== "running" &&
          job.status !== "retry-wait" &&
          job.status !== "waiting-for-user"
        ) {
          const versioned = unwrap(await jobs.getVersioned(job.id, context));
          return {
            kind: "json",
            envelope: success(context.requestId, {
              kind: "job",
              job: versioned.job,
              jobVersion: versioned.rowVersion,
              warnings: [],
            }),
          };
        }
        return {
          kind: "json",
          status: 202,
          envelope: success(context.requestId, {
            kind: "accepted-job",
            jobId: job.id,
            status: job.status,
            warnings: [],
          }),
        };
      }
      case "waitJob": {
        while (clock.now() < Date.parse(context.deadline)) {
          const value = await versionedValue(id, context);
          if (
            [
              "completed",
              "failed",
              "cancelled",
              "waiting-for-user",
              "interrupted",
            ].includes(value.job.status)
          )
            return jobResult(id, context, value);
          await clock.sleep(
            Math.min(
              250,
              Math.max(1, Date.parse(context.deadline) - clock.now()),
            ),
            context.signal,
          );
        }
        throw new ApplicationError("DEADLINE_EXCEEDED", 504, id);
      }
      case "getJob":
        return versionedJob(id, context);
      case "cancelJob": {
        const version = Number(
          request.ifMatch?.slice(request.ifMatch.lastIndexOf(":") + 1, -1),
        );
        const result = unwrap(await jobs.cancel(id, version, context));
        return {
          kind: "json",
          etag: jobEtag(id, result.rowVersion),
          envelope: success(context.requestId, {
            kind: "job",
            job: result.job,
            jobVersion: result.rowVersion,
            warnings: [],
          }),
        };
      }
      case "getArtifact":
      case "readArtifact": {
        const artifact = await readBytes(
          { id, sha256: request.parameters.sha256 ?? "" },
          context,
        );
        return request.operation === "getArtifact"
          ? {
              kind: "json",
              envelope: success(context.requestId, {
                kind: "artifact",
                artifact: artifact.artifact,
                warnings: [],
              }),
            }
          : {
              kind: "binary",
              mediaType: "application/octet-stream",
              bytes: artifact.bytes,
            };
      }
      case "getPreview": {
        const record = unwrap(await store.jobs.get(id, context));
        const receipt = unwrap(await store.jobs.getJobReceipt(id, context));
        if (
          !receipt ||
          record.job.status !== "completed" ||
          !record.inputRevision
        )
          throw new ApplicationError("ACTION_REQUIRED", 409);
        const evidenceArtifact = receipt.outputs[5];
        const preview = receipt.outputs[0];
        if (!evidenceArtifact || !preview || receipt.outputs.length !== 6)
          throw new ApplicationError("ARTIFACT_INTEGRITY");
        const evidence = await readBytes(ref(evidenceArtifact), context);
        const png = await readBytes(ref(preview), context);
        const verified = verifyPreviewBytes(
          receipt.outputs,
          evidence.bytes,
          png.bytes,
          {
            revision: record.inputRevision,
            inputSha256: record.job.input.sha256,
            resourcesSha256: record.job.resources.sha256,
            artifactRootId: ARTIFACT_ROOT,
          },
          context.budget,
        );
        return {
          kind: "binary",
          mediaType: verified.mediaType,
          bytes: verified.bytes,
          draft: true,
        };
      }
      default:
        throw new ApplicationError("NOT_FOUND", 404);
    }
  }
  async function versionedJob(
    id: string,
    context: OperationContext,
  ): Promise<ApplicationResult> {
    if (!jobs) throw new ApplicationError("ACTION_REQUIRED");
    const result = await versionedValue(id, context);
    return jobResult(id, context, result);
  }
  async function versionedValue(
    id: string,
    context: OperationContext,
  ): Promise<VersionedJob> {
    if (
      !jobs ||
      !policy.verify(context.authorization) ||
      context.signal.aborted ||
      clock.now() >= Date.parse(context.deadline)
    )
      throw new ApplicationError("FORBIDDEN", 403);
    let current = await descriptor(id, context.signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const readContext = await policy.issue({
        requestId: context.requestId,
        jobId: id,
        signal: context.signal,
        deadline: context.deadline,
        sourceAuthority: () => policy.verify(context.authorization),
        grants: [
          policy.rootGrant,
          ...catalogGrants,
          ...descriptorGrants(current),
        ],
      });
      const result = await jobs.getVersioned(id, readContext);
      if (result.status === "complete") return result.value;
      if (result.error.code !== "FORBIDDEN" || current.status === "completed")
        return unwrap(result);
      const newer = await descriptor(id, context.signal);
      if (newer.status !== "completed") return unwrap(result);
      current = newer;
    }
    throw new ApplicationError("CONFLICT", 409);
  }
  function jobResult(
    id: string,
    context: OperationContext,
    result: VersionedJob,
  ): ApplicationResult {
    return {
      kind: "json",
      etag: jobEtag(id, result.rowVersion),
      envelope: success(context.requestId, {
        kind: "job",
        job: result.job,
        jobVersion: result.rowVersion,
        warnings: [],
      }),
    };
  }
  const application = {
    facade,
    newClient,
    async call(
      request: Invocation,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<ApplicationResult> {
      return facade.invoke(request, localAuthorization, signal);
    },
    async close() {
      return stopApplication({
        stopAdmissions: () => {
          stopping = true;
          for (const controller of invocations) controller.abort();
          for (const entry of transportSessions.splice(0))
            entry.authenticator.revoke(entry.authorization);
        },
        stopJobs: async (timeout) => {
          if (!jobs) throw new ApplicationError("INTERNAL_ERROR");
          return jobs.stop(timeout);
        },
        drainRequests: async () => {
          const deadline = clock.now() + 10000;
          while (active && clock.now() < deadline)
            await clock.sleep(25, new AbortController().signal);
          if (active) throw new ApplicationError("INTERRUPTED");
        },
        closeStore: () => store.close(),
        closeHost: async () => {
          outputCapabilities.clear();
          policy.revoke();
          if (!retained) await files.close();
        },
        closeBinding: () => binding.close(),
      });
    },
  };
  await startOwnedApplication(async () => {
    if (!jobs) throw new ApplicationError("INTERNAL_ERROR");
    unwrap(await jobs.start());
  }, application.close);
  return application;
}
