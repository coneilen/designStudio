import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ApprovalContext,
  type Artifact,
  type ArtifactReference,
  type ArtifactStore,
  type CaptureRecoveryAuthorization,
  type CommitReceipt,
  type ContractError,
  type ContractName,
  type ContractTypes,
  type ErrorCode,
  type ExpectedBase,
  type OperationContext,
  type Outcome,
  parseContract,
  type ReviewEvent,
  type Revision,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import Database from "better-sqlite3";
import { backupMetadata } from "./backup-codec.js";
import {
  ArtifactBindings,
  BINDING_LIMITS,
  bindingKey,
  bindings,
} from "./bindings.js";
import {
  type CaptureRecoveryEvidence,
  type CaptureRecoveryState,
  isCaptureRecoveryKey,
  originalRecoveryState,
  recoveryKey,
} from "./capture-recovery.js";
import { openDatabase } from "./database.js";
import { storedResource, storedStage } from "./job-codec.js";
import type { JobRepository, JobSubmission } from "./job-types.js";
import { type JobCommitHooks, StoredJobs } from "./jobs.js";
import {
  type BackupMetadata,
  type LogicalArtifactBinding,
  type ProjectBackup,
  type RecoveryReport,
  type RetentionPin,
  type RevisionCommit,
  StorageError,
  type StorageOptions,
  type StorageScope,
  type StoredReview,
} from "./types.js";

export { decodeBackup, encodeBackup } from "./backup-codec.js";
export { BINDING_LIMITS } from "./bindings.js";
export {
  type CaptureRecoveryEvidence,
  type CaptureRecoveryState,
  originalRecoveryState,
  recoveryKey,
} from "./capture-recovery.js";
export { JOB_LIMITS as JOB_STORAGE_LIMITS } from "./job-codec.js";
export * from "./job-types.js";
export * from "./types.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const blobPath = (digest: string) => `blobs/${digest}`;
const portableBlob = /^blobs\/[a-f0-9]{64}$/;
const stateKinds = new Set<ReviewEvent["kind"]>([
  "draft",
  "in-review",
  "changes-requested",
  "approved",
  "superseded",
]);

function check<K extends ContractName>(
  name: K,
  input: unknown,
): ContractTypes[K] {
  const result = validateContract(name, input);
  if (!result.success)
    throw new StorageError(
      "INVALID_INPUT",
      `Invalid ${name}: ${result.issues.map((issue) => issue.code).join(", ")}.`,
    );
  return result.value;
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status !== "complete")
    throw new BoundaryFailure(
      outcome.status === "partial" ? "failed" : outcome.status,
      outcome.error,
    );
  return outcome.value;
}
class BoundaryFailure extends Error {
  readonly code: ErrorCode;
  constructor(
    readonly status: "failed" | "unavailable" | "cancelled" | "interrupted",
    readonly detail: ContractError,
  ) {
    super(`Host boundary ${status}: ${detail.code}.`);
    this.code = detail.code;
  }
}
function revisionRefs(revision: Revision): ArtifactReference[] {
  return [
    revision.content,
    revision.provenance,
    { id: revision.resources.snapshotId, sha256: revision.resources.sha256 },
  ];
}
function approvalRefs(context: ApprovalContext): ArtifactReference[] {
  return [
    context.revision,
    { id: context.resources.snapshotId, sha256: context.resources.sha256 },
    context.scenario,
    context.reference,
    context.renderProfile,
    context.validationPolicy,
  ];
}

export class LocalStore implements ArtifactStore {
  readonly jobs: JobRepository;
  private readonly jobStore: StoredJobs;
  private readonly bindingStore: ArtifactBindings;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active = 0;
  private removal:
    | { artifact: Artifact; context: OperationContext }
    | undefined;
  private inputBytes = 0;
  private startedAt = 0;
  private readonly authorizationSnapshots = new WeakMap<
    OperationContext,
    string
  >();

  private constructor(
    private readonly db: Database.Database,
    private readonly options: StorageOptions,
  ) {
    this.bindingStore = new ArtifactBindings(db);
    this.jobStore = new StoredJobs({
      db,
      options,
      captureRecovery: (id, context) =>
        this.captureRecoveryEvidence(id, context),
      captureRecoveryForNext: async (context) => {
        if (!this.options.captureRecovery || !context.jobId) return null;
        const reserved = await this.findCaptureRecovery(context.jobId, context);
        return reserved
          ? this.captureRecoveryEvidence(
              reserved.proposal.originalJobId,
              context,
            )
          : null;
      },
      verifyCaptureRecovery: (input, context) =>
        this.verifyCaptureRecoverySubmission(input, context),
      run: (context, operation, action) => this.run(context, operation, action),
      snapshot: (input, context, operation, action) =>
        this.snapshot(input, context, operation, action),
      guard: (context, operation, kind, id) =>
        this.guard(context, operation, kind, id),
      checkpoint: (context) => this.checkpoint(context),
      digest: (value) => this.digest(value),
      read: (artifact, context) => this.read(artifact, context),
      artifact: (reference) => this.artifact(reference),
      authorizeReference: (reference, context) =>
        this.authorizeReference(reference, context),
      describeRevision: (reference) => {
        const revision = this.row("revisions", reference.id, "Revision");
        if (
          !revision ||
          revision.projectId !== options.projectId ||
          revision.content.sha256 !== reference.sha256
        )
          throw new StorageError(
            "INTEGRITY",
            "Discovery input revision binding is inconsistent.",
          );
        return { ...reference, designId: revision.designId };
      },
      hasCommittedPublication: (artifact) =>
        this.hasCommittedPublication(artifact),
      refs: (kind, id, references) => this.refs(kind, id, references),
      stage: (bytes, context) => this.stageBytes(bytes, context),
      commit: (outputs, context, request, hooks) =>
        this.commitInternal(outputs, context, request, hooks),
      verifyInputRevision: async (reference, context) => {
        check("ArtifactReference", reference);
        await this.guard(context, "read", "revision", reference.id);
        const revision = this.row("revisions", reference.id, "Revision");
        if (!revision || revision.content.sha256 !== reference.sha256)
          throw new StorageError(
            "CONFLICT",
            "Input revision must identify accepted content.",
          );
      },
    });
    this.jobs = this.jobStore;
  }

