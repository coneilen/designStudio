import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ArtifactReference,
  type AuthorizationContext,
  DEFAULT_BUDGETS,
  type OperationContext,
  type Outcome,
  parseContract,
  type Revision,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  hashBytes,
  resolveDesign,
} from "@design-studio/design-ir";
import {
  authorizeOperation,
  LocalSessionAuthenticator,
  ProjectFileSystem,
  SystemClock,
  snapshotOperationContext,
  WINDOWS_PUBLICATION_PROFILE,
} from "@design-studio/host";
import { expect, test } from "vitest";
import {
  LocalStore,
  type LogicalArtifactBinding,
  type StorageOptions,
} from "../src/index.js";

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
  if (outcome.status !== "complete")
    throw new Error("Native binding test failed.");
  return outcome.value;
}

test.runIf(process.platform === "win32" && process.arch === "x64")(
  "fresh native v4 accepts unchanged fixture locks and bootstraps a fresh narrow issuer after restart",
  async () => {
    const fixture = resolve("tests\\fixtures\\foundation");
    const rawResources = new Uint8Array(
      await readFile(join(fixture, "resources.json")),
    );
    const resources = parseContract(
      "ResourceSnapshot",
      new TextDecoder().decode(rawResources),
      "json",
    );
    const design = parseContract(
      "DesignIR",
      await readFile(join(fixture, "settings-screen.design.json"), "utf8"),
      "json",
    );
    const provenance = new Uint8Array(
      await readFile(join(fixture, "settings-screen.provenance.json")),
    );
    const content = canonicalBytes(design);
    expect(hashBytes(rawResources)).toBe(
      "0bb106f87cc8293727acee68c32d4a5bd83d44690ab1020b6301bdbaf6c502d9",
    );
    expect(design.resources.snapshotId).toBe("resources_synthetic");
    const dependencies = [
      ...resources.assets.flatMap((asset) => [
        asset.artifact,
        asset.license.notice,
      ]),
      ...resources.fonts.flatMap((font) =>
        font.kind === "bundled"
          ? [font.artifact, font.license.notice]
          : [font.license.notice],
      ),
    ];
    const payloads = [
      { logical: undefined, bytes: content },
      { logical: undefined, bytes: provenance },
      {
        logical: { id: resources.id, sha256: hashBytes(rawResources) },
        bytes: rawResources,
      },
      ...(await Promise.all(
        dependencies.map(async (artifact) => ({
          logical: { id: artifact.id, sha256: artifact.sha256 },
          bytes: new Uint8Array(
            await readFile(join(fixture, ...artifact.path.split("/"))),
          ),
        })),
      )),
    ];
    const root = await mkdtemp(join(tmpdir(), "bound-native "));
    const artifactPath = join(root, "artifacts");
    await mkdir(artifactPath);
    const clock = new SystemClock();
    const issuer = new LocalSessionAuthenticator({
      clock,
      hosts: ["127.0.0.1:47119"],
      origins: ["http://127.0.0.1:47119"],
    });
    const projectId = design.projectId;
    const artifactRootId = "fixture-artifacts";
    const rootGrant: AuthorizationContext["grants"][number] = {
      resourceKind: "artifact",
      resourceId: artifactRootId,
      operations: ["read", "write"],
    };
    let sequence = 0;
    const issue = (
      requestId: string,
      jobId: string,
      grants: AuthorizationContext["grants"],
    ): OperationContext => {
      const credentials = issuer.createSession(
        {
          schemaVersion: "1.0",
          projectId,
          actorId: "fixture-owner",
          sessionId: `fixture-${++sequence}`,
          expiresAt: new Date(clock.now() + 120000).toISOString(),
          egress: "deny",
          grants,
        },
        "cli",
      );
      return {
        schemaVersion: "1.0",
        projectId,
        requestId,
        jobId,
        deadline: new Date(clock.now() + 30000).toISOString(),
        authorization: issuer.authenticate({
          remoteAddress: "127.0.0.1",
          host: "127.0.0.1:47119",
          method: "POST",
          bearer: credentials.credential,
        }),
        clock,
        budget: { ...DEFAULT_BUDGETS },
        signal: new AbortController().signal,
      };
    };
    const physical = (bytes: Uint8Array) => ({
      id: `sha256_${hashBytes(bytes)}`,
      sha256: hashBytes(bytes),
    });
    const artifactGrants = (
      refs: ArtifactReference[],
    ): AuthorizationContext["grants"] =>
      [...new Set(refs.map((ref) => ref.id))].map((id) => ({
        resourceKind: "artifact",
        resourceId: id,
        operations: ["read", "write"],
      }));
    const grants: AuthorizationContext["grants"] = [
      rootGrant,
      ...artifactGrants(
        payloads.flatMap((item) => [
          physical(item.bytes),
          ...(item.logical ? [item.logical] : []),
        ]),
      ),
      {
        resourceKind: "design",
        resourceId: design.designId,
        operations: ["read", "write"],
      },
      {
        resourceKind: "revision",
        resourceId: "accepted-fixture",
        operations: ["read", "write"],
      },
      {
        resourceKind: "job",
        resourceId: "accept-job",
        operations: ["read", "write"],
      },
      {
        resourceKind: "job",
        resourceId: "render-job",
        operations: ["read", "write"],
      },
    ];
    let store: LocalStore | undefined;
    let files: ProjectFileSystem | undefined;
    const open = async () => {
      files = await ProjectFileSystem.create({
        projectId,
        authority: issuer.authority,
        publicationProfile: WINDOWS_PUBLICATION_PROFILE,
        roots: [
          {
            id: artifactRootId,
            path: artifactPath,
            access: "read-write",
            managedBlobs: true,
            trustedExclusiveAccess: true,
          },
        ],
      });
      const boundary = files;
      const deny = async (): Promise<never> => {
        throw new Error("Not authorized by this fixture.");
      };
      const options: StorageOptions = {
        projectId,
        artifactRootId,
        permissionScope: "fixture-policy",
        databasePath: join(root, "state.sqlite"),
        nativeBinding: resolve(
          ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
        ),
        snapshotOperationContext,
        fileSystem: boundary,
        canonicalBytes,
        attestLocalDatabase: async (path, scope) => {
          expect(path).toBe(join(root, "state.sqlite"));
          expect(scope).toEqual({
            projectId,
            artifactRootId,
            permissionScope: "fixture-policy",
          });
        },
        authorize: async (ctx, scope) =>
          authorizeOperation(ctx, scope, issuer.authority),
        ensurePublicationDurable: async (artifacts, ctx) => {
          value(
            await boundary.ensurePublicationDurable(
              artifactRootId,
              artifacts,
              ctx,
            ),
          );
        },
        ensureDatabaseBackupDurable: deny,
        authorizeArtifactBinding: async (binding, evidence, ctx) => {
          authorizeOperation(
            ctx,
            {
              projectId,
              actorId: "fixture-owner",
              resourceKind: "artifact",
              resourceId: binding.reference.id,
              operation: "write",
            },
            issuer.authority,
          );
          const known = payloads.find(
            (item) =>
              item.logical?.id === binding.reference.id &&
              item.logical.sha256 === binding.reference.sha256,
          );
          if (
            !known ||
            hashBytes(evidence.bytes) !== hashBytes(known.bytes) ||
            evidence.artifact.id !== physical(known.bytes).id
          )
            throw new Error("Untrusted catalog binding.");
        },
        verifyRevision: async (revision, _ctx, evidence) => {
          const resourceEvidence = evidence.find(
            (item) => item.reference.id === resources.id,
          );
          expect(resourceEvidence?.bytes).toEqual(rawResources);
          expect(resourceEvidence?.artifact.id).toBe(physical(rawResources).id);
          expect(revision.resources).toEqual(design.resources);
          expect(
            resolveDesign(design, resources, {
              resourceBytes: resourceEvidence?.bytes,
            }).closure?.integrity,
          ).toBe("verified-bytes");
        },
        assessApproval: deny,
        authorizeRestore: deny,
        authorizeRetention: deny,
        canDiscardStage: async () => false,
        maintenance: {
          inventory: async (ctx, max) =>
            value(await boundary.inventory(artifactRootId, ctx, max)),
          removeBlob: deny,
        },
        jobs: {
          clock,
          verifyCompletion: deny,
          authorizeRecovery: deny,
          discovery: {
            authorizeOwner: async (ctx, scope) => {
              expect(scope).toEqual({
                projectId,
                artifactRootId,
                permissionScope: "fixture-policy",
              });
              authorizeOperation(
                ctx,
                {
                  projectId,
                  actorId: "fixture-owner",
                  resourceKind: "artifact",
                  resourceId: artifactRootId,
                  operation: "read",
                },
                issuer.authority,
              );
            },
          },
        },
      };
      store = await LocalStore.open(options);
      return store;
    };
    try {
      let current = await open();
      const accept = issue("accept", "accept-job", grants);
      const outputs = [];
      const referenceBindings: LogicalArtifactBinding[] = [];
      for (const item of payloads) {
        const staged = value(await current.stage(item.bytes, accept));
        expect(staged.artifact.id).toBe(physical(item.bytes).id);
        outputs.push(staged);
        if (item.logical)
          referenceBindings.push({
            reference: item.logical,
            artifact: physical(item.bytes),
          });
      }
      const revision: Revision = {
        schemaVersion: "1.0",
        id: "accepted-fixture",
        projectId,
        designId: design.designId,
        parents: [],
        content: physical(content),
        provenance: physical(provenance),
        resources: design.resources,
        actorId: "fixture-owner",
        createdAt: "2026-09-16T00:00:00Z",
        changeSource: "import",
      };
      const receipt = value(
        await current.commitRevision(
          { revision, base: null, branch: "main", outputs, referenceBindings },
          accept,
        ),
      );
      expect(receipt.outputs).toEqual(outputs.map((item) => item.artifact));
      const render = issue("render-request", "render-job", grants);
      const queued = value(
        await current.jobs.create(
          {
            id: "render-job",
            operation: "render",
            input: physical(content),
            resources: design.resources,
            inputRevision: { id: revision.id, sha256: revision.content.sha256 },
            handlerId: "fixture-render",
            handlerVersion: "v1",
            authorityRef: "fixture-policy",
            resourceKeys: [],
            deadline: render.deadline,
            budget: { ...DEFAULT_BUDGETS },
          },
          render,
        ),
      );
      current.close();
      await files?.close();
      current = await open();
      const observer = issue("discovery", "discovery-job", [rootGrant]);
      const descriptor = value(
        await current.jobs.discoverOwned(
          { jobId: queued.job.id, limit: 1 },
          observer,
        ),
      ).descriptors[0];
      if (
        !descriptor ||
        descriptor.inputRevision?.designId !== design.designId ||
        descriptor.handlerId !== "fixture-render" ||
        descriptor.authorityRef !== "fixture-policy"
      )
        throw new Error("Descriptor failed fixed catalog issuance policy.");
      const narrow = issue(descriptor.requestId, descriptor.jobId, [
        rootGrant,
        {
          resourceKind: "job",
          resourceId: descriptor.jobId,
          operations: ["read", "write"],
        },
        {
          resourceKind: "revision",
          resourceId: descriptor.inputRevision.id,
          operations: ["read"],
        },
        ...artifactGrants(
          descriptor.physicalInputs.flatMap((item) => [
            item.reference,
            item.artifact,
          ]),
        ),
      ]);
      expect(value(await current.jobs.get(descriptor.jobId, narrow))).toEqual(
        queued,
      );
      expect(
        value(
          await current.verify(
            { id: resources.id, sha256: design.resources.sha256 },
            narrow,
          ),
        ),
      ).toEqual(outputs[2]?.artifact);
      expect(
        value(await current.jobs.scan({ states: ["queued"], limit: 1 }, narrow))
          .records[0]?.job.id,
      ).toBe(queued.job.id);
      expect(
        value(
          await current.jobs.claim(
            queued.job.id,
            { state: "queued", rowVersion: queued.rowVersion },
            "fresh-worker",
            1000,
            narrow,
          ),
        ).job.status,
      ).toBe("running");
      expect(design.resources.snapshotId).toBe("resources_synthetic");
    } finally {
      store?.close();
      await files?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