  static async open(options: StorageOptions): Promise<LocalStore> {
    const recovery = options.captureRecovery;
    if (recovery) {
      if (
        typeof recovery.authorize !== "function" ||
        typeof recovery.verify !== "function" ||
        typeof recovery.verifyIssuance !== "function"
      )
        throw new StorageError(
          "INVALID_INPUT",
          "Capture recovery requires the native proof verifiers.",
        );
      options = {
        ...options,
        captureRecovery: Object.freeze({
          authorize: recovery.authorize.bind(recovery),
          verify: recovery.verify.bind(recovery),
          verifyIssuance: recovery.verifyIssuance.bind(recovery),
        }),
      };
    }
    check("StableId", options.projectId);
    check("StableId", options.artifactRootId);
    check("StableId", options.permissionScope);
    const db = await openDatabase(options);
    try {
      return new LocalStore(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.active !== 0)
      throw new StorageError(
        "CONFLICT",
        "Wait for in-flight storage operations before closing.",
      );
    this.closed = true;
    this.db.close();
  }

  private checkpoint(context: OperationContext): void {
    this.checkAuthorization(context);
    if (this.closed) throw new StorageError("IO_FAILURE", "Store is closed.");
    if (context.signal.aborted)
      throw new StorageError("CANCELLED", "Storage operation was cancelled.");
    if (context.clock.now() >= Date.parse(context.deadline))
      throw new StorageError("DEADLINE", "Storage deadline expired.");
    if (context.clock.now() - this.startedAt >= context.budget.maxDurationMs)
      throw new StorageError("DEADLINE", "Storage duration budget expired.");
  }
  private ownContext(context: OperationContext): OperationContext {
    const { signal, clock, authorization, ...metadata } = context;
    check("OperationRequestContext", { ...metadata, authorization });
    const authorizationJson = JSON.stringify(authorization);
    const owned = structuredClone(metadata);
    Object.freeze(owned.budget);
    const snapshot = this.options.snapshotOperationContext
      ? this.options.snapshotOperationContext(context)
      : Object.freeze({ ...owned, authorization, signal, clock });
    const {
      authorization: receivedAuthorization,
      signal: receivedSignal,
      clock: receivedClock,
      ...receivedMetadata
    } = snapshot;
    if (
      !Object.isFrozen(snapshot) ||
      !Object.isFrozen(snapshot.budget) ||
      receivedAuthorization !== authorization ||
      receivedSignal !== signal ||
      receivedClock !== clock ||
      !isDeepStrictEqual(owned, receivedMetadata)
    )
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "Context snapshot must own frozen metadata and preserve trusted runtime references.",
      );
    const previous = this.authorizationSnapshots.get(snapshot);
    if (
      JSON.stringify(authorization) !== authorizationJson ||
      (previous !== undefined && previous !== authorizationJson)
    )
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "A reused context cannot replace its captured authorization.",
      );
    this.authorizationSnapshots.set(snapshot, authorizationJson);
    return snapshot;
  }
  private checkAuthorization(context: OperationContext): void {
    const baseline = this.authorizationSnapshots.get(context);
    if (baseline === undefined)
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "Storage operation lacks its captured authorization provenance.",
      );
    const result = validateContract(
      "AuthorizationContext",
      context.authorization,
    );
    if (!result.success || JSON.stringify(context.authorization) !== baseline)
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "Authorization changed during the storage operation.",
      );
  }

  private async guard(
    context: OperationContext,
    operation: "read" | "write",
    kind: StorageScope["resourceKind"] = "artifact",
    id = this.options.artifactRootId,
  ): Promise<void> {
    if (operation === "write" && this.options.access === "read-only")
      throw new StorageError(
        "AUTHORIZATION_CHANGED",
        "This connection is read-only.",
      );
    const { signal: _signal, clock: _clock, ...request } = context;
    check("OperationRequestContext", request);
    if (context.projectId !== this.options.projectId)
      throw new StorageError("INVALID_INPUT", "Cross-project storage request.");
    this.checkpoint(context);
    await this.options.authorize(context, {
      projectId: this.options.projectId,
      resourceKind: kind,
      resourceId: id,
      operation,
    });
    this.checkpoint(context);
  }

  private async run<T>(
    context: OperationContext,
    operation: "read" | "write",
    action: (context: OperationContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    const identity = {
      projectId: context.projectId,
      requestId: context.requestId,
    };
    let captureError: unknown;
    try {
      context = this.ownContext(context);
    } catch (error) {
      captureError = error;
    }
    this.active++;
    const execute = async (): Promise<Outcome<T>> => {
      try {
        if (captureError !== undefined) throw captureError;
        this.inputBytes = 0;
        this.startedAt = context.clock.now();
        await this.guard(context, operation);
        const result = await action(context);
        this.checkAuthorization(context);
        return this.success(result, context);
      } catch (error) {
        const code =
          error instanceof StorageError
            ? error.code
            : error instanceof Database.SqliteError &&
                error.code.startsWith("SQLITE_CONSTRAINT")
              ? "CONFLICT"
              : "IO_FAILURE";
        const mapped: Partial<Record<typeof code, ErrorCode>> = {
          INTEGRITY: "ARTIFACT_INTEGRITY",
          INVALID_INPUT: "INVALID_INPUT",
          SCHEMA_INCOMPATIBLE: "UNSUPPORTED_SCHEMA_VERSION",
          LIMIT: "INPUT_LIMIT",
          CONFLICT: "CONFLICT",
          APPROVAL_INAPPLICABLE: "APPROVAL_REQUIRED",
          CANCELLED: "CANCELLED",
          DEADLINE: "DEADLINE_EXCEEDED",
          IO_FAILURE: "INTERNAL_ERROR",
          NOT_FOUND: "EVIDENCE_MISSING",
          AUTHORIZATION_CHANGED: "FORBIDDEN",
        };
        const external =
          error instanceof Error && "code" in error
            ? validateContract("ErrorCode", error.code)
            : null;
        return {
          schemaVersion: "1.0",
          projectId: identity.projectId,
          requestId: identity.requestId,
          status:
            error instanceof BoundaryFailure
              ? error.status
              : code === "CANCELLED"
                ? "cancelled"
                : "failed",
          error: {
            code: external?.success
              ? external.value
              : (mapped[code] ?? "INTERNAL_ERROR"),
            message:
              error instanceof BoundaryFailure
                ? error.message
                : error instanceof StorageError
                  ? `${code}: ${error.message}`
                  : `${code}: Storage or injected authority failed; no uncommitted result accepted.`,
            retryable:
              error instanceof BoundaryFailure ? error.detail.retryable : false,
            diagnosticIds: [],
          },
          diagnosticIds: [],
        };
      } finally {
        this.active--;
      }
    };
    const result = this.queue.then(execute, execute);
    this.queue = result;
    return result;
  }

  private success<T>(value: T, context: OperationContext): Outcome<T> {
    return {
      schemaVersion: "1.0",
      projectId: context.projectId,
      requestId: context.requestId,
      status: "complete",
      value,
      diagnosticIds: [],
    };
  }

  private digest(value: unknown): string {
    return hash(this.options.canonicalBytes(value));
  }
  private equal(a: unknown, b: unknown): boolean {
    return this.digest(a) === this.digest(b);
  }
  private snapshot<T, R>(
    input: T,
    context: OperationContext,
    operation: "read" | "write",
    action: (snapshot: T) => Promise<Outcome<R>>,
  ): Promise<Outcome<R>> {
    try {
      check("JsonValue", input);
      if (
        Buffer.byteLength(JSON.stringify(input), "utf8") >
        context.budget.maxInputBytes
      )
        throw new StorageError(
          "LIMIT",
          "Storage request exceeds metadata byte budget.",
        );
      return action(structuredClone(input));
    } catch (error) {
      return this.run(context, operation, async () => {
        throw error;
      });
    }
  }
  private row<K extends ContractName>(
    table: "artifacts" | "revisions",
    id: string,
    contract: K,
  ): ContractTypes[K] | undefined {
    const result = this.db
      .prepare<[string], { data: string }>(
        `SELECT data FROM ${table} WHERE id=?`,
      )
      .get(id);
    return result ? parseContract(contract, result.data, "json") : undefined;
  }
  private artifact(
    reference: ArtifactReference,
    verifyBinding = true,
  ): Artifact {
    const binding = this.bindingStore.get(reference);
    if (binding && this.row("artifacts", reference.id, "Artifact"))
      throw new StorageError(
        "INTEGRITY",
        "Logical binding shadows a physical artifact.",
      );
    const artifact = this.row(
      "artifacts",
      binding?.artifact.id ?? reference.id,
      "Artifact",
    );
    if (!artifact || artifact.sha256 !== reference.sha256)
      throw new StorageError(
        "NOT_FOUND",
        "Pinned artifact is unavailable in this project.",
      );
    if (binding && verifyBinding) this.bindingEvidence(binding, artifact);
    return artifact;
  }
  private bindingEvidence(
    binding: LogicalArtifactBinding & { receiptId: string },
    artifact: Artifact,
  ): void {
    if (
      binding.artifact.id !== artifact.id ||
      binding.artifact.sha256 !== artifact.sha256
    )
      throw new StorageError(
        "INTEGRITY",
        "Binding target differs from physical artifact.",
      );
    const receiptRows = this.db
      .prepare<[string], { scope: string; data: string }>(
        "SELECT scope,data FROM receipts WHERE json_extract(data,'$.id')=? LIMIT 2",
      )
      .all(binding.receiptId);
    const row = receiptRows[0];
    if (receiptRows.length !== 1 || !row)
      throw new StorageError(
        "INTEGRITY",
        "Binding lacks its committed receipt.",
      );
    const receipt = parseContract("CommitReceipt", row.data, "json");
    const scope = receipt.idempotency;
    const expected = this.jobStore.tracked(receipt.jobId)
      ? this.jobStore.receiptScope(this.jobStore.load(receipt.jobId))
      : JSON.stringify([
          this.options.projectId,
          scope.actorId,
          "write",
          scope.key,
        ]);
    if (
      row.scope !== expected ||
      receipt.projectId !== this.options.projectId ||
      scope.projectId !== this.options.projectId ||
      (this.jobStore.tracked(receipt.jobId)
        ? !this.jobStore.receiptConsistent(
            this.jobStore.load(receipt.jobId),
            receipt,
          )
        : scope.operation !== "write") ||
      !receipt.outputs.some((output) => this.equal(output, artifact)) ||
      !this.db
        .prepare(
          "SELECT 1 FROM artifact_refs WHERE owner_kind='binding' AND owner_id=? AND artifact_id=?",
        )
        .get(bindingKey(binding.reference), artifact.id) ||
      !this.db
        .prepare(
          "SELECT 1 FROM artifact_refs WHERE owner_kind='job' AND owner_id=? AND artifact_id=?",
        )
        .get(receipt.id, artifact.id)
    )
      throw new StorageError(
        "INTEGRITY",
        "Binding publication/protection graph is inconsistent.",
      );
  }
  private async authorizeReference(
    reference: ArtifactReference,
    context: OperationContext,
    legacyPhysical = false,
  ): Promise<void> {
    if (legacyPhysical && this.row("artifacts", reference.id, "Artifact"))
      return;
    await this.guard(context, "read", "artifact", reference.id);
    const binding = this.bindingStore.get(reference);
    if (binding)
      await this.guard(context, "read", "artifact", binding.artifact.id);
  }
  private async read(
    artifact: Artifact,
    context: OperationContext,
  ): Promise<Uint8Array> {
    check("Artifact", artifact);
    if (artifact.path !== blobPath(artifact.sha256))
      throw new StorageError("INTEGRITY", "Artifact is not content-addressed.");
    if (artifact.byteLength > context.budget.maxInputBytes)
      throw new StorageError("LIMIT", "Artifact exceeds input byte budget.");
    this.inputBytes += artifact.byteLength;
    if (this.inputBytes > context.budget.maxSnapshotAssetBytes)
      throw new StorageError(
        "LIMIT",
        "Aggregate storage reads exceed snapshot byte budget.",
      );
    const bytes = unwrap(
      await this.options.fileSystem.read(
        { artifactRootId: this.options.artifactRootId, path: artifact.path },
        context,
      ),
    );
    try {
      this.checkpoint(context);
      if (
        bytes.byteLength !== artifact.byteLength ||
        hash(bytes) !== artifact.sha256
      )
        throw new StorageError(
          "INTEGRITY",
          "Artifact byte length or SHA-256 mismatch.",
        );
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  private refs(
    kind: string,
    owner: string,
    references: ArtifactReference[],
  ): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO artifact_refs VALUES (?,?,?)",
    );
    for (const reference of references) {
      const artifact = this.artifact(reference, false);
      insert.run(kind, owner, artifact.id);
    }
  }
  private putArtifact(artifact: Artifact): void {
    this.bindingStore.checkPhysical(artifact);
    const prior = this.row("artifacts", artifact.id, "Artifact");
    if (prior && !this.equal(prior, artifact))
      throw new StorageError("CONFLICT", "Artifact identity is immutable.");
    if (!prior)
      this.db
        .prepare("INSERT INTO artifacts VALUES (?,?,?,?)")
        .run(
          artifact.id,
          artifact.sha256,
          artifact.path,
          JSON.stringify(artifact),
        );
  }

  stage(
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<StagedArtifact>> {
    // Copy before the first await so caller mutation cannot alter accepted bytes.
    const snapshot =
      bytes.length <= context.budget.maxInputBytes &&
      bytes.length <= context.budget.maxOutputBytes
        ? Uint8Array.from(bytes)
        : null;
    return this.run(context, "write", async (context) => {
      if (snapshot === null)
        throw new StorageError(
          "LIMIT",
          "Staged bytes exceed operation budget.",
        );
      return this.stageBytes(snapshot, context);
    });
  }
  private async stageBytes(
    snapshot: Uint8Array,
    context: OperationContext,
  ): Promise<StagedArtifact> {
    const sha256 = hash(snapshot);
    const staged = unwrap(
      await this.options.fileSystem.stage(
        {
          artifactRootId: this.options.artifactRootId,
          path: blobPath(sha256),
        },
        snapshot,
        context,
      ),
    );
    check("Artifact", staged.artifact);
    check("StableId", staged.stagingId);
    if (
      staged.artifact.sha256 !== sha256 ||
      staged.artifact.byteLength !== snapshot.length ||
      staged.artifact.path !== blobPath(sha256)
    ) {
      throw new StorageError(
        "INTEGRITY",
        "Staging receipt differs from supplied bytes.",
      );
    }
    return staged;
  }

  verify(
    reference: ArtifactReference,
    context: OperationContext,
  ): Promise<Outcome<Artifact>> {
    return this.snapshot(reference, context, "read", (reference) =>
      this.run(context, "read", async (context) => {
        check("ArtifactReference", reference);
        await this.authorizeReference(reference, context, true);
        const artifact = this.artifact(reference);
        await this.read(artifact, context);
        return artifact;
      }),
    );
  }

  readVerified(
    reference: ArtifactReference,
    context: OperationContext,
  ): Promise<Outcome<{ artifact: Artifact; bytes: Uint8Array }>> {
    return this.snapshot(reference, context, "read", (reference) =>
      this.run(context, "read", async (context) => {
        check("ArtifactReference", reference);
        await this.authorizeReference(reference, context, true);
        const artifact = this.artifact(reference);
        return { artifact, bytes: await this.read(artifact, context) };
      }),
    );
  }

  commit(
    outputs: StagedArtifact[],
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt>> {
    return this.snapshot(outputs, context, "write", (snapshot) =>
      this.commitInternal(snapshot, context),
    );
  }
  private recoveryConfiguration() {
    const config = this.options.captureRecovery;
    if (!config)
      throw new StorageError(
        "ACTION_REQUIRED",
        "Capture recovery is not admitted.",
      );
    return config;
  }
  private recoveryState(): CaptureRecoveryState {
    let remaining = 26214400;
    const boundedTable = (table: string, expression: string, limit = 20000) => {
      const size = this.db
        .prepare<[], { count: number; bytes: number }>(
          `SELECT count(*) AS count,COALESCE(sum(${expression}),0) AS bytes FROM ${table}`,
        )
        .get();
      if (!size || size.count > limit || size.bytes > remaining)
        throw new StorageError(
          "LIMIT",
          "Capture recovery metadata exceeds its bound.",
        );
      remaining -= size.bytes;
    };
    const rows = (
      table: "jobs" | "job_resources" | "job_stages" | "artifacts" | "receipts",
    ) => {
      boundedTable(
        table,
        "length(CAST(data AS BLOB))",
        table === "jobs" ? 1000 : 20000,
      );
      const values = this.db
        .prepare<[], { data: string }>(
          `SELECT data FROM ${table} ORDER BY data LIMIT 20001`,
        )
        .all();
      if (values.length > (table === "jobs" ? 1000 : 20000))
        throw new StorageError(
          "LIMIT",
          "Capture recovery inspection exceeds its bound.",
        );
      return values;
    };
    boundedTable(
      "receipts",
      "length(CAST(scope AS BLOB))+length(CAST(data AS BLOB))",
    );
    boundedTable(
      "artifact_refs",
      "length(owner_kind)+length(owner_id)+length(artifact_id)",
    );
    const receipts = this.db
      .prepare<[], { scope: string; data: string }>(
        "SELECT scope,data FROM receipts ORDER BY scope LIMIT 20001",
      )
      .all();
    const references = this.db
      .prepare<[], CaptureRecoveryState["references"][number]>(
        "SELECT owner_kind AS kind,owner_id AS owner,artifact_id AS artifactId FROM artifact_refs ORDER BY owner_kind,owner_id,artifact_id LIMIT 20001",
      )
      .all();
    if (receipts.length > 20000 || references.length > 20000)
      throw new StorageError(
        "LIMIT",
        "Capture recovery references exceed their bound.",
      );
    const other = [
      "revisions",
      "heads",
      "reviews",
      "pins",
      "artifact_bindings",
    ].map((table) => {
      boundedTable(
        table,
        table === "heads"
          ? "length(design)+length(branch)+length(revision)"
          : "length(CAST(data AS BLOB))",
      );
      const data = this.db.prepare(`SELECT * FROM ${table} LIMIT 20001`).all();
      if (data.length > 20000)
        throw new StorageError(
          "LIMIT",
          "Capture recovery metadata exceeds its bound.",
        );
      return data.map((item) => this.digest(item)).sort();
    });
    const state: CaptureRecoveryState = {
      jobs: rows("jobs")
        .map((row) =>
          this.jobStore.load(check("Job", JSON.parse(row.data).job).id),
        )
        .sort((a, b) => a.job.id.localeCompare(b.job.id)),
      resources: rows("job_resources")
        .map((row) => storedResource(JSON.parse(row.data)))
        .sort((a, b) => a.key.localeCompare(b.key)),
      stages: rows("job_stages")
        .map((row) => storedStage(JSON.parse(row.data)))
        .sort((a, b) => a.stagingId.localeCompare(b.stagingId)),
      artifacts: rows("artifacts")
        .map((row) => parseContract("Artifact", row.data, "json"))
        .sort((a, b) => a.id.localeCompare(b.id)),
      receipts: receipts.map((row) => ({
        scope: row.scope,
        receipt: parseContract("CommitReceipt", row.data, "json"),
      })),
      references,
      otherSha256: this.digest(other),
    };
    if (this.options.canonicalBytes(state).byteLength > 26214400)
      throw new StorageError(
        "LIMIT",
        "Capture recovery metadata bytes exceed their bound.",
      );
    const artifacts = new Map(state.artifacts.map((item) => [item.id, item]));
    const jobs = new Map(state.jobs.map((item) => [item.job.id, item]));
    const owners = new Map<string, Set<string>>();
    for (const item of state.references) {
      const key = JSON.stringify([item.kind, item.owner]);
      const references = owners.get(key) ?? new Set<string>();
      references.add(item.artifactId);
      owners.set(key, references);
    }
    const assertReferences = (kind: string, id: string, expected: string[]) => {
      const key = JSON.stringify([kind, id]);
      const actual = owners.get(key) ?? new Set<string>();
      if (!this.equal([...actual].sort(), [...new Set(expected)].sort()))
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery protection graph is inconsistent.",
        );
      owners.delete(key);
    };
    const published = new Set<string>();
    const completedJobs = new Set<string>();
    for (const { scope, receipt } of state.receipts) {
      const tracked = jobs.get(receipt.jobId);
      if (tracked) completedJobs.add(tracked.job.id);
      const expected = tracked
        ? this.jobStore.receiptScope(tracked)
        : JSON.stringify([
            this.options.projectId,
            receipt.idempotency.actorId,
            "write",
            receipt.idempotency.key,
          ]);
      if (
        scope !== expected ||
        receipt.projectId !== this.options.projectId ||
        receipt.idempotency.projectId !== this.options.projectId ||
        (tracked
          ? !this.jobStore.receiptConsistent(tracked, receipt)
          : receipt.idempotency.operation !== "write")
      )
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery receipt scope is inconsistent.",
        );
      for (const output of receipt.outputs) {
        if (!this.equal(artifacts.get(output.id), output))
          throw new StorageError(
            "INTEGRITY",
            "Capture recovery receipt output is inconsistent.",
          );
        published.add(output.id);
      }
      assertReferences(
        "job",
        receipt.id,
        receipt.outputs.map((item) => item.id),
      );
    }
    for (const job of state.jobs) {
      if (
        Boolean(job.job.receipt) !== completedJobs.has(job.job.id) ||
        (job.job.status === "completed" && !completedJobs.has(job.job.id)) ||
        (job.finalOutputSha256 !== undefined && !completedJobs.has(job.job.id))
      )
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery job receipt is missing.",
        );
      const references = this.jobStore.inputRefs(job);
      if (
        references.some(
          (item) => artifacts.get(item.id)?.sha256 !== item.sha256,
        )
      )
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery job input is inconsistent.",
        );
      assertReferences(
        "job-input",
        job.job.id,
        references.map((item) => item.id),
      );
    }
    if (owners.size || state.artifacts.some((item) => !published.has(item.id)))
      throw new StorageError(
        "INTEGRITY",
        "Capture recovery has unowned metadata.",
      );
    return state;
  }
  captureRecoveryState(
    context: OperationContext,
  ): Promise<Outcome<CaptureRecoveryState>> {
    return this.run(context, "read", async (context) => {
      await this.recoveryConfiguration().authorize(context);
      return this.recoveryState();
    });
  }
  referencePublicationState(
    context: OperationContext,
  ): Promise<Outcome<CaptureRecoveryState>> {
    return this.run(context, "read", async (context) => {
      const admission = this.options.referenceInspection;
      if (!admission)
        throw new StorageError(
          "AUTHORIZATION_CHANGED",
          "Reference inspection is not admitted.",
        );
      await admission.authorize(context);
      const state = this.recoveryState();
      await admission.authorize(context);
      return state;
    });
  }
  referenceJobMetadata(id: string, context: OperationContext) {
    return this.run(context, "read", async (context) => {
      const admission = this.options.referenceInspection;
      if (!admission)
        throw new StorageError(
          "AUTHORIZATION_CHANGED",
          "Reference inspection is not admitted.",
        );
      await admission.authorize(context);
      const metadata = await this.jobStore.referenceMetadata(id, context);
      await admission.authorize(context);
      return metadata;
    });
  }
  private async captureRecoveryEvidence(
    originalJobId: string,
    context: OperationContext,
  ): Promise<CaptureRecoveryEvidence | null> {
    check("StableId", originalJobId);
    const config = this.recoveryConfiguration();
    await config.authorize(context);
    const receipt = this.receipt(recoveryKey(originalJobId), context);
    if (!receipt) return null;
    const output = receipt.outputs[0];
    if (!output || receipt.outputs.length !== 1 || output.byteLength > 65536)
      throw new StorageError("INTEGRITY", "Invalid capture recovery receipt.");
    const bytes = await this.read(output, context);
    let authorization: CaptureRecoveryAuthorization;
    try {
      authorization = parseContract(
        "CaptureRecoveryAuthorization",
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        "json",
        { maxInputBytes: 65536 },
      );
      if (this.digest(authorization) !== output.sha256)
        throw new StorageError(
          "INTEGRITY",
          "Noncanonical capture recovery evidence.",
        );
    } finally {
      bytes.fill(0);
    }
    if (authorization.proposal.originalJobId !== originalJobId)
      throw new StorageError(
        "INTEGRITY",
        "Capture recovery original identity changed.",
      );
    const evidence = {
      authorization,
      artifact: { id: output.id, sha256: output.sha256 },
      receipt,
    };
    const state = this.recoveryState();
    if (
      this.digest(
        originalRecoveryState(state, evidence, (value) => this.digest(value)),
      ) !== authorization.storageSha256
    )
      throw new StorageError("CONFLICT", "Capture recovery baseline changed.");
    await config.verify(evidence, state, context);
    this.checkpoint(context);
    return evidence;
  }
  private async verifyCaptureRecoverySubmission(
    input: JobSubmission,
    context: OperationContext,
  ): Promise<() => void> {
    if (!input.captureRecovery) {
      if (
        this.options.captureRecovery &&
        (await this.findCaptureRecovery(input.id, context))
      )
        throw new StorageError(
          "CONFLICT",
          "This next request requires its reserved capture authorization.",
        );
      return () => {};
    }
    check("CaptureRecoveryBinding", input.captureRecovery);
    const evidence = await this.captureRecoveryEvidence(
      input.captureRecovery.originalJobId,
      context,
    );
    if (
      !evidence ||
      this.digest(evidence.artifact) !==
        this.digest(input.captureRecovery.authorization) ||
      evidence.authorization.proposal.nextJobId !== input.id ||
      evidence.authorization.proposal.nextRequestId !== context.requestId ||
      input.input.sha256 !== this.digest(evidence.authorization.nextRequest) ||
      input.resources.sha256 !==
        this.digest(evidence.authorization.nextResources)
    )
      throw new StorageError(
        "CONFLICT",
        "Capture recovery does not bind this submission.",
      );
    return () => {
      this.checkpoint(context);
      if (
        this.digest(
          originalRecoveryState(this.recoveryState(), evidence, (value) =>
            this.digest(value),
          ),
        ) !== evidence.authorization.storageSha256
      )
        throw new StorageError(
          "CONFLICT",
          "Capture recovery changed before submission.",
        );
    };
  }
  commitCaptureRecovery(
    authorization: CaptureRecoveryAuthorization,
    output: StagedArtifact,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt>> {
    return this.snapshot({ authorization, output }, context, "write", (owned) =>
      this.commitInternal(
        [owned.output],
        context,
        undefined,
        undefined,
        owned.authorization,
      ),
    );
  }
  private async findCaptureRecovery(
    nextJobId: string,
    context: OperationContext,
  ): Promise<CaptureRecoveryAuthorization | null> {
    const candidates = this.db
      .prepare<[string, string], { scope: string; key: string }>(
        "SELECT scope,json_extract(data,'$.idempotency.key') AS key FROM receipts WHERE json_extract(data,'$.idempotency.projectId')=? AND json_extract(data,'$.idempotency.actorId')=? AND json_extract(data,'$.idempotency.operation')='write' AND substr(json_extract(data,'$.idempotency.key'),1,17)='recovery_capture_' LIMIT 20001",
      )
      .all(context.projectId, context.authorization.actorId);
    if (candidates.length > 20000)
      throw new StorageError(
        "LIMIT",
        "Capture recovery key inspection exceeds its bound.",
      );
    const rows = candidates.filter((row) => isCaptureRecoveryKey(row.key));
    if (rows.length > 1000)
      throw new StorageError(
        "LIMIT",
        "Capture recovery lookup exceeds its bound.",
      );
    let found: CaptureRecoveryAuthorization | null = null;
    for (const row of rows) {
      if (row.scope !== this.scope(row.key, context))
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery receipt scope changed.",
        );
      const receipt = this.receipt(row.key, context);
      if (!receipt)
        throw new StorageError(
          "INTEGRITY",
          "Capture recovery receipt disappeared.",
        );
      const output = receipt.outputs[0];
      if (!output || receipt.outputs.length !== 1 || output.byteLength > 65536)
        throw new StorageError(
          "INTEGRITY",
          "Invalid capture recovery lookup evidence.",
        );
      const bytes = await this.read(output, context);
      try {
        const grant = parseContract(
          "CaptureRecoveryAuthorization",
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          "json",
          { maxInputBytes: 65536 },
        );
        const key = recoveryKey(grant.proposal.originalJobId);
        if (
          grant.proposal.projectId !== context.projectId ||
          grant.proposal.actorId !== context.authorization.actorId ||
          this.digest(grant) !== output.sha256 ||
          receipt.jobId !== key ||
          receipt.idempotency.key !== key ||
          !this.equal(this.receipt(key, context), receipt)
        )
          throw new StorageError(
            "INTEGRITY",
            "Capture recovery lookup scope changed.",
          );
        if (grant.proposal.nextJobId === nextJobId) {
          if (found)
            throw new StorageError(
              "CONFLICT",
              "Multiple capture authorizations reserve this next request.",
            );
          found = grant;
        }
      } finally {
        bytes.fill(0);
      }
    }
    return found;
  }
  commitRevision(
    request: RevisionCommit,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt>> {
    return this.snapshot(request, context, "write", (snapshot) =>
      this.commitInternal(snapshot.outputs, context, snapshot),
    );
  }
  private scope(key: string, context: OperationContext): string {
    return JSON.stringify([
      this.options.projectId,
      context.authorization.actorId,
      "write",
      key,
    ]);
  }
  private receipt(
    key: string,
    context: OperationContext,
  ): CommitReceipt | null {
    const row = this.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM receipts WHERE scope=?",
      )
      .get(this.scope(key, context));
    return row ? parseContract("CommitReceipt", row.data, "json") : null;
  }
  getReceipt(
    key: string,
    context: OperationContext,
  ): Promise<Outcome<CommitReceipt | null>> {
    return this.run(context, "read", async (context) => {
      check("StableId", key);
      const receipt = this.receipt(key, context);
      if (receipt) {
        await this.guard(context, "read", "job", receipt.jobId);
        for (const artifact of receipt.outputs)
          await this.read(artifact, context);
      }
      return receipt;
    });
  }
  private commitInternal(
    outputs: StagedArtifact[],
    context: OperationContext,
    request?: RevisionCommit,
    hooks?: JobCommitHooks,
    recovery?: CaptureRecoveryAuthorization,
  ): Promise<Outcome<CommitReceipt>> {
    return this.run(context, "write", async (context) => {
      if (!context.jobId)
        throw new StorageError(
          "INVALID_INPUT",
          "Committing requires a jobId for a durable receipt.",
        );
      await this.guard(context, "write", "job", context.jobId);
      let recoveryBaseline: string | undefined;
      if (recovery) {
        check("CaptureRecoveryAuthorization", recovery);
        const key = recoveryKey(recovery.proposal.originalJobId);
        if (
          context.jobId !== key ||
          context.requestId !== key ||
          context.projectId !== recovery.proposal.projectId ||
          context.authorization.actorId !== recovery.proposal.actorId ||
          outputs.length !== 1 ||
          outputs[0]?.artifact.sha256 !== this.digest(recovery) ||
          this.options.canonicalBytes(recovery).byteLength > 65536
        )
          throw new StorageError(
            "CONFLICT",
            "Capture recovery commit is not byte/owner bound.",
          );
        const state = this.recoveryState();
        recoveryBaseline = this.digest(state);
        await this.recoveryConfiguration().authorize(context);
        if (
          await this.findCaptureRecovery(recovery.proposal.nextJobId, context)
        )
          throw new StorageError(
            "CONFLICT",
            "Capture recovery next request is already reserved.",
          );
        await this.recoveryConfiguration().verifyIssuance(
          recovery,
          state,
          context,
        );
      } else if (
        this.options.captureRecovery &&
        isCaptureRecoveryKey(context.requestId)
      ) {
        throw new StorageError(
          "AUTHORIZATION_CHANGED",
          "Capture recovery control identity is reserved.",
        );
      }
      const checkRecovery = () => {
        if (
          recoveryBaseline !== undefined &&
          this.digest(this.recoveryState()) !== recoveryBaseline
        )
          throw new StorageError(
            "CONFLICT",
            "Capture recovery state changed before commit.",
          );
      };
      if (hooks) await hooks.prepare(context);
      else this.jobStore.assertLegacyAvailable(context);
      const suppliedBindings =
        hooks?.payload.referenceBindings ?? request?.referenceBindings;
      const bound =
        suppliedBindings === undefined ? [] : bindings(suppliedBindings);
      if (bound.length && !this.options.authorizeArtifactBinding)
        throw new StorageError(
          "AUTHORIZATION_CHANGED",
          "Logical bindings require trusted composition.",
        );
      this.bindingStore.bounds();
      this.bindingStore.admit(bound);
      this.boundRows("receipts");
      for (const item of bound) {
        await this.guard(context, "write", "artifact", item.reference.id);
        await this.guard(context, "read", "artifact", item.artifact.id);
        await this.guard(context, "write", "artifact", item.artifact.id);
        this.bindingStore.validate(item);
        if (
          !outputs.some(
            (output) =>
              output.artifact.id === item.artifact.id &&
              output.artifact.sha256 === item.artifact.sha256,
          ) ||
          outputs.some((output) => output.artifact.id === item.reference.id) ||
          bound.some((other) => other.reference.id === item.artifact.id)
        )
          throw new StorageError(
            "CONFLICT",
            "Bindings require exact declared physical outputs without chains/shadowing.",
          );
      }
      if (outputs.length > 20000)
        throw new StorageError("LIMIT", "Too many outputs.");
      for (const output of outputs) {
        check("Artifact", output.artifact);
        check("StableId", output.stagingId);
      }
      if (
        new Set(outputs.map((item) => item.artifact.id)).size !== outputs.length
      )
        throw new StorageError("INVALID_INPUT", "Duplicate output IDs.");
      const total = outputs.reduce(
        (sum, item) => sum + item.artifact.byteLength,
        0,
      );
      if (total > context.budget.maxOutputBytes)
        throw new StorageError("LIMIT", "Commit exceeds output byte budget.");
      if (request) {
        check("Revision", request.revision);
        check("StableId", request.branch);
        if (request.base !== null) check("ExpectedBase", request.base);
        await this.guard(context, "write", "design", request.revision.designId);
      }
      const payload = {
        outputs: outputs
          .map((item) => item.artifact)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        revision: request
          ? {
              revision: request.revision,
              base: request.base,
              branch: request.branch,
            }
          : null,
        ...(hooks
          ? {
              completion: {
                outputState: hooks.payload.outputState,
                diagnosticIds: hooks.payload.diagnosticIds,
                comparisonVerdict: hooks.payload.comparisonVerdict ?? null,
                sourceStatus: hooks.payload.sourceStatus ?? null,
              },
            }
          : {}),
        ...(suppliedBindings !== undefined ? { referenceBindings: bound } : {}),
      };
      const digest = this.digest(payload);
      const receiptScope =
        hooks?.scope() ?? this.scope(context.requestId, context);
      const priorRow = this.db
        .prepare<[string], { data: string }>(
          "SELECT data FROM receipts WHERE scope=?",
        )
        .get(receiptScope);
      const prior = priorRow
        ? parseContract("CommitReceipt", priorRow.data, "json")
        : null;
      if (prior) {
        if (
          prior.idempotency.payloadSha256 !== digest ||
          prior.jobId !== context.jobId
        )
          throw new StorageError(
            "CONFLICT",
            "Idempotency key was reused with a different payload/job.",
          );
        for (const artifact of prior.outputs)
          await this.read(artifact, context);
        for (const item of bound) this.artifact(item.reference);
        return prior;
      }
      hooks?.check(context);
      if (request) await this.validateRevision(request, context);
      const published: Artifact[] = [];
      const needsPublicationBarrier: Artifact[] = [];
      for (const staged of outputs) {
        this.checkpoint(context);
        const existing = this.row("artifacts", staged.artifact.id, "Artifact");
        if (existing && !this.equal(existing, staged.artifact))
          throw new StorageError("CONFLICT", "Artifact identity is immutable.");
        // Only an exact output in a trusted committed transaction can carry
        // historical barrier assurance across a host-process restart.
        const reusable = existing && this.hasCommittedPublication(existing);
        const artifact = reusable
          ? existing
          : unwrap(await this.options.fileSystem.publish(staged, context));
        if (!this.equal(artifact, staged.artifact))
          throw new StorageError(
            "INTEGRITY",
            "Publication changed artifact identity.",
          );
        await this.read(artifact, context);
        published.push(artifact);
        if (!reusable) needsPublicationBarrier.push(artifact);
      }
      for (const item of bound) {
        const artifact = published.find(
          (artifact) => artifact.id === item.artifact.id,
        );
        if (!artifact)
          throw new StorageError("INTEGRITY", "Binding output is missing.");
        const authorize = this.options.authorizeArtifactBinding;
        if (!authorize)
          throw new StorageError(
            "AUTHORIZATION_CHANGED",
            "Binding authority is unavailable.",
          );
        const bytes = await this.read(artifact, context);
        await authorize(
          structuredClone(item),
          {
            artifact: structuredClone(artifact),
            bytes: Uint8Array.from(bytes),
          },
          context,
        );
        this.checkpoint(context);
      }
      if (request) {
        const evidence = [];
        for (const reference of revisionRefs(request.revision)) {
          const proposed = bound.find(
            (item) => bindingKey(item.reference) === bindingKey(reference),
          );
          const target = proposed?.artifact ?? reference;
          if (!published.some((artifact) => artifact.id === reference.id))
            await this.authorizeReference(reference, context, true);
          if (proposed)
            await this.guard(context, "read", "artifact", proposed.artifact.id);
          const artifact =
            published.find(
              (item) => item.id === target.id && item.sha256 === target.sha256,
            ) ?? this.artifact(reference);
          evidence.push({
            reference,
            artifact,
            bytes: await this.read(artifact, context),
          });
        }
        await this.options.verifyRevision(request.revision, context, evidence);
      }
      if (hooks) {
        const evidence = [];
        for (const artifact of published)
          evidence.push({
            artifact,
            bytes: await this.read(artifact, context),
          });
        await hooks.verify(evidence, context);
      }
      if (needsPublicationBarrier.length !== 0)
        await this.options.ensurePublicationDurable(
          needsPublicationBarrier,
          context,
        );
      await this.guard(context, "write");
      await this.guard(context, "write", "job", context.jobId);
      if (request)
        await this.guard(context, "write", "design", request.revision.designId);
      if (hooks)
        for (const artifact of published)
          await this.guard(context, "write", "artifact", artifact.id);
      for (const item of bound) {
        await this.guard(context, "write", "artifact", item.reference.id);
        await this.guard(context, "read", "artifact", item.artifact.id);
        await this.guard(context, "write", "artifact", item.artifact.id);
      }
      this.checkpoint(context);
      const receipt: CommitReceipt = {
        schemaVersion: "1.0",
        id: `receipt-${this.digest([receiptScope, digest])}`,
        projectId: this.options.projectId,
        jobId: context.jobId,
        idempotency: {
          key: context.requestId,
          projectId: this.options.projectId,
          actorId: hooks?.actorId() ?? context.authorization.actorId,
          operation: hooks?.operation() ?? "write",
          payloadSha256: digest,
        },
        committedAt: new Date(context.clock.now()).toISOString(),
        outputs: published,
        integrity: "verified",
        publication: "atomic",
      };
      check("CommitReceipt", receipt);
      this.checkpoint(context);
      this.db.transaction(() => {
        checkRecovery();
        if (hooks) hooks.check(context);
        else this.jobStore.assertLegacyAvailable(context);
        for (const artifact of published) this.putArtifact(artifact);
        // Receipt and bindings precede reference resolution, but share the same rollback boundary.
        this.db
          .prepare("INSERT INTO receipts VALUES (?,?)")
          .run(receiptScope, JSON.stringify(receipt));
        this.refs("job", receipt.id, published);
        for (const item of bound)
          this.bindingStore.put({ ...item, receiptId: receipt.id });
        if (hooks) this.options.fault?.("job-after-artifacts");
        if (request) {
          this.checkBase(request);
          const rev = request.revision;
          this.db
            .prepare("INSERT INTO revisions VALUES (?,?,?)")
            .run(rev.id, rev.designId, JSON.stringify(rev));
          this.refs("revision", rev.id, revisionRefs(rev));
          this.db
            .prepare(
              "INSERT INTO heads VALUES (?,?,?) ON CONFLICT(design,branch) DO UPDATE SET revision=excluded.revision",
            )
            .run(rev.designId, request.branch, rev.id);
        }
        if (hooks) this.options.fault?.("job-after-receipt");
        this.options.fault?.("before-commit");
        this.checkpoint(context);
        if (hooks) {
          hooks.check(context);
          hooks.finish(receipt, context);
        }
        if (recovery) {
          const output = published[0];
          if (
            !output ||
            this.digest(
              originalRecoveryState(
                this.recoveryState(),
                {
                  authorization: recovery,
                  artifact: { id: output.id, sha256: output.sha256 },
                  receipt,
                },
                (value) => this.digest(value),
              ),
            ) !== recovery.storageSha256
          )
            throw new StorageError(
              "CONFLICT",
              "Capture recovery state changed during commit.",
            );
        }
        for (const item of bound) this.artifact(item.reference);
        this.checkpoint(context);
      })();
      // Once committed, cancellation or a lost response cannot undo the receipt.
      try {
        this.options.fault?.("after-commit");
      } catch {
        return receipt;
      }
      return receipt;
    });
  }
  private hasCommittedPublication(artifact: Artifact): boolean {
    this.boundRows("receipts");
    const rows = this.db
      .prepare<[string], { scope: string; data: string }>(`
      SELECT receipts.scope, receipts.data FROM receipts
      JOIN artifact_refs ON artifact_refs.owner_kind='job'
        AND artifact_refs.owner_id=json_extract(receipts.data,'$.id')
      WHERE artifact_refs.artifact_id=?
    `)
      .all(artifact.id);
    for (const row of rows) {
      const receipt = parseContract("CommitReceipt", row.data, "json");
      const scope = receipt.idempotency;
      const tracked = this.jobStore.tracked(receipt.jobId);
      const jobBound =
        tracked &&
        this.jobStore.receiptConsistent(
          this.jobStore.load(receipt.jobId),
          receipt,
        );
      if (
        receipt.projectId !== this.options.projectId ||
        scope.projectId !== this.options.projectId ||
        (!jobBound && scope.operation !== "write") ||
        row.scope !==
          (jobBound
            ? this.jobStore.receiptScope(this.jobStore.load(receipt.jobId))
            : JSON.stringify([
                this.options.projectId,
                scope.actorId,
                scope.operation,
                scope.key,
              ]))
      )
        continue;
      if (receipt.outputs.some((output) => this.equal(output, artifact)))
        return true;
    }
    return false;
  }
  private checkBase(request: RevisionCommit): void {
    const head = this.db
      .prepare<[string, string], { revision: string }>(
        "SELECT revision FROM heads WHERE design=? AND branch=?",
      )
      .get(request.revision.designId, request.branch);
    if (request.base === null) {
      if (head || request.revision.parents.length !== 0)
        throw new StorageError(
          "CONFLICT",
          "Only a new root branch accepts a null base.",
        );
    } else {
      const base = this.row(
        "revisions",
        request.base.expectedBaseRevision,
        "Revision",
      );
      if (
        !base ||
        head?.revision !== base.id ||
        request.base.ifMatch !== `"${base.content.sha256}"` ||
        request.revision.parents[0] !== base.id
      )
        throw new StorageError(
          "CONFLICT",
          "Stale expected base or nonmatching strong If-Match.",
        );
    }
    if (this.row("revisions", request.revision.id, "Revision"))
      throw new StorageError("CONFLICT", "Revision IDs are immutable.");
  }
  private async validateRevision(
    request: RevisionCommit,
    context: OperationContext,
  ): Promise<void> {
    const rev = request.revision;
    if (
      rev.projectId !== this.options.projectId ||
      rev.actorId !== context.authorization.actorId
    )
      throw new StorageError(
        "INVALID_INPUT",
        "Revision project/actor does not match authority.",
      );
    this.checkBase(request);
    if (new Set(rev.parents).size !== rev.parents.length)
      throw new StorageError("INVALID_INPUT", "Duplicate revision parents.");
    for (const parent of rev.parents) {
      const value = this.row("revisions", parent, "Revision");
      if (!value || value.designId !== rev.designId)
        throw new StorageError(
          "CONFLICT",
          "Parent must be an accepted revision of this design.",
        );
    }
  }
  getRevision(
    id: string,
    context: OperationContext,
  ): Promise<Outcome<Revision>> {
    return this.run(context, "read", async (context) => {
      check("StableId", id);
      await this.guard(context, "read", "revision", id);
      const revision = this.row("revisions", id, "Revision");
      if (!revision)
        throw new StorageError("NOT_FOUND", "Revision does not exist.");
      return revision;
    });
  }
  getHead(
    designId: string,
    branch: string,
    context: OperationContext,
  ): Promise<Outcome<string | null>> {
    return this.run(context, "read", async (context) => {
      check("StableId", designId);
      check("StableId", branch);
      await this.guard(context, "read", "design", designId);
      return (
        this.db
          .prepare<[string, string], { revision: string }>(
            "SELECT revision FROM heads WHERE design=? AND branch=?",
          )
          .get(designId, branch)?.revision ?? null
      );
    });
  }
  forkBranch(
    designId: string,
    branch: string,
    base: ExpectedBase,
    context: OperationContext,
  ): Promise<Outcome<string>> {
    return this.snapshot(
      { designId, branch, base },
      context,
      "write",
      (request) =>
        this.run(context, "write", async (context) => {
          check("StableId", request.designId);
          check("StableId", request.branch);
          check("ExpectedBase", request.base);
          await this.guard(context, "write", "design", request.designId);
          await this.guard(
            context,
            "read",
            "revision",
            request.base.expectedBaseRevision,
          );
          const revision = this.row(
            "revisions",
            request.base.expectedBaseRevision,
            "Revision",
          );
          if (
            !revision ||
            revision.designId !== request.designId ||
            request.base.ifMatch !== `"${revision.content.sha256}"`
          )
            throw new StorageError(
              "CONFLICT",
              "Fork base must identify an accepted revision with its exact strong If-Match.",
            );
          for (const reference of revisionRefs(revision)) {
            await this.authorizeReference(reference, context, true);
            await this.read(this.artifact(reference), context);
          }
          this.checkpoint(context);
          this.db
            .prepare("INSERT INTO heads VALUES (?,?,?)")
            .run(request.designId, request.branch, revision.id);
          return revision.id;
        }),
    );
  }

  private reviews(designId: string): StoredReview[] {
    this.boundRows("reviews", designId);
    return this.db
      .prepare<[string], { hash: string; data: string }>(
        "SELECT hash,data FROM reviews WHERE design=? ORDER BY sequence",
      )
      .all(designId)
      .map((row) => {
        const event = parseContract("ReviewEvent", row.data, "json");
        if (this.digest(event) !== row.hash)
          throw new StorageError("INTEGRITY", "Stored review digest mismatch.");
        return { reference: { id: event.id, sha256: row.hash }, event };
      });
  }
  listReviews(
    designId: string,
    context: OperationContext,
  ): Promise<Outcome<StoredReview[]>> {
    return this.run(context, "read", async (context) => {
      check("StableId", designId);
      await this.guard(context, "read", "design", designId);
      return this.reviews(designId);
    });
  }
  private async approvalContext(
    approval: ApprovalContext,
    context: OperationContext,
  ): Promise<void> {
    check("ApprovalContext", approval);
    if (approval.projectId !== this.options.projectId)
      throw new StorageError("INVALID_INPUT", "Cross-project approval.");
    await this.guard(context, "read", "design", approval.designId);
    this.boundRows("revisions", approval.designId);
    const revisions = this.db
      .prepare<[string], { data: string }>(
        "SELECT data FROM revisions WHERE design=?",
      )
      .all(approval.designId);
    const accepted = revisions.some((row) => {
      const revision = parseContract("Revision", row.data, "json");
      return (
        this.equal(revision.content, approval.revision) &&
        this.equal(revision.resources, approval.resources)
      );
    });
    if (!accepted)
      throw new StorageError(
        "APPROVAL_INAPPLICABLE",
        "Approval does not bind an accepted revision/resource lock.",
      );
    for (const reference of approvalRefs(approval)) {
      await this.authorizeReference(reference, context, true);
      await this.read(this.artifact(reference), context);
    }
  }
  private async approvalEvidence(
    event: ReviewEvent,
    context: OperationContext,
  ): Promise<void> {
    const assessment = await this.options.assessApproval(
      event.context,
      context,
    );
    if (!assessment.complete || assessment.blockingDiagnosticIds.length !== 0)
      throw new StorageError(
        "APPROVAL_INAPPLICABLE",
        "Incomplete or critical missing evidence cannot be waived.",
      );
    const ids = event.waivers.map((waiver) => waiver.diagnosticId);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !assessment.waiverEligibleDiagnosticIds.includes(id)) ||
      assessment.waiverEligibleDiagnosticIds.some((id) => !ids.includes(id))
    ) {
      throw new StorageError(
        "APPROVAL_INAPPLICABLE",
        "Every remaining eligible diagnostic needs an explicit applicable waiver.",
      );
    }
  }
  appendReview(
    input: ReviewEvent,
    context: OperationContext,
  ): Promise<Outcome<ArtifactReference>> {
    return this.snapshot(input, context, "write", (event) =>
      this.appendReviewSnapshot(event, context),
    );
  }
  private appendReviewSnapshot(
    event: ReviewEvent,
    context: OperationContext,
  ): Promise<Outcome<ArtifactReference>> {
    return this.run(context, "write", async (context) => {
      check("ReviewEvent", event);
      await this.guard(context, "write", "design", event.context.designId);
      if (
        event.actor.id !== context.authorization.actorId ||
        event.actor.trust !== "local-actor" ||
        event.actor.issuerId !== undefined
      )
        throw new StorageError(
          "APPROVAL_INAPPLICABLE",
          "Only the authenticated local actor can append local review events.",
        );
      await this.approvalContext(event.context, context);
      if (event.kind === "approved" || event.kind === "waiver")
        await this.approvalEvidence(event, context);
      const previous = this.reviews(event.context.designId).at(-1);
      if (
        event.sequence !== (previous?.event.sequence ?? 0) + 1 ||
        !this.equal(event.previousEvent, previous?.reference ?? null)
      )
        throw new StorageError(
          "CONFLICT",
          "Review stream expected sequence/previous event mismatch.",
        );
      const reference = { id: event.id, sha256: this.digest(event) };
      this.checkpoint(context);
      this.db.transaction(() => {
        this.db
          .prepare("INSERT INTO reviews VALUES (?,?,?,?,?)")
          .run(
            event.id,
            event.context.designId,
            event.sequence,
            reference.sha256,
            JSON.stringify(event),
          );
        this.refs("review", event.id, approvalRefs(event.context));
      })();
      return reference;
    });
  }
  applicableApproval(
    input: ApprovalContext,
    context: OperationContext,
  ): Promise<Outcome<ReviewEvent | null>> {
    return this.snapshot(input, context, "read", (approval) =>
      this.applicableApprovalSnapshot(approval, context),
    );
  }
  private applicableApprovalSnapshot(
    approval: ApprovalContext,
    context: OperationContext,
  ): Promise<Outcome<ReviewEvent | null>> {
    return this.run(context, "read", async (context) => {
      await this.approvalContext(approval, context);
      const last = this.reviews(approval.designId)
        .filter(
          (entry) =>
            this.equal(entry.event.context, approval) &&
            stateKinds.has(entry.event.kind),
        )
        .at(-1)?.event;
      if (last?.kind !== "approved") return null;
      await this.approvalEvidence(last, context);
      return last;
    });
  }

  pin(
    kind: RetentionPin["kind"],
    id: string,
    artifacts: ArtifactReference[],
    context: OperationContext,
  ): Promise<Outcome<RetentionPin>> {
    return this.snapshot({ kind, id, artifacts }, context, "write", (pin) =>
      this.pinSnapshot(pin, context),
    );
  }
  private pinSnapshot(
    pin: RetentionPin,
    context: OperationContext,
  ): Promise<Outcome<RetentionPin>> {
    const { kind, id } = pin;
    return this.run(context, "write", async (context) => {
      this.validatePin(pin);
      await this.options.authorizeRetention("pin", pin, context);
      for (const reference of pin.artifacts) {
        await this.authorizeReference(reference, context, true);
        await this.read(this.artifact(reference), context);
      }
      this.checkpoint(context);
      this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO pins VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
          )
          .run(kind, id, JSON.stringify(pin));
        this.db
          .prepare(
            "DELETE FROM artifact_refs WHERE owner_kind=? AND owner_id=?",
          )
          .run(`pin-${kind}`, id);
        this.refs(`pin-${kind}`, id, pin.artifacts);
      })();
      return pin;
    });
  }
  releasePin(
    kind: RetentionPin["kind"],
    id: string,
    context: OperationContext,
  ): Promise<Outcome<{ released: true }>> {
    return this.run(context, "write", async (context) => {
      this.validatePin({ kind, id, artifacts: [] });
      const row = this.db
        .prepare<[string, string], { data: string }>(
          "SELECT data FROM pins WHERE kind=? AND id=?",
        )
        .get(kind, id);
      if (!row)
        throw new StorageError("NOT_FOUND", "Retention pin does not exist.");
      const pin: RetentionPin = JSON.parse(row.data);
      this.validatePin(pin);
      await this.options.authorizeRetention("release", pin, context);
      this.checkpoint(context);
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM pins WHERE kind=? AND id=?").run(kind, id);
        this.db
          .prepare(
            "DELETE FROM artifact_refs WHERE owner_kind=? AND owner_id=?",
          )
          .run(`pin-${kind}`, id);
      })();
      return { released: true };
    });
  }
  private validatePin(pin: RetentionPin): void {
    check("StableId", pin.id);
    if (
      !["bundle", "job", "legal", "cache"].includes(pin.kind) ||
      pin.artifacts.length > 20000
    )
      throw new StorageError("INVALID_INPUT", "Invalid retention pin.");
    for (const reference of pin.artifacts)
      check("ArtifactReference", reference);
  }
  private allArtifacts(): Artifact[] {
    this.boundRows("artifacts");
    return this.db
      .prepare<[], { data: string }>("SELECT data FROM artifacts ORDER BY id")
      .all()
      .map((row) => parseContract("Artifact", row.data, "json"));
  }
  private async inventory(context: OperationContext) {
    const inventory = await this.options.maintenance.inventory(context, 20000);
    if (
      inventory.stagedIds.length + inventory.publishedArtifacts.length >
      20000
    )
      throw new StorageError(
        "LIMIT",
        "Maintenance inventory exceeds bounded batch.",
      );
    for (const artifact of inventory.publishedArtifacts) {
      check("Artifact", artifact);
      if (
        !portableBlob.test(artifact.path) ||
        artifact.path !== blobPath(artifact.sha256)
      )
        throw new StorageError(
          "INTEGRITY",
          "Unexpected file in the owned blob inventory; manual inspection required.",
        );
    }
    for (const id of inventory.stagedIds) check("StableId", id);
    return inventory;
  }
  recover(context: OperationContext): Promise<Outcome<RecoveryReport>> {
    return this.run(context, "write", async (context) => {
      const inventory = await this.inventory(context);
      const artifacts = this.allArtifacts();
      const missingOrCorrupt: string[] = [];
      const stagedRetained: string[] = [];
      let stagedDiscarded = 0;
      for (const artifact of artifacts) {
        try {
          await this.read(artifact, context);
        } catch (error) {
          this.checkpoint(context);
          if (error instanceof StorageError && error.code === "LIMIT")
            throw error;
          missingOrCorrupt.push(artifact.id);
        }
      }
      for (const id of inventory.stagedIds) {
        this.checkpoint(context);
        const canDiscard = await this.options.canDiscardStage(id, context);
        this.checkpoint(context);
        if (
          !canDiscard ||
          (this.jobStore.knownStage(id) &&
            !this.jobStore.discardable(id, context.jobId))
        ) {
          stagedRetained.push(id);
          continue;
        }
        unwrap(await this.options.fileSystem.discard(id, context));
        stagedDiscarded++;
      }
      const known = new Set(artifacts.map((artifact) => artifact.path));
      return {
        stagedDiscarded,
        stagedRetained,
        orphanPaths: inventory.publishedArtifacts
          .map((artifact) => artifact.path)
          .filter((path) => !known.has(path)),
        missingOrCorrupt,
      };
    });
  }
  collectGarbage(
    context: OperationContext,
  ): Promise<Outcome<{ deleted: string[] }>> {
    return this.run(context, "write", async (context) => {
      await this.options.authorizeRetention("collect", null, context);
      const inventory = await this.inventory(context);
      const protectedPaths = new Set(
        this.db
          .prepare<[], { path: string }>(
            "SELECT DISTINCT a.path FROM artifacts a JOIN artifact_refs r ON a.id=r.artifact_id",
          )
          .all()
          .map((row) => row.path),
      );
      for (const path of this.jobStore.protectedStagePaths())
        protectedPaths.add(path);
      const deleted: string[] = [];
      for (const artifact of inventory.publishedArtifacts) {
        const path = artifact.path;
        if (protectedPaths.has(path)) continue;
        this.checkpoint(context);
        this.db
          .prepare(
            "DELETE FROM artifacts WHERE path=? AND id NOT IN (SELECT artifact_id FROM artifact_refs)",
          )
          .run(path);
        this.removal = { artifact, context };
        try {
          await this.options.maintenance.removeBlob(artifact, context);
        } finally {
          this.removal = undefined;
        }
        deleted.push(path);
      }
      return { deleted };
    });
  }
  /** Synchronous host callback only: never enqueue from inside a maintenance operation. */
  hasRemovalReservation(
    artifact: Artifact,
    context: OperationContext,
  ): boolean {
    return (
      !this.closed &&
      this.removal?.context === context &&
      this.equal(this.removal.artifact, artifact)
    );
  }

  private metadata(): BackupMetadata {
    let metadataBytes = 0;
    for (const table of [
      "artifacts",
      "revisions",
      "reviews",
      "receipts",
      "pins",
    ] as const)
      metadataBytes += this.boundRows(table).bytes;
    if (metadataBytes > 26214400)
      throw new StorageError(
        "LIMIT",
        "Aggregate backup metadata exceeds the bounded read profile.",
      );
    const heads = this.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM heads")
      .get();
    if (!heads || heads.count > 20000)
      throw new StorageError(
        "LIMIT",
        "Too many branch heads for one bounded backup.",
      );
    return {
      storageVersion: 4,
      projectId: this.options.projectId,
      artifacts: this.allArtifacts(),
      revisions: this.db
        .prepare<[], { data: string }>("SELECT data FROM revisions ORDER BY id")
        .all()
        .map((row) => parseContract("Revision", row.data, "json")),
      heads: this.db
        .prepare<[], { designId: string; branch: string; revisionId: string }>(
          "SELECT design AS designId,branch,revision AS revisionId FROM heads ORDER BY design,branch",
        )
        .all(),
      reviews: this.db
        .prepare<[], { design: string }>(
          "SELECT DISTINCT design FROM reviews ORDER BY design",
        )
        .all()
        .flatMap((row) => this.reviews(row.design)),
      receipts: this.db
        .prepare<[], { data: string }>(
          "SELECT data FROM receipts ORDER BY scope",
        )
        .all()
        .map((row) => parseContract("CommitReceipt", row.data, "json")),
      pins: this.db
        .prepare<[], { data: string }>("SELECT data FROM pins ORDER BY kind,id")
        .all()
        .map((row) => {
          const pin: RetentionPin = JSON.parse(row.data);
          this.validatePin(pin);
          return pin;
        }),
      ...this.jobStore.backup(),
      artifactBindings: this.bindingStore.all(),
    };
  }
  private boundRows(
    table: "artifacts" | "revisions" | "reviews" | "receipts" | "pins",
    designId?: string,
  ): { count: number; bytes: number } {
    const clause = designId === undefined ? "" : " WHERE design=?";
    const query = this.db.prepare<unknown[], { count: number; bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) AS bytes FROM ${table}${clause}`,
    );
    const size = designId === undefined ? query.get() : query.get(designId);
    if (!size || size.count > 20000 || size.bytes > 26214400)
      throw new StorageError(
        "LIMIT",
        "Storage metadata exceeds the bounded read profile.",
      );
    return size;
  }
  private async authorizeMetadata(
    metadata: BackupMetadata,
    operation: "read" | "write",
    context: OperationContext,
  ): Promise<void> {
    for (const id of new Set(
      metadata.revisions.map((revision) => revision.designId),
    ))
      await this.guard(context, operation, "design", id);
    for (const id of new Set(metadata.receipts.map((receipt) => receipt.jobId)))
      await this.guard(context, operation, "job", id);
    if (metadata.storageVersion !== 2) {
      for (const record of metadata.jobs) {
        this.jobStore.validateBinding(record);
        await this.guard(context, operation, "job", record.job.id);
        for (const reference of this.jobStore.inputRefs(record))
          await this.guard(context, "read", "artifact", reference.id);
      }
    }
    if (metadata.storageVersion === 4)
      for (const item of metadata.artifactBindings) {
        await this.guard(context, operation, "artifact", item.reference.id);
        await this.guard(context, operation, "artifact", item.artifact.id);
      }
  }
  backup(context: OperationContext): Promise<Outcome<ProjectBackup>> {
    return this.run(context, "read", async (context) => {
      const metadata = this.metadata();
      await this.authorizeMetadata(metadata, "read", context);
      this.validateBackupGraph(metadata);
      if (metadata.storageVersion === 4)
        for (const item of metadata.artifactBindings)
          this.artifact(item.reference);
      const blobs: ProjectBackup["blobs"] = [];
      let total = this.options.canonicalBytes(metadata).length;
      if (total > context.budget.maxOutputBytes)
        throw new StorageError(
          "LIMIT",
          "Backup metadata exceeds output byte budget.",
        );
      const known = new Set<string>();
      for (const artifact of metadata.artifacts) {
        if (known.has(artifact.sha256)) continue;
        total += artifact.byteLength;
        if (total > context.budget.maxOutputBytes)
          throw new StorageError(
            "LIMIT",
            "Backup exceeds bounded export budget.",
          );
        blobs.push({
          sha256: artifact.sha256,
          bytes: await this.read(artifact, context),
        });
        known.add(artifact.sha256);
      }
      return { metadata, sha256: this.digest(metadata), blobs };
    });
  }
  restore(
    input: ProjectBackup,
    context: OperationContext,
  ): Promise<Outcome<{ restored: true }>> {
    const backup = structuredClone(input);
    return this.run(context, "write", async (context) => {
      await this.options.authorizeRestore(backup, context);
      if (
        this.allArtifacts().length ||
        this.metadata().revisions.length ||
        this.metadata().reviews.length ||
        this.metadata().receipts.length ||
        this.metadata().pins.length ||
        this.jobStore.backup().jobs.length ||
        this.jobStore.backup().jobResources.length ||
        this.jobStore.backup().jobStages.length ||
        this.bindingStore.all().length
      )
        throw new StorageError(
          "CONFLICT",
          "Restore requires a newly provisioned empty store.",
        );
      const metadata = backupMetadata(backup.metadata);
      if (
        (metadata.storageVersion !== 2 &&
          metadata.storageVersion !== 3 &&
          metadata.storageVersion !== 4) ||
        metadata.projectId !== this.options.projectId
      )
        throw new StorageError(
          "SCHEMA_INCOMPATIBLE",
          "Backup version/project mismatch.",
        );
      if (this.digest(metadata) !== backup.sha256)
        throw new StorageError("INTEGRITY", "Backup metadata digest mismatch.");
      const size =
        this.options.canonicalBytes(metadata).length +
        backup.blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0);
      if (size > context.budget.maxInputBytes)
        throw new StorageError("LIMIT", "Backup exceeds input budget.");
      if (
        new Set(backup.blobs.map((blob) => blob.sha256)).size !==
        backup.blobs.length
      )
        throw new StorageError("INTEGRITY", "Duplicate backup blob.");
      for (const blob of backup.blobs)
        if (hash(blob.bytes) !== blob.sha256)
          throw new StorageError("INTEGRITY", "Backup blob digest mismatch.");
      for (const artifact of metadata.artifacts) {
        check("Artifact", artifact);
        const blob = backup.blobs.find(
          (item) => item.sha256 === artifact.sha256,
        );
        if (
          !blob ||
          blob.bytes.length !== artifact.byteLength ||
          artifact.path !== blobPath(artifact.sha256)
        )
          throw new StorageError(
            "INTEGRITY",
            "Backup artifact bytes are incomplete.",
          );
      }
      if (
        backup.blobs.some(
          (blob) =>
            !metadata.artifacts.some(
              (artifact) => artifact.sha256 === blob.sha256,
            ),
        )
      )
        throw new StorageError(
          "INTEGRITY",
          "Backup contains undeclared bytes.",
        );
      this.validateBackupGraph(metadata);
      await this.authorizeMetadata(metadata, "write", context);
      if (metadata.storageVersion === 4 && metadata.artifactBindings.length) {
        const authorize = this.options.authorizeArtifactBinding;
        if (!authorize)
          throw new StorageError(
            "AUTHORIZATION_CHANGED",
            "Restoring bindings requires trusted composition.",
          );
        for (const item of metadata.artifactBindings) {
          const artifact = metadata.artifacts.find(
            (artifact) => artifact.id === item.artifact.id,
          );
          const blob = backup.blobs.find(
            (blob) => blob.sha256 === item.artifact.sha256,
          );
          if (!artifact || !blob)
            throw new StorageError(
              "INTEGRITY",
              "Binding restore bytes missing.",
            );
          await authorize(
            structuredClone({
              reference: item.reference,
              artifact: item.artifact,
            }),
            {
              artifact: structuredClone(artifact),
              bytes: Uint8Array.from(blob.bytes),
            },
            context,
          );
          this.checkpoint(context);
        }
      }
      for (const artifact of metadata.artifacts) {
        const blob = backup.blobs.find(
          (item) => item.sha256 === artifact.sha256,
        );
        if (!blob) throw new StorageError("INTEGRITY", "Missing backup blob.");
        const staged = unwrap(
          await this.options.fileSystem.stage(
            {
              artifactRootId: this.options.artifactRootId,
              path: artifact.path,
            },
            blob.bytes,
            context,
          ),
        );
        if (
          staged.artifact.sha256 !== artifact.sha256 ||
          staged.artifact.byteLength !== artifact.byteLength ||
          staged.artifact.path !== artifact.path
        )
          throw new StorageError("INTEGRITY", "Restore staging mismatch.");
        const published = unwrap(
          await this.options.fileSystem.publish(staged, context),
        );
        if (
          published.sha256 !== artifact.sha256 ||
          published.byteLength !== artifact.byteLength ||
          published.path !== artifact.path
        )
          throw new StorageError("INTEGRITY", "Restore publication mismatch.");
        await this.read({ ...artifact, path: published.path }, context);
      }
      await this.options.ensurePublicationDurable(metadata.artifacts, context);
      if (metadata.storageVersion === 4)
        for (const item of metadata.artifactBindings) {
          await this.guard(context, "write", "artifact", item.reference.id);
          await this.guard(context, "read", "artifact", item.artifact.id);
          await this.guard(context, "write", "artifact", item.artifact.id);
        }
      this.checkpoint(context);
      this.db.transaction(() => {
        for (const artifact of metadata.artifacts) this.putArtifact(artifact);
        if (metadata.storageVersion === 4)
          for (const item of metadata.artifactBindings)
            this.bindingStore.put(item);
        for (const revision of metadata.revisions) {
          this.db
            .prepare("INSERT INTO revisions VALUES (?,?,?)")
            .run(revision.id, revision.designId, JSON.stringify(revision));
          this.refs("revision", revision.id, revisionRefs(revision));
        }
        for (const head of metadata.heads)
          this.db
            .prepare("INSERT INTO heads VALUES (?,?,?)")
            .run(head.designId, head.branch, head.revisionId);
        for (const review of metadata.reviews) {
          this.db
            .prepare("INSERT INTO reviews VALUES (?,?,?,?,?)")
            .run(
              review.event.id,
              review.event.context.designId,
              review.event.sequence,
              review.reference.sha256,
              JSON.stringify(review.event),
            );
          this.refs(
            "review",
            review.event.id,
            approvalRefs(review.event.context),
          );
        }
        for (const receipt of metadata.receipts) {
          const record =
            metadata.storageVersion !== 2
              ? metadata.jobs.find((record) =>
                  this.jobStore.receiptConsistent(record, receipt),
                )
              : undefined;
          const scope = record
            ? this.jobStore.receiptScope(record)
            : JSON.stringify([
                receipt.projectId,
                receipt.idempotency.actorId,
                "write",
                receipt.idempotency.key,
              ]);
          this.db
            .prepare("INSERT INTO receipts VALUES (?,?)")
            .run(scope, JSON.stringify(receipt));
          this.refs("job", receipt.id, receipt.outputs);
        }
        if (metadata.storageVersion !== 2) this.jobStore.restore(metadata);
        for (const pin of metadata.pins) {
          this.db
            .prepare("INSERT INTO pins VALUES (?,?,?)")
            .run(pin.kind, pin.id, JSON.stringify(pin));
          this.refs(`pin-${pin.kind}`, pin.id, pin.artifacts);
        }
        this.options.fault?.("before-commit");
        this.checkpoint(context);
      })();
      return { restored: true };
    });
  }
  private validateBackupGraph(metadata: BackupMetadata): void {
    const artifacts = new Map(
      metadata.artifacts.map((artifact) => [artifact.id, artifact]),
    );
    const revisions = new Map(
      metadata.revisions.map((revision) => [revision.id, revision]),
    );
    const bound =
      metadata.storageVersion === 4 ? metadata.artifactBindings : [];
    if (
      bound.length > BINDING_LIMITS.total ||
      new Set(bound.map((item) => bindingKey(item.reference))).size !==
        bound.length
    )
      throw new StorageError(
        "INTEGRITY",
        "Duplicate/oversized logical bindings.",
      );
    const physicalReference = (reference: ArtifactReference) =>
      bound.find((item) => bindingKey(item.reference) === bindingKey(reference))
        ?.artifact ?? reference;
    for (const item of bound) {
      const artifact = artifacts.get(item.artifact.id);
      const receipt = metadata.receipts.find(
        (receipt) => receipt.id === item.receiptId,
      );
      if (
        artifacts.has(item.reference.id) ||
        bound.some((other) => other.reference.id === item.artifact.id) ||
        !artifact ||
        artifact.sha256 !== item.reference.sha256 ||
        artifact.sha256 !== item.artifact.sha256 ||
        !receipt ||
        !receipt.outputs.some((output) => this.equal(output, artifact))
      )
        throw new StorageError(
          "INTEGRITY",
          "Logical binding graph lacks exact committed physical evidence.",
        );
    }
    if (
      artifacts.size !== metadata.artifacts.length ||
      revisions.size !== metadata.revisions.length
    )
      throw new StorageError("INTEGRITY", "Duplicate backup identities.");
    const refs = (references: ArtifactReference[]) => {
      for (const reference of references)
        if (
          artifacts.get(physicalReference(reference).id)?.sha256 !==
          reference.sha256
        )
          throw new StorageError(
            "INTEGRITY",
            "Backup has a dangling artifact reference.",
          );
    };
    for (const revision of metadata.revisions) {
      check("Revision", revision);
      if (revision.projectId !== this.options.projectId)
        throw new StorageError(
          "INTEGRITY",
          "Cross-project revision in backup.",
        );
      refs(revisionRefs(revision));
      const visited = new Set<string>([revision.id]);
      const ancestors = [...revision.parents];
      while (ancestors.length) {
        const id = ancestors.pop();
        if (!id) break;
        if (id === revision.id)
          throw new StorageError("INTEGRITY", "Cyclic revision history.");
        if (visited.has(id)) continue;
        visited.add(id);
        const parent = revisions.get(id);
        if (!parent || parent.designId !== revision.designId)
          throw new StorageError("INTEGRITY", "Invalid revision parent.");
        ancestors.push(...parent.parents);
      }
    }
    for (const head of metadata.heads) {
      check("StableId", head.branch);
      if (revisions.get(head.revisionId)?.designId !== head.designId)
        throw new StorageError("INTEGRITY", "Invalid branch head.");
    }
    const streams = new Map<string, StoredReview>();
    for (const review of metadata.reviews) {
      check("ReviewEvent", review.event);
      check("ArtifactReference", review.reference);
      const event = review.event;
      const previous = streams.get(event.context.designId);
      if (
        event.context.projectId !== this.options.projectId ||
        review.reference.id !== event.id ||
        this.digest(event) !== review.reference.sha256 ||
        event.sequence !== (previous?.event.sequence ?? 0) + 1 ||
        !this.equal(event.previousEvent, previous?.reference ?? null)
      )
        throw new StorageError("INTEGRITY", "Invalid review chain.");
      if (
        !metadata.revisions.some(
          (revision) =>
            revision.designId === event.context.designId &&
            this.equal(revision.content, event.context.revision) &&
            this.equal(revision.resources, event.context.resources),
        )
      )
        throw new StorageError(
          "INTEGRITY",
          "Review references unknown revision context.",
        );
      refs(approvalRefs(event.context));
      streams.set(event.context.designId, review);
    }
    for (const receipt of metadata.receipts) {
      check("CommitReceipt", receipt);
      if (
        receipt.projectId !== this.options.projectId ||
        receipt.idempotency.projectId !== this.options.projectId ||
        (receipt.idempotency.operation !== "write" &&
          !(
            metadata.storageVersion !== 2 &&
            metadata.jobs.some((record) =>
              this.jobStore.receiptConsistent(record, receipt),
            )
          ))
      )
        throw new StorageError("INTEGRITY", "Invalid receipt scope.");
      for (const artifact of receipt.outputs)
        if (!this.equal(artifacts.get(artifact.id), artifact))
          throw new StorageError(
            "INTEGRITY",
            "Receipt artifact metadata mismatch.",
          );
    }
    for (const pin of metadata.pins) {
      this.validatePin(pin);
      refs(pin.artifacts);
    }
    if (metadata.storageVersion !== 2) {
      this.jobStore.validateControlGraph(metadata.jobs);
      const jobs = new Map(
        metadata.jobs.map((record) => [record.job.id, record]),
      );
      const resources = new Map(
        metadata.jobResources.map((resource) => [resource.key, resource]),
      );
      if (
        jobs.size !== metadata.jobs.length ||
        resources.size !== metadata.jobResources.length ||
        new Set(metadata.jobStages.map((stage) => stage.stagingId)).size !==
          metadata.jobStages.length ||
        new Set(
          metadata.jobs.map((record) => this.jobStore.receiptScope(record)),
        ).size !== metadata.jobs.length
      )
        throw new StorageError(
          "INTEGRITY",
          "Duplicate private job identities.",
        );
      for (const record of metadata.jobs) {
        if (record.job.projectId !== metadata.projectId)
          throw new StorageError("INTEGRITY", "Cross-project job in backup.");
        refs(this.jobStore.inputRefs(record));
        if (
          record.inputRevision &&
          revisions.get(record.inputRevision.id)?.content.sha256 !==
            record.inputRevision.sha256
        )
          throw new StorageError(
            "INTEGRITY",
            "Job input revision is unavailable.",
          );
        const receipts = metadata.receipts.filter(
          (receipt) => receipt.jobId === record.job.id,
        );
        if (
          record.job.status === "completed"
            ? receipts.length !== 1 ||
              !receipts[0] ||
              !this.jobStore.receiptConsistent(record, receipts[0])
            : receipts.length !== 0
        )
          throw new StorageError(
            "INTEGRITY",
            "Job receipt graph is inconsistent.",
          );
        for (const reservation of record.resources) {
          const resource = resources.get(reservation.key);
          if (
            !resource ||
            resource.state === "released" ||
            resource.jobId !== record.job.id ||
            resource.generation !== reservation.generation ||
            resource.leaseId !== record.job.lease?.id ||
            resource.fencingToken !== record.job.lease?.fencingToken
          )
            throw new StorageError(
              "INTEGRITY",
              "Job reservation graph is inconsistent.",
            );
        }
      }
      for (const resource of metadata.jobResources)
        if (
          resource.state !== "released" &&
          !jobs
            .get(resource.jobId ?? "")
            ?.resources.some(
              (r) =>
                r.key === resource.key && r.generation === resource.generation,
            )
        )
          throw new StorageError("INTEGRITY", "Resource owner is missing.");
      for (const stage of metadata.jobStages) {
        const record = jobs.get(stage.jobId);
        if (
          !record ||
          stage.requestId !== record.requestId ||
          stage.attempt > record.job.attempt ||
          stage.fencingToken > record.generation ||
          stage.staged.artifact.path !== blobPath(stage.staged.artifact.sha256)
        )
          throw new StorageError(
            "INTEGRITY",
            "Stage ownership graph is inconsistent.",
          );
      }
    }
  }
}
