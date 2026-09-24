import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  type Artifact,
  type Budget,
  type FileRequest,
  type FileSystemBoundary,
  type OperationContext,
  type Outcome,
  type RetainedInventoryFailure,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import {
  type Authority,
  boundary,
  HostBoundaryError,
  OperationGuard,
} from "./guards.js";
import type { NativeFileIdentity } from "./windows-native.js";
import {
  NativePublicationInterrupted,
  type NativePublicationProof,
  WINDOWS_PUBLICATION_PROFILE,
  WindowsNtfsPublisher,
} from "./windows-publication.js";

export interface ProjectRoot {
  id: string;
  path: string;
  access: "read" | "read-write";
  /** Caller attests no untrusted concurrent writers or directory replacement. */
  trustedExclusiveAccess: true;
  /** Explicit ownership of the blobs/<sha256> namespace, including crash orphans. */
  managedBlobs?: boolean;
}
export interface ProjectFileSystemOptions {
  reserveRead?(bytes: number, context: OperationContext): void;
  retainedReferenceInspection?: {
    artifactRootId: string;
    outputRootId: string;
    authorize(
      input: RetainedReferenceInput,
      context: OperationContext,
    ): Promise<void>;
    pin(
      rootId: string,
      relative: string,
      directory: boolean,
    ): Promise<{
      identity: { path: string; volume: number; file: string };
      check(): Promise<void>;
      close(): void;
    }>;
  };
  referenceInspection?: {
    artifactRootId: string;
    outputRootId: string;
    authorize(
      stages: readonly CaptureRecoveryStage[],
      context: OperationContext,
    ): Promise<void>;
  };
  captureRecoveryInspection?: {
    artifactRootId: string;
    outputRootId: string;
    authorize(
      stages: readonly CaptureRecoveryStage[],
      context: OperationContext,
    ): Promise<void>;
  };
  projectId: string;
  authority: Authority;
  roots: readonly ProjectRoot[];
  budgetLimits?: Readonly<Budget>;
  publicationProfile?: "portable-atomic" | typeof WINDOWS_PUBLICATION_PROFILE;
  authorizeRemoval?: (
    artifact: Artifact,
    context: OperationContext,
  ) => Promise<boolean>;
  authorizePublicationRecovery?: (
    artifact: Artifact,
    stagingId: string,
    context: OperationContext,
  ) => Promise<boolean>;
  authorizeOwnedPublicationRecovery?: (
    pending: OwnedPendingPublication,
    context: OperationContext,
  ) => Promise<void>;
}
type RetainedReadPin = Awaited<
  ReturnType<
    NonNullable<ProjectFileSystemOptions["retainedReferenceInspection"]>["pin"]
  >
>;
export interface CaptureRecoveryStage {
  stagingId: string;
  jobId: string;
  requestId: string;
  artifact: Artifact;
}
export interface CaptureRecoveryInspection {
  artifacts: Artifact[];
  stages: { descriptor: CaptureRecoveryStage; bytes: Uint8Array }[];
}
export interface RetainedReferenceInput {
  artifacts: readonly Artifact[];
  targets: readonly CaptureRecoveryStage[];
  history: readonly CaptureRecoveryStage[];
  /** Exact artifact records authenticated in the historical recovery grant. */
  committedHistoryArtifacts?: readonly Artifact[];
}
export interface RetainedReferenceInspection {
  identitySha256: string;
  targets: {
    descriptor: CaptureRecoveryStage;
    publication:
      | "stage-only"
      | "published-only"
      | "known-pair-native-read-blocked";
    bytes?: Uint8Array;
  }[];
  check(): Promise<void>;
  close(): void;
}
export type RetainedReferenceOutcome = Outcome<RetainedReferenceInspection> & {
  inventoryFailure?: RetainedInventoryFailure;
};
/** Instance-owned identity, not a serializable cleanup grant. */
export interface OwnedPendingPublication {
  readonly projectId: string;
  readonly actorId: string;
  readonly artifactRootId: string;
  readonly requestId: string;
  readonly jobId?: string;
  readonly stagingId: string;
  readonly artifact: Readonly<Artifact>;
}
export interface ManagedInventory {
  stagedIds: string[];
  publishedArtifacts: Artifact[];
}
interface Root extends ProjectRoot {
  identity: Stats;
  staging?: { path: string; identity: Stats };
}
interface Pending {
  root: Root;
  staged: StagedArtifact;
  path: string;
  identity: Stats;
  projectId: string;
  actorId: string;
  requestId: string;
  sessionId: string;
  authorization: OperationContext["authorization"];
  jobId?: string;
  recovery?: OwnedPendingPublication;
  busy: boolean;
  publishedDestination?: string;
  pairUnlinked?: boolean;
  nativeState?: NativeFileIdentity;
}
interface NativeReceipt {
  artifact: Artifact;
  identity: Stats;
  proof: NativePublicationProof;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const codeOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export function portableRelativePath(candidate: string): string {
  if (
    typeof candidate !== "string" ||
    !candidate ||
    candidate.length > 4096 ||
    path.win32.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    /[\\:%]/.test(candidate) ||
    [...candidate].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new HostBoundaryError(
      "PATH_FORBIDDEN",
      "Path is not a portable relative path.",
    );
  for (const segment of candidate.split("/")) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length > 255 ||
      /[. ]$/.test(segment) ||
      /[<>"|?*]/.test(segment) ||
      /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment) ||
      segment.toLowerCase().startsWith(".host-") ||
      segment.normalize("NFC") !== segment
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Path component is unsafe or reserved.",
      );
  }
  return candidate;
}

async function io<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HostBoundaryError) throw error;
    const code = codeOf(error);
    const mapped =
      code === "ENOENT"
        ? "RESOURCE_UNRESOLVED"
        : code === "EEXIST"
          ? "CONFLICT"
          : ["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(code ?? "")
            ? "PATH_FORBIDDEN"
            : code === "EXDEV"
              ? "UNSUPPORTED_FEATURE"
              : "INTERNAL_ERROR";
    throw new HostBoundaryError(
      mapped,
      `Filesystem operation failed (${code ?? "unknown I/O error"}).`,
      false,
      { cause: error },
    );
  }
}

async function boundedEntries(
  directory: string,
  maxEntries = 20_000,
  guard?: OperationGuard,
): Promise<string[]> {
  return io(async () => {
    const entries: string[] = [];
    for await (const entry of await opendir(directory)) {
      guard?.check();
      if (entries.length >= maxEntries)
        throw new HostBoundaryError(
          "OUTPUT_LIMIT",
          "Directory entry limit exceeded.",
        );
      entries.push(entry.name);
    }
    return entries.sort();
  });
}

export class ProjectFileSystem implements FileSystemBoundary {
  get hasRetainedReadClosures() {
    return this.retainedClosures.size !== 0;
  }
  private readonly roots = new Map<string, Root>();
  private readonly pending = new Map<string, Pending>();
  private readonly retainedClosures = new Set<() => void>();
  private readonly proofClosures = new Set<() => void>();
  private readonly proofReads = new Map<
    string,
    { identity: RetainedReadPin["identity"]; stat: Stats }
  >();
  private sameProofRead(
    proof: { identity: RetainedReadPin["identity"]; stat: Stats },
    pin: RetainedReadPin,
    stat: Stats,
  ) {
    return (
      this.sameProofNativeIdentity(proof, pin) &&
      this.sameProofStat(proof.stat, stat)
    );
  }
  private sameProofNativeIdentity(
    proof: { identity: RetainedReadPin["identity"] },
    pin: RetainedReadPin,
  ) {
    return (
      proof.identity.path === pin.identity.path &&
      proof.identity.volume === pin.identity.volume &&
      proof.identity.file === pin.identity.file
    );
  }
  private sameProofStat(before: Stats, stat: Stats) {
    return (
      sameFile(before, stat) &&
      before.nlink === stat.nlink &&
      before.size === stat.size &&
      before.mtimeMs === stat.mtimeMs &&
      before.ctimeMs === stat.ctimeMs
    );
  }
  private readonly recoveries = new WeakMap<OwnedPendingPublication, Pending>();
  private readonly nativeReceipts = new Map<string, NativeReceipt>();
  private readonly nativePublisher = new WindowsNtfsPublisher();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private preserved = false;
  private constructor(private readonly options: ProjectFileSystemOptions) {
    if (
      options.publicationProfile !== undefined &&
      !["portable-atomic", WINDOWS_PUBLICATION_PROFILE].includes(
        options.publicationProfile,
      )
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Unknown publication durability profile.",
      );
  }
  private serial<T>(
    operation: () => Promise<T>,
    allowClosed = false,
  ): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed && !allowClosed)
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Filesystem boundary is closed.",
        );
      return operation();
    });
    // Release the queue on failure; the original promise still reports the error.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private execute<T>(
    context: OperationContext,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    return boundary(context, (owned) => this.serial(() => operation(owned)));
  }
  static async create(
    options: ProjectFileSystemOptions,
  ): Promise<ProjectFileSystem> {
    const inspection = options.captureRecoveryInspection;
    const referenceInspection = options.referenceInspection;
    for (const entry of [inspection, referenceInspection]) {
      if (
        entry &&
        (!validateContract("StableId", entry.artifactRootId).success ||
          !validateContract("StableId", entry.outputRootId).success ||
          entry.artifactRootId === entry.outputRootId ||
          typeof entry.authorize !== "function")
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Capture inspection requires fixed distinct roots and native admission.",
        );
    }
    const boundary = new ProjectFileSystem({
      ...options,
      ...(referenceInspection
        ? {
            referenceInspection: Object.freeze({
              artifactRootId: referenceInspection.artifactRootId,
              outputRootId: referenceInspection.outputRootId,
              authorize:
                referenceInspection.authorize.bind(referenceInspection),
            }),
          }
        : {}),
      ...(inspection
        ? {
            captureRecoveryInspection: Object.freeze({
              artifactRootId: inspection.artifactRootId,
              outputRootId: inspection.outputRootId,
              authorize: inspection.authorize.bind(inspection),
            }),
          }
        : {}),
    });
    for (const configured of options.roots) {
      if (
        !validateContract("StableId", configured.id).success ||
        boundary.roots.has(configured.id) ||
        configured.trustedExclusiveAccess !== true ||
        !path.isAbsolute(configured.path)
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Roots require unique IDs, absolute paths and trusted exclusive access.",
        );
      const absolute = path.resolve(configured.path);
      const identity = await io(() => lstat(absolute));
      if (
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        (await realpath(absolute)) !== absolute
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Root must be a real directory without path aliases.",
        );
      await boundary.inspectAncestors(absolute);
      for (const other of boundary.roots.values()) {
        const a = absolute.toLowerCase();
        const b = other.path.toLowerCase();
        if (
          a === b ||
          a.startsWith(`${b}${path.sep}`) ||
          b.startsWith(`${a}${path.sep}`)
        )
          throw new HostBoundaryError(
            "INVALID_INPUT",
            "Configured roots must not overlap.",
          );
      }
      boundary.roots.set(configured.id, {
        ...configured,
        path: absolute,
        identity,
      });
    }
    return boundary;
  }
  private async inspectAncestors(absolute: string): Promise<void> {
    let current = absolute;
    while (true) {
      const stats = await io(() => lstat(current));
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Directory links and junctions are forbidden.",
        );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  private guard(
    rootId: string,
    context: OperationContext,
    operation: "read" | "write",
  ): { root: Root; guard: OperationGuard } {
    const guard = new OperationGuard(
      context,
      {
        projectId: this.options.projectId,
        resourceKind: "artifact",
        resourceId: rootId,
        operation,
      },
      this.options.authority,
      undefined,
      this.options.budgetLimits,
    );
    const root = this.roots.get(rootId);
    if (
      this.closed ||
      !root ||
      (operation === "write" && root.access !== "read-write")
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Configured root does not allow this operation.",
      );
    return { root, guard };
  }
  private async checkRoot(root: Root): Promise<void> {
    await this.inspectAncestors(root.path);
    const current = await io(() => lstat(root.path));
    if (
      !sameFile(root.identity, current) ||
      (await realpath(root.path)) !== root.path
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Configured root identity changed.",
      );
  }
  private async resolve(
    root: Root,
    relative: string,
    createParents = false,
  ): Promise<string> {
    portableRelativePath(relative);
    await this.checkRoot(root);
    let current = root.path;
    const segments = relative.split("/");
    for (const [index, segment] of segments.entries()) {
      const entries = await boundedEntries(current);
      const aliases = entries.filter(
        (entry) =>
          entry.normalize("NFC").toLowerCase() === segment.toLowerCase(),
      );
      if (aliases.length && (aliases.length !== 1 || aliases[0] !== segment))
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Case or Unicode path collision.",
        );
      current = path.join(current, segment);
      if (!aliases.length) {
        if (index === segments.length - 1) return current;
        if (!createParents)
          throw new HostBoundaryError(
            "RESOURCE_UNRESOLVED",
            "Parent directory does not exist.",
          );
        await io(() => mkdir(current, { mode: 0o700 }));
      }
      const stats = await io(() => lstat(current));
      if (
        stats.isSymbolicLink() ||
        (index < segments.length - 1 && !stats.isDirectory())
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Links or non-directory path components are forbidden.",
        );
    }
    return current;
  }
  private async readBytes(
    absolute: string,
    guard: OperationGuard,
    expected?: Stats,
    allowedLinks = 1,
  ): Promise<Uint8Array> {
    return io(async () => {
      const handle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Uint8Array | undefined;
      try {
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.nlink !== allowedLinks ||
            (expected && !sameFile(expected, before))
          )
            throw new HostBoundaryError(
              "PATH_FORBIDDEN",
              "File is not an exclusively linked regular file.",
            );
          guard.consume("input", before.size);
          guard.consume("output", before.size);
          this.options.reserveRead?.(before.size, guard.context);
          bytes = new Uint8Array(before.size);
          let offset = 0;
          while (offset < bytes.byteLength) {
            guard.check();
            const { bytesRead } = await handle.read(
              bytes,
              offset,
              Math.min(65536, bytes.byteLength - offset),
              offset,
            );
            if (!bytesRead)
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "File size changed during read.",
              );
            offset += bytesRead;
          }
          this.options.reserveRead?.(1, guard.context);
          const probe = await handle.read(new Uint8Array(1), 0, 1, offset);
          const after = await handle.stat();
          if (
            probe.bytesRead ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            !sameFile(before, await lstat(absolute))
          )
            throw new HostBoundaryError(
              "ARTIFACT_INTEGRITY",
              "File changed during read.",
            );
          guard.check();
          return bytes;
        } finally {
          await handle.close();
        }
      } catch (error) {
        bytes?.fill(0);
        throw error;
      }
    });
  }
  read(
    input: FileRequest,
    context: OperationContext,
  ): Promise<Outcome<Uint8Array>> {
    return boundary(context, async (context) => {
      if (!validateContract("FileRequest", input).success)
        throw new HostBoundaryError("PATH_FORBIDDEN", "Invalid file request.");
      const request = structuredClone(input);
      const { root, guard } = this.guard(
        request.artifactRootId,
        context,
        "read",
      );
      return this.serial(async () => {
        guard.check();
        const absolute = await this.resolve(root, request.path);
        const pin = await this.options.retainedReferenceInspection?.pin(
          request.artifactRootId,
          request.path,
          false,
        );
        const closePin = () => {
          pin?.close();
          this.retainedClosures.delete(closePin);
          this.proofClosures.delete(closePin);
        };
        if (pin) {
          this.retainedClosures.add(closePin);
          this.proofClosures.add(closePin);
        }
        let bytes: Uint8Array | undefined;
        let failed = false;
        let failure: unknown;
        try {
          if (pin) {
            await pin.check();
            guard.check();
          }
          const observed = pin ? await io(() => lstat(absolute)) : undefined;
          bytes = await this.readBytes(absolute, guard, observed);
          if (pin) await pin.check();
          await this.resolve(root, request.path);
          guard.check();
          if (pin && observed) {
            const key = `${request.artifactRootId}\0${request.path}`;
            const prior = this.proofReads.get(key);
            if (prior && !this.sameProofRead(prior, pin, observed))
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Immutable source read identity changed.",
              );
            this.proofReads.set(key, {
              identity: pin.identity,
              stat: observed,
            });
          }
        } catch (error) {
          failed = true;
          failure = error;
        }
        try {
          if (failed || !pin) closePin();
        } catch (error) {
          bytes?.fill(0);
          throw new HostBoundaryError(
            failure instanceof HostBoundaryError ? failure.code : "INTERRUPTED",
            "Retained read cleanup did not settle.",
            false,
            {
              cause: new AggregateError([...(failed ? [failure] : []), error]),
            },
          );
        }
        if (failed) {
          bytes?.fill(0);
          throw failure;
        }
        if (!bytes)
          throw new HostBoundaryError(
            "INTERNAL_ERROR",
            "Read did not produce bytes.",
          );
        return bytes;
      });
    });
  }
  stage(
    input: FileRequest,
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<StagedArtifact>> {
    return boundary(context, async (context) => {
      if (!validateContract("FileRequest", input).success)
        throw new HostBoundaryError("PATH_FORBIDDEN", "Invalid file request.");
      const request = structuredClone(input);
      const { root, guard } = this.guard(
        request.artifactRootId,
        context,
        "write",
      );
      guard.consume("input", bytes.byteLength);
      guard.consume("output", bytes.byteLength);
      const owned = Uint8Array.from(bytes);
      return this.serial(async () => {
        guard.check();
        if (root.managedBlobs && request.path !== `blobs/${sha256(owned)}`)
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Managed blob path must match the exact bytes hash.",
          );
        await this.resolve(root, request.path, true);
        guard.check();
        if (!root.staging) {
          const directory = path.join(root.path, `.host-${randomUUID()}`);
          await io(() => mkdir(directory, { mode: 0o700 }));
          root.staging = { path: directory, identity: await lstat(directory) };
        }
        await this.checkStaging(root);
        const stagingId = randomUUID();
        const absolute = path.join(root.staging.path, stagingId);
        const artifact: Artifact = {
          id: `sha256_${sha256(owned)}`,
          path: request.path,
          mediaType: "application/octet-stream",
          byteLength: owned.byteLength,
          sha256: sha256(owned),
        };
        if (!validateContract("Artifact", artifact).success)
          throw new HostBoundaryError(
            "INVALID_INPUT",
            "Invalid artifact metadata.",
          );
        const handle = await io(() => open(absolute, "wx", 0o600));
        let identity: Stats;
        try {
          await io(() => handle.writeFile(owned));
          await io(() => handle.sync());
          identity = await handle.stat();
        } catch (error) {
          await handle.close();
          await io(() => unlink(absolute));
          throw error;
        }
        await handle.close();
        const staged = { stagingId, artifact };
        this.pending.set(stagingId, {
          root,
          staged: structuredClone(staged),
          path: absolute,
          identity,
          projectId: context.projectId,
          actorId: context.authorization.actorId,
          sessionId: context.authorization.sessionId,
          authorization: context.authorization,
          ...(context.jobId ? { jobId: context.jobId } : {}),
          requestId: context.requestId,
          busy: false,
        });
        try {
          guard.check();
        } catch (error) {
          await io(() => unlink(absolute));
          this.pending.delete(stagingId);
          throw error;
        }
        return staged;
      });
    });
  }
  private async checkStaging(root: Root): Promise<void> {
    await this.checkRoot(root);
    if (!root.staging)
      throw new HostBoundaryError(
        "RESOURCE_UNRESOLVED",
        "No staging directory.",
      );
    const current = await io(() => lstat(root.staging?.path ?? ""));
    if (current.isSymbolicLink() || !sameFile(current, root.staging.identity))
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Staging directory identity changed.",
      );
  }
  private own(
    stagingId: string,
    context: OperationContext,
  ): { pending: Pending; guard: OperationGuard } {
    const pending = this.pending.get(stagingId);
    if (!pending)
      throw new HostBoundaryError(
        "RESOURCE_UNRESOLVED",
        "Staging ID is not owned by this boundary.",
      );
    const { guard } = this.guard(pending.root.id, context, "write");
    if (
      pending.projectId !== context.projectId ||
      pending.actorId !== context.authorization.actorId ||
      pending.requestId !== context.requestId ||
      pending.sessionId !== context.authorization.sessionId
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Staging ownership does not match operation.",
      );
    if (pending.busy)
      throw new HostBoundaryError(
        "CONFLICT",
        "Staging operation already in progress.",
      );
    return { pending, guard };
  }
  publish(
    input: StagedArtifact,
    context: OperationContext,
  ): Promise<Outcome<Artifact>> {
    return this.publishOwned(input, context);
  }
  retainPendingPublication(
    input: StagedArtifact,
    context: OperationContext,
  ): OwnedPendingPublication {
    const pending = this.pending.get(input.stagingId);
    if (
      this.closed ||
      !pending ||
      pending.busy ||
      !(pending.nativeState || pending.publishedDestination) ||
      pending.authorization !== context.authorization ||
      pending.projectId !== context.projectId ||
      pending.actorId !== context.authorization.actorId ||
      pending.sessionId !== context.authorization.sessionId ||
      pending.requestId !== context.requestId ||
      pending.jobId !== context.jobId ||
      !validateContract("Artifact", input.artifact).success ||
      Object.keys(pending.staged.artifact).some(
        (key) =>
          Reflect.get(input.artifact, key) !==
          Reflect.get(pending.staged.artifact, key),
      )
    )
      throw new HostBoundaryError(
        "FORBIDDEN",
        "No exact original owned visible publication can be retained.",
      );
    if (!pending.recovery) {
      const capability: OwnedPendingPublication = Object.freeze({
        projectId: pending.projectId,
        actorId: pending.actorId,
        artifactRootId: pending.root.id,
        requestId: pending.requestId,
        ...(pending.jobId ? { jobId: pending.jobId } : {}),
        stagingId: pending.staged.stagingId,
        artifact: Object.freeze({ ...pending.staged.artifact }),
      });
      pending.recovery = capability;
      this.recoveries.set(capability, pending);
    }
    return pending.recovery;
  }
  reconcileOwnedPublication(
    pending: OwnedPendingPublication,
    context: OperationContext,
  ): Promise<Outcome<Artifact>> {
    const known = this.recoveries.get(pending);
    if (!known)
      return boundary(context, async () => {
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Cleanup requires this instance's retained publication identity.",
        );
      });
    if (known.busy)
      return boundary(context, async () => {
        throw new HostBoundaryError(
          "CONFLICT",
          "Owned publication cleanup is already in progress.",
        );
      });
    return this.publishOwned(known.staged, context, pending);
  }
  private publishOwned(
    input: StagedArtifact,
    context: OperationContext,
    recovery?: OwnedPendingPublication,
  ): Promise<Outcome<Artifact>> {
    return boundary(context, async (context) => {
      if (
        !validateContract("JsonValue", input).success ||
        !validateContract("StableId", input?.stagingId).success ||
        !validateContract("Artifact", input?.artifact).success
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Invalid staged artifact.",
        );
      const staged = structuredClone(input);
      return this.serial(async () => {
        let owned: { pending: Pending; guard: OperationGuard };
        if (recovery) {
          const pending = this.recoveries.get(recovery);
          if (
            !pending ||
            this.pending.get(staged.stagingId) !== pending ||
            pending.recovery !== recovery ||
            pending.busy ||
            !(pending.nativeState || pending.publishedDestination) ||
            pending.projectId !== context.projectId ||
            pending.actorId !== context.authorization.actorId ||
            pending.jobId !== context.jobId ||
            pending.requestId !== context.requestId ||
            !this.options.authorizeOwnedPublicationRecovery
          )
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Pending publication cleanup admission denied.",
            );
          const { guard } = this.guard(pending.root.id, context, "write");
          pending.busy = true;
          try {
            await this.options.authorizeOwnedPublicationRecovery(
              recovery,
              context,
            );
            guard.check();
          } finally {
            pending.busy = false;
          }
          owned = { pending, guard };
        } else owned = this.own(staged.stagingId, context);
        const { pending, guard } = owned;
        if (
          !validateContract("Artifact", staged.artifact).success ||
          Object.keys(pending.staged.artifact).some(
            (key) =>
              Reflect.get(staged.artifact, key) !==
              Reflect.get(pending.staged.artifact, key),
          )
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Staged metadata was modified.",
          );
        pending.busy = true;
        try {
          await this.checkStaging(pending.root);
          if (pending.nativeState) {
            const destination = await this.resolve(
              pending.root,
              staged.artifact.path,
            );
            const bytes = await this.readBytes(
              destination,
              guard,
              pending.identity,
            );
            try {
              if (
                bytes.byteLength !== pending.staged.artifact.byteLength ||
                sha256(bytes) !== pending.staged.artifact.sha256
              )
                throw new HostBoundaryError(
                  "ARTIFACT_INTEGRITY",
                  "Interrupted native publication bytes changed.",
                );
            } finally {
              bytes.fill(0);
            }
            const proof = await this.nativePublisher.resume(
              destination,
              pending.nativeState,
              guard,
            );
            await this.recordNativeReceipt(pending, proof);
            guard.check();
            this.pending.delete(staged.stagingId);
            return structuredClone(pending.staged.artifact);
          }
          if (pending.publishedDestination) {
            await this.resolve(pending.root, staged.artifact.path);
            if (pending.pairUnlinked) {
              const bytes = await this.readBytes(
                pending.publishedDestination,
                guard,
                pending.identity,
              );
              try {
                if (
                  bytes.byteLength !== pending.staged.artifact.byteLength ||
                  sha256(bytes) !== pending.staged.artifact.sha256
                )
                  throw new HostBoundaryError(
                    "ARTIFACT_INTEGRITY",
                    "Completed unlink destination bytes changed.",
                  );
              } finally {
                bytes.fill(0);
              }
            } else {
              await this.finishPublishedPair(
                pending.path,
                pending.publishedDestination,
                pending.staged.artifact,
                guard,
                pending.identity,
              );
              pending.pairUnlinked = true;
            }
            guard.check();
            this.pending.delete(staged.stagingId);
            return structuredClone(pending.staged.artifact);
          }
          const bytes = await this.readBytes(
            pending.path,
            guard,
            pending.identity,
          );
          if (
            bytes.byteLength !== pending.staged.artifact.byteLength ||
            sha256(bytes) !== pending.staged.artifact.sha256
          )
            throw new HostBoundaryError(
              "ARTIFACT_INTEGRITY",
              "Staged bytes do not match artifact metadata.",
            );
          const destination = await this.resolve(
            pending.root,
            staged.artifact.path,
          );
          guard.check();
          if (this.options.publicationProfile === WINDOWS_PUBLICATION_PROFILE) {
            const proof = await this.nativePublisher.publish(
              pending.path,
              destination,
              pending.staged.artifact.byteLength,
              guard,
            );
            pending.nativeState = proof.identity;
            await this.recordNativeReceipt(pending, proof);
            this.pending.delete(staged.stagingId);
            return structuredClone(pending.staged.artifact);
          }
          // Same-filesystem hard-link publication is atomic and never replaces an existing file.
          await io(() => link(pending.path, destination));
          pending.publishedDestination = destination;
          await this.finishPublishedPair(
            pending.path,
            destination,
            pending.staged.artifact,
            guard,
            pending.identity,
            false,
          );
          this.pending.delete(staged.stagingId);
          return structuredClone(pending.staged.artifact);
        } catch (error) {
          if (error instanceof NativePublicationInterrupted)
            pending.nativeState = error.identity;
          if (pending.publishedDestination || pending.nativeState)
            throw new HostBoundaryError(
              "OUTPUT_UNCERTAIN",
              "Destination is visible but publication cleanup is incomplete; retry/reconcile the exact owned pair.",
              false,
              { cause: error },
            );
          throw error;
        } finally {
          pending.busy = false;
        }
      });
    });
  }
  discard(
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<{ discarded: true }>> {
    return this.execute(context, async (context) => {
      const { pending, guard } = this.own(stagingId, context);
      if (pending.nativeState)
        throw new HostBoundaryError(
          "OUTPUT_UNCERTAIN",
          "Native publication is already visible; retry its owning publish instead of discarding.",
        );
      pending.busy = true;
      try {
        await this.checkStaging(pending.root);
        const stats = await io(() => lstat(pending.path));
        if (
          !sameFile(pending.identity, stats) ||
          stats.isSymbolicLink() ||
          stats.nlink !== 1
        )
          throw new HostBoundaryError(
            "PATH_FORBIDDEN",
            "Staged file identity changed.",
          );
        guard.check();
        await io(() => unlink(pending.path));
        this.pending.delete(stagingId);
        return { discarded: true };
      } finally {
        pending.busy = false;
      }
    });
  }
  close(): Promise<void> {
    return this.serial(() => this.cleanup(), true);
  }
  private closeRetainedReads(): void {
    const errors: unknown[] = [];
    for (const close of [...this.retainedClosures]) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new HostBoundaryError(
        "INTERRUPTED",
        "Independent retained read closures did not settle.",
        false,
        { cause: new AggregateError(errors) },
      );
    this.proofReads.clear();
  }
  closeRetainedProofReads(): void {
    const errors: unknown[] = [];
    for (const close of [...this.proofClosures]) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new HostBoundaryError(
        "INTERRUPTED",
        "Retained source proof reads did not close.",
        false,
        { cause: new AggregateError(errors) },
      );
    this.proofReads.clear();
  }
  /** Dispose this boundary without discarding privately journaled source attempts. */
  closePreservingStages(): Promise<void> {
    return this.serial(async () => {
      if (this.preserved) return;
      this.closeRetainedReads();
      this.assertCloseable();
      this.closed = true;
      this.preserved = true;
      this.pending.clear();
      this.nativeReceipts.clear();
      for (const root of this.roots.values()) delete root.staging;
    }, true);
  }
  get publicationDurability(): string {
    return this.options.publicationProfile === WINDOWS_PUBLICATION_PROFILE
      ? "documented-ntfs-write-through-request-not-power-cut-tested"
      : "file-flushed-atomic-visibility-not-power-loss-durable";
  }
  private receiptKey(rootId: string, relative: string): string {
    return `${rootId}\0${relative}`;
  }
  private async recordNativeReceipt(
    pending: Pending,
    proof: NativePublicationProof,
  ): Promise<void> {
    const identity = await io(() => lstat(proof.identity.path));
    if (
      !sameFile(identity, pending.identity) ||
      identity.nlink !== 1 ||
      identity.isSymbolicLink()
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Native publication no longer matches its owned staged file.",
      );
    this.nativeReceipts.set(
      this.receiptKey(pending.root.id, pending.staged.artifact.path),
      {
        artifact: structuredClone(pending.staged.artifact),
        identity,
        proof: structuredClone(proof),
      },
    );
  }
  ensurePublicationDurable(
    rootId: string,
    input: readonly Artifact[],
    context: OperationContext,
  ): Promise<
    Outcome<{ durable: true; profile?: typeof WINDOWS_PUBLICATION_PROFILE }>
  > {
    return boundary(context, async (context) => {
      const { root, guard } = this.guard(rootId, context, "write");
      if (
        !Array.isArray(input) ||
        !input.length ||
        input.length > context.budget.maxExpandedNodes
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Durability verification requires a bounded nonempty artifact set.",
        );
      for (const artifact of input) {
        if (!validateContract("Artifact", artifact).success)
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Invalid artifact in durability request.",
          );
        portableRelativePath(artifact.path);
        guard.consume("input", Buffer.byteLength(JSON.stringify(artifact)));
      }
      const artifacts = structuredClone(input);
      return this.serial(async () => {
        guard.check();
        if (this.options.publicationProfile === WINDOWS_PUBLICATION_PROFILE) {
          for (const artifact of artifacts) {
            const receipt = this.nativeReceipts.get(
              this.receiptKey(rootId, artifact.path),
            );
            if (!receipt)
              throw new HostBoundaryError(
                "UNSUPPORTED_FEATURE",
                "No owned native publication evidence exists for this artifact; generic or reconstructed metadata cannot be promoted.",
                true,
              );
            if (
              Object.keys(receipt.artifact).some(
                (key) =>
                  Reflect.get(receipt.artifact, key) !==
                  Reflect.get(artifact, key),
              )
            )
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Artifact does not match the recorded native publication.",
              );
            const absolute = await this.resolve(root, artifact.path);
            const bytes = await this.readBytes(
              absolute,
              guard,
              receipt.identity,
            );
            if (
              bytes.byteLength !== artifact.byteLength ||
              sha256(bytes) !== artifact.sha256
            )
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Native published bytes changed.",
              );
            await this.nativePublisher.verify(absolute, receipt.proof, guard);
          }
          return { durable: true, profile: WINDOWS_PUBLICATION_PROFILE };
        }
        throw new HostBoundaryError(
          "UNSUPPORTED_FEATURE",
          "File data was flushed during staging, but host directory-entry power-loss durability is unverified; durable database references require a verified native flush adapter.",
          true,
        );
      });
    });
  }
  private async finishPublishedPair(
    stagePath: string,
    destination: string,
    artifact: Artifact,
    guard: OperationGuard,
    expected?: Stats,
    verifyBytes = true,
  ): Promise<void> {
    const stage = await io(() => lstat(stagePath));
    const published = await io(() => lstat(destination));
    if (
      stage.isSymbolicLink() ||
      published.isSymbolicLink() ||
      !stage.isFile() ||
      stage.nlink !== 2 ||
      published.nlink !== 2 ||
      !sameFile(stage, published) ||
      (expected && !sameFile(stage, expected))
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Publication recovery requires exactly the known stage/destination inode pair.",
      );
    if (verifyBytes) {
      const bytes = await this.readBytes(stagePath, guard, stage, 2);
      if (
        bytes.byteLength !== artifact.byteLength ||
        sha256(bytes) !== artifact.sha256
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Publication recovery bytes do not match the expected artifact.",
        );
    }
    const current = await io(() => lstat(destination));
    if (
      !sameFile(stage, current) ||
      current.nlink !== 2 ||
      current.isSymbolicLink()
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Publication destination changed during recovery.",
      );
    guard.check();
    await io(() => unlink(stagePath));
  }
  reconcilePublication(
    rootId: string,
    input: Artifact,
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<Artifact>> {
    return this.execute(context, async (context) => {
      const artifact = Object.freeze({ ...input });
      const { root, guard } = this.guard(rootId, context, "write");
      if (
        !root.managedBlobs ||
        !this.options.authorizePublicationRecovery ||
        !(await this.options.authorizePublicationRecovery(
          artifact,
          stagingId,
          context,
        ))
      )
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Historical publication recovery requires an explicit trusted reservation.",
        );
      if (
        !validateContract("Artifact", artifact).success ||
        artifact.id !== `sha256_${artifact.sha256}` ||
        artifact.path !== `blobs/${artifact.sha256}` ||
        artifact.mediaType !== "application/octet-stream" ||
        !/^[0-9a-f-]{36}$/.test(stagingId)
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Invalid recovery identity.",
        );
      if (this.pending.has(stagingId))
        throw new HostBoundaryError(
          "CONFLICT",
          "Current-instance publications must be retried by their owning operation.",
        );
      await this.checkRoot(root);
      const destination = await this.resolve(root, artifact.path);
      const matches: string[] = [];
      let inspected = 0;
      for (const entry of await boundedEntries(root.path, 20_000, guard)) {
        if (!/^\.host-[0-9a-f-]{36}$/.test(entry)) continue;
        const directory = path.join(root.path, entry);
        const stats = await io(() => lstat(directory));
        if (!stats.isDirectory() || stats.isSymbolicLink())
          throw new HostBoundaryError(
            "PATH_FORBIDDEN",
            "Historical staging path is not a real directory.",
          );
        const names = await boundedEntries(
          directory,
          20_000 - inspected,
          guard,
        );
        inspected += names.length;
        if (names.includes(stagingId))
          matches.push(path.join(directory, stagingId));
      }
      const stagePath = matches[0];
      if (matches.length !== 1 || !stagePath)
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Historical staging identity is missing or ambiguous.",
        );
      await this.finishPublishedPair(stagePath, destination, artifact, guard);
      return structuredClone(artifact);
    });
  }
  inspectCaptureRecovery(
    input: readonly CaptureRecoveryStage[],
    context: OperationContext,
  ): Promise<Outcome<CaptureRecoveryInspection>> {
    return this.inspectRetainedPublications(input, context, false);
  }
  inspectRetainedReference(
    supplied: RetainedReferenceInput,
    context: OperationContext,
  ): Promise<RetainedReferenceOutcome> {
    const input = structuredClone(supplied);
    // Only an observed guard can tag this invocation; later cleanup cannot replace it.
    let inventoryFailure: RetainedInventoryFailure | undefined;
    function reject(
      check: RetainedInventoryFailure["check"],
      category: RetainedInventoryFailure["category"],
      message: string,
      detail?: RetainedInventoryFailure["detail"],
    ): never {
      inventoryFailure ??= { check, category, ...(detail ? { detail } : {}) };
      throw new HostBoundaryError("ARTIFACT_INTEGRITY", message);
    }
    function observedFailure(
      error: unknown,
      check: RetainedInventoryFailure["check"],
      category: RetainedInventoryFailure["category"],
    ): never {
      if (
        error instanceof HostBoundaryError &&
        (check === "native-read-admission"
          ? error.code === "ACTION_REQUIRED"
          : error.code === "ARTIFACT_INTEGRITY" ||
            error.code === "PATH_FORBIDDEN")
      )
        inventoryFailure ??= { check, category };
      throw error;
    }
    return this.execute(context, async (context) => {
      const config = this.options.retainedReferenceInspection;
      if (
        !config ||
        input.targets.length !== 2 ||
        input.history.length > 128 ||
        (input.committedHistoryArtifacts?.length ?? 0) > 128 ||
        input.artifacts.length > 20000
      )
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Retained validation is not admitted.",
        );
      await config.authorize(input, context);
      const expected = new Map<string, CaptureRecoveryStage>();
      for (const stage of [...input.targets, ...input.history]) {
        if (
          !/^[0-9a-f-]{36}$/.test(stage.stagingId) ||
          !validateContract("Artifact", stage.artifact).success ||
          stage.artifact.id !== `sha256_${stage.artifact.sha256}` ||
          stage.artifact.path !== `blobs/${stage.artifact.sha256}` ||
          stage.artifact.mediaType !== "application/octet-stream" ||
          expected.has(stage.stagingId)
        )
          reject(
            "descriptor",
            input.targets.includes(stage) ? "retained-target" : "history-stage",
            "Invalid retained stage descriptor.",
          );
        expected.set(stage.stagingId, stage);
      }
      if (new Set(input.targets.map((s) => s.artifact.sha256)).size !== 2)
        reject(
          "descriptor",
          "retained-target",
          "Retained outputs are not distinct.",
        );
      const artifacts = new Map(input.artifacts.map((a) => [a.sha256, a]));
      if (
        artifacts.size !== input.artifacts.length ||
        input.artifacts.some(
          (a) =>
            !validateContract("Artifact", a).success ||
            a.id !== `sha256_${a.sha256}` ||
            a.path !== `blobs/${a.sha256}`,
        )
      )
        reject(
          "descriptor",
          "committed-inventory",
          "Invalid retained artifact inventory.",
        );
      const sameArtifact = (a: Artifact, b: Artifact | undefined) =>
        b !== undefined &&
        a.id === b.id &&
        a.sha256 === b.sha256 &&
        a.path === b.path &&
        a.byteLength === b.byteLength &&
        a.mediaType === b.mediaType;
      const committedHistory = new Map(
        (input.committedHistoryArtifacts ?? []).map((artifact) => [
          artifact.sha256,
          artifact,
        ]),
      );
      if (
        committedHistory.size !==
          (input.committedHistoryArtifacts?.length ?? 0) ||
        [...committedHistory.values()].some(
          (artifact) =>
            !validateContract("Artifact", artifact).success ||
            !sameArtifact(artifact, artifacts.get(artifact.sha256)) ||
            !input.history.some((stage) =>
              sameArtifact(stage.artifact, artifact),
            ),
        )
      )
        reject(
          "descriptor",
          "history-stage",
          "Invalid authenticated historical blob inventory.",
        );
      const pins: RetainedReadPin[] = [];
      const targets: RetainedReferenceInspection["targets"] = [];
      let closed = false;
      const close = () => {
        if (closed) return;
        for (const target of targets) target.bytes?.fill(0);
        const errors: unknown[] = [];
        for (const pin of [...pins].reverse()) {
          try {
            pin.close();
            pins.splice(pins.indexOf(pin), 1);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new HostBoundaryError(
            "INTERRUPTED",
            "Retained read handles did not close.",
            false,
            { cause: new AggregateError(errors) },
          );
        closed = true;
        this.retainedClosures.delete(close);
      };
      this.retainedClosures.add(close);
      type Entry = {
        rootId: string;
        relative: string;
        absolute: string;
        stat: Stats;
        directory: boolean;
      };
      const scan = async (): Promise<Entry[]> => {
        const entries: Entry[] = [];
        let remaining = 20000;
        const seenStages = new Set<string>();
        const seenBlobs = new Set<string>();
        const add = async (
          rootId: string,
          relative: string,
          absolute: string,
          directory: boolean,
        ) => {
          const stat = await io(() => lstat(absolute));
          if (
            stat.isSymbolicLink() ||
            stat.isDirectory() !== directory ||
            (!directory && !stat.isFile()) ||
            path.resolve(await io(() => realpath(absolute))) !==
              path.resolve(absolute)
          )
            throw new HostBoundaryError(
              "PATH_FORBIDDEN",
              "Retained path is not physical.",
            );
          entries.push({ rootId, relative, absolute, stat, directory });
        };
        for (const rootId of [config.artifactRootId, config.outputRootId]) {
          const { root, guard } = this.guard(rootId, context, "read");
          if (rootId === config.artifactRootId && !root.managedBlobs)
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Retained root is not managed.",
            );
          await this.checkRoot(root);
          const list = async (directory: string) => {
            const names = await boundedEntries(directory, remaining, guard);
            remaining -= names.length;
            if (
              new Set(names.map((n) => n.normalize("NFC").toLowerCase()))
                .size !== names.length
            )
              throw new HostBoundaryError(
                "PATH_FORBIDDEN",
                "Retained namespace aliases.",
              );
            return names.sort();
          };
          await add(rootId, "", root.path, true);
          for (const name of await list(root.path)) {
            const directory = path.join(root.path, name);
            if (name === "blobs" && rootId === config.artifactRootId) {
              await add(rootId, name, directory, true);
              for (const hash of await list(directory)) {
                if (
                  !/^[0-9a-f]{64}$/.test(hash) ||
                  (!artifacts.has(hash) &&
                    !input.targets.some((s) => s.artifact.sha256 === hash))
                )
                  throw new HostBoundaryError(
                    "ACTION_REQUIRED",
                    "Unclassified retained blob.",
                  );
                seenBlobs.add(hash);
                await add(
                  rootId,
                  `blobs/${hash}`,
                  path.join(directory, hash),
                  false,
                );
              }
            } else if (/^\.host-[0-9a-f-]{36}$/.test(name)) {
              await add(rootId, name, directory, true);
              for (const id of await list(directory)) {
                if (
                  rootId !== config.artifactRootId ||
                  !expected.has(id) ||
                  seenStages.has(id)
                )
                  throw new HostBoundaryError(
                    "ACTION_REQUIRED",
                    "Unclassified or duplicate retained stage.",
                  );
                seenStages.add(id);
                await add(
                  rootId,
                  `${name}/${id}`,
                  path.join(directory, id),
                  false,
                );
              }
            } else if (
              rootId === config.outputRootId &&
              /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(name)
            ) {
              await add(rootId, name, directory, false);
            } else {
              throw new HostBoundaryError(
                "ACTION_REQUIRED",
                "Unclassified retained namespace.",
              );
            }
          }
          await this.checkRoot(root);
          guard.check();
        }
        if ([...artifacts.keys()].some((hash) => !seenBlobs.has(hash)))
          reject(
            "missing-recorded-entry",
            "committed-inventory",
            "Recorded retained inventory is missing.",
          );
        if (input.history.some((s) => !seenStages.has(s.stagingId)))
          reject(
            "missing-recorded-entry",
            "history-stage",
            "Recorded retained inventory is missing.",
          );
        return entries;
      };
      const fingerprint = (entries: Entry[]) =>
        sha256(
          Buffer.from(
            JSON.stringify(
              entries.map(({ rootId, relative, stat, directory }) => ({
                rootId,
                relative,
                directory,
                dev: stat.dev,
                ino: stat.ino,
                size: stat.size,
                nlink: stat.nlink,
                mtime: stat.mtimeMs,
                ctime: stat.ctimeMs,
              })),
            ),
          ),
        );
      try {
        const entries = await scan();
        const identitySha256 = fingerprint(entries);
        const paired = new Set<Entry>();
        const independentHistory: { stage: Entry; blob: Entry }[] = [];
        const reads: {
          descriptor: CaptureRecoveryStage;
          entry: Entry;
          target?: RetainedReferenceInspection["targets"][number];
        }[] = [];
        for (const descriptor of [...input.targets, ...input.history]) {
          const stages = entries.filter(
            (e) =>
              e.rootId === config.artifactRootId &&
              e.relative.endsWith(`/${descriptor.stagingId}`),
          );
          const stage = stages[0];
          const blob = entries.find(
            (e) =>
              e.rootId === config.artifactRootId &&
              e.relative === descriptor.artifact.path,
          );
          const isTarget = input.targets.some(
            (s) => s.stagingId === descriptor.stagingId,
          );
          const historyCoexists =
            !isTarget &&
            stage &&
            blob &&
            sameArtifact(
              descriptor.artifact,
              committedHistory.get(descriptor.artifact.sha256),
            ) &&
            !sameFile(stage.stat, blob.stat) &&
            stage.stat.nlink === 1 &&
            blob.stat.nlink === 1 &&
            stage.stat.size === descriptor.artifact.byteLength &&
            blob.stat.size === descriptor.artifact.byteLength;
          if (stage && blob && isTarget) {
            if (
              !sameFile(stage.stat, blob.stat) ||
              stage.stat.nlink !== 2 ||
              blob.stat.nlink !== 2 ||
              stage.stat.size !== descriptor.artifact.byteLength ||
              blob.stat.size !== descriptor.artifact.byteLength
            )
              reject(
                "publication-shape",
                "retained-target",
                "Ambiguous retained publication.",
                !sameFile(stage.stat, blob.stat)
                  ? "distinct-target-copies"
                  : stage.stat.nlink !== 2 || blob.stat.nlink !== 2
                    ? "link-count-or-shared-identity"
                    : "recorded-length-mismatch",
              );
            paired.add(stage);
            paired.add(blob);
            targets.push({
              descriptor,
              publication: "known-pair-native-read-blocked",
            });
            continue;
          }
          const entry = stage ?? (isTarget ? blob : undefined);
          if (
            !entry ||
            (stage && blob && !historyCoexists) ||
            entry.stat.nlink !== 1 ||
            entry.stat.size !== descriptor.artifact.byteLength
          )
            reject(
              "publication-shape",
              isTarget ? "retained-target" : "history-stage",
              "Retained publication is missing or ambiguous.",
              !entry
                ? "missing-stage-or-entry"
                : stage &&
                    blob &&
                    !historyCoexists &&
                    !sameArtifact(
                      descriptor.artifact,
                      committedHistory.get(descriptor.artifact.sha256),
                    )
                  ? "unproven-history-coexistence"
                  : entry.stat.nlink !== 1 ||
                      (stage &&
                        blob &&
                        (sameFile(stage.stat, blob.stat) ||
                          blob.stat.nlink !== 1))
                    ? "link-count-or-shared-identity"
                    : "recorded-length-mismatch",
            );
          const target = isTarget
            ? {
                descriptor,
                publication: stage
                  ? ("stage-only" as const)
                  : ("published-only" as const),
              }
            : undefined;
          if (target) targets.push(target);
          reads.push({ descriptor, entry, ...(target ? { target } : {}) });
          if (historyCoexists) {
            independentHistory.push({ stage, blob });
            reads.push({ descriptor, entry: blob });
          }
        }
        const nativeIdentities: RetainedReadPin["identity"][] = [];
        const entryIdentities = new Map<Entry, RetainedReadPin["identity"]>();
        const proofKeys = new Set(this.proofReads.keys());
        const category = (
          entry: Entry,
        ): RetainedInventoryFailure["category"] => {
          if (entry.directory || entry.rootId !== config.artifactRootId)
            return "namespace";
          if (this.proofReads.has(`${entry.rootId}\0${entry.relative}`))
            return "original-proof";
          if (
            input.targets.some(
              (s) =>
                entry.relative === s.artifact.path ||
                entry.relative.endsWith(`/${s.stagingId}`),
            )
          )
            return "retained-target";
          if (
            input.history.some((s) =>
              entry.relative.endsWith(`/${s.stagingId}`),
            )
          )
            return "history-stage";
          return "committed-inventory";
        };
        for (const entry of entries) {
          if (paired.has(entry)) continue;
          if (!entry.directory && entry.stat.nlink !== 1)
            throw new HostBoundaryError(
              "PATH_FORBIDDEN",
              "Unexpected retained links.",
            );
          const artifact = artifacts.get(entry.relative.slice("blobs/".length));
          if (
            entry.relative.startsWith("blobs/") &&
            artifact &&
            entry.stat.size !== artifact.byteLength
          )
            reject(
              "committed-size",
              "committed-inventory",
              "Recorded blob length differs.",
            );
          let pin: RetainedReadPin;
          try {
            pin = await config.pin(
              entry.rootId,
              entry.relative,
              entry.directory,
            );
          } catch (error) {
            observedFailure(error, "native-read-admission", category(entry));
          }
          pins.push(pin);
          const proofKey = `${entry.rootId}\0${entry.relative}`;
          const prior = this.proofReads.get(proofKey);
          if (prior && !this.sameProofNativeIdentity(prior, pin))
            reject(
              "proof-native-identity",
              "original-proof",
              "Source proof changed before retained inspection.",
            );
          if (prior && !this.sameProofStat(prior.stat, entry.stat))
            reject(
              "proof-stat",
              "original-proof",
              "Source proof changed before retained inspection.",
            );
          proofKeys.delete(proofKey);
          nativeIdentities.push(pin.identity);
          entryIdentities.set(entry, pin.identity);
        }
        for (const { stage, blob } of independentHistory) {
          const staged = entryIdentities.get(stage);
          const committed = entryIdentities.get(blob);
          if (
            !staged ||
            !committed ||
            (staged.volume === committed.volume &&
              staged.file === committed.file)
          )
            reject(
              "publication-shape",
              "history-stage",
              "Historical stage and committed blob identities are not independent.",
              !staged || !committed
                ? "native-identity-unavailable"
                : "native-identity-not-distinct",
            );
        }
        if (proofKeys.size)
          reject(
            "proof-membership",
            "original-proof",
            "Source proof is outside the retained inventory.",
          );
        const check = async () => {
          if (closed)
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Retained inspection is closed.",
            );
          await config.authorize(input, context);
          if (fingerprint(await scan()) !== identitySha256)
            reject(
              "inventory-recheck",
              "namespace",
              "Retained identity inventory changed.",
            );
          let index = 0;
          for (const entry of entries) {
            if (paired.has(entry)) continue;
            let fresh: RetainedReadPin;
            try {
              fresh = await config.pin(
                entry.rootId,
                entry.relative,
                entry.directory,
              );
            } catch (error) {
              observedFailure(error, "native-read-admission", category(entry));
            }
            pins.push(fresh);
            const prior = nativeIdentities[index++];
            if (
              !prior ||
              fresh.identity.path !== prior.path ||
              fresh.identity.volume !== prior.volume ||
              fresh.identity.file !== prior.file
            )
              reject(
                "native-identity-recheck",
                category(entry),
                "Current native retained identity changed.",
              );
            fresh.close();
            pins.splice(pins.indexOf(fresh), 1);
          }
          await config.authorize(input, context);
        };
        if (
          !targets.some(
            (t) => t.publication === "known-pair-native-read-blocked",
          )
        ) {
          for (const { descriptor, entry, target } of reads) {
            const { guard } = this.guard(
              config.artifactRootId,
              context,
              "read",
            );
            const pin = pins.find(
              (candidate) => candidate.identity.path === entry.absolute,
            );
            if (!pin)
              reject(
                "native-read-admission",
                category(entry),
                "Retained body has no owned native read pin.",
              );
            try {
              await pin.check();
            } catch (error) {
              observedFailure(error, "native-read-admission", category(entry));
            }
            guard.check();
            let bytes: Uint8Array;
            try {
              bytes = await this.readBytes(entry.absolute, guard, entry.stat);
            } catch (error) {
              observedFailure(error, "body-read", category(entry));
            }
            try {
              try {
                await pin.check();
              } catch (error) {
                observedFailure(
                  error,
                  "native-read-admission",
                  category(entry),
                );
              }
              guard.check();
            } catch (error) {
              bytes.fill(0);
              throw error;
            }
            if (
              bytes.length !== descriptor.artifact.byteLength ||
              sha256(bytes) !== descriptor.artifact.sha256
            ) {
              bytes.fill(0);
              reject(
                "body-hash",
                category(entry),
                "Retained bytes differ from the journal.",
              );
            }
            if (target) target.bytes = bytes;
            else bytes.fill(0);
          }
        }
        await check();
        return {
          identitySha256: sha256(
            Buffer.from(JSON.stringify([identitySha256, nativeIdentities])),
          ),
          targets,
          check,
          close,
        };
      } catch (error) {
        try {
          close();
        } catch (cleanup) {
          if (error instanceof HostBoundaryError)
            throw new HostBoundaryError(
              error.code,
              "Retained validation and close failed.",
              error.unavailable,
              {
                cause: new AggregateError([error, cleanup]),
              },
            );
          throw new AggregateError(
            [error, cleanup],
            "Retained validation and close failed.",
          );
        }
        throw error;
      }
    }).then((outcome) =>
      outcome.status !== "complete" &&
      outcome.status !== "partial" &&
      outcome.status !== "cancelled" &&
      inventoryFailure
        ? { ...outcome, inventoryFailure }
        : outcome,
    );
  }
  inspectReferencePublications(
    input: readonly CaptureRecoveryStage[],
    context: OperationContext,
  ): Promise<Outcome<CaptureRecoveryInspection>> {
    return this.inspectRetainedPublications(input, context, true);
  }
  private inspectRetainedPublications(
    input: readonly CaptureRecoveryStage[],
    context: OperationContext,
    reference: boolean,
  ): Promise<Outcome<CaptureRecoveryInspection>> {
    const stages = structuredClone(input);
    return this.execute(context, async (context) => {
      const config = reference
        ? this.options.referenceInspection
        : this.options.captureRecoveryInspection;
      if (!config || stages.length > 128)
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Native capture inspection is not admitted.",
        );
      await config.authorize(stages, context);
      const expected = new Map<string, CaptureRecoveryStage>();
      for (const stage of stages) {
        if (
          !/^[0-9a-f-]{36}$/.test(stage.stagingId) ||
          !validateContract("StableId", stage.jobId).success ||
          !validateContract("StableId", stage.requestId).success ||
          !validateContract("Artifact", stage.artifact).success ||
          expected.has(stage.stagingId)
        )
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Invalid native capture stage evidence.",
          );
        expected.set(stage.stagingId, stage);
      }
      const result: CaptureRecoveryInspection = { artifacts: [], stages: [] };
      let remaining = 20000;
      try {
        for (const id of [config.artifactRootId, config.outputRootId]) {
          const { root, guard } = this.guard(id, context, "write");
          if (id === config.artifactRootId && !root.managedBlobs)
            throw new HostBoundaryError(
              "FORBIDDEN",
              "Capture inspection requires the owned managed artifact root.",
            );
          await this.checkRoot(root);
          const list = async (directory: string) => {
            const entries = await boundedEntries(directory, remaining, guard);
            remaining -= entries.length;
            return entries;
          };
          for (const entry of await list(root.path)) {
            const directory = path.join(root.path, entry);
            if (entry === "blobs" && id === config.artifactRootId) {
              await this.resolve(root, "blobs");
              for (const name of await list(directory)) {
                if (!/^[0-9a-f]{64}$/.test(name))
                  throw new HostBoundaryError(
                    "ARTIFACT_INTEGRITY",
                    "Capture blob namespace is not exact.",
                  );
                const absolute = await this.resolve(root, `blobs/${name}`);
                const bytes = await this.readBytes(absolute, guard);
                try {
                  if (sha256(bytes) !== name)
                    throw new HostBoundaryError(
                      "ARTIFACT_INTEGRITY",
                      "Capture blob evidence changed.",
                    );
                  result.artifacts.push({
                    id: `sha256_${name}`,
                    sha256: name,
                    path: `blobs/${name}`,
                    byteLength: bytes.length,
                    mediaType: "application/octet-stream",
                  });
                } finally {
                  bytes.fill(0);
                }
              }
            } else if (/^\.host-[0-9a-f-]{36}$/.test(entry)) {
              const before = await io(() => lstat(directory));
              if (
                !before.isDirectory() ||
                before.isSymbolicLink() ||
                path.resolve(await io(() => realpath(directory))) !==
                  path.resolve(directory)
              )
                throw new HostBoundaryError(
                  "PATH_FORBIDDEN",
                  "Capture staging directory is not owned.",
                );
              for (const name of await list(directory)) {
                const descriptor = expected.get(name);
                if (!descriptor || id !== config.artifactRootId)
                  throw new HostBoundaryError(
                    "ACTION_REQUIRED",
                    "Unowned capture staging evidence requires separate recovery.",
                  );
                const filename = path.join(directory, name);
                const stat = await io(() => lstat(filename));
                if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
                  throw new HostBoundaryError(
                    "ARTIFACT_INTEGRITY",
                    "Capture publication is ambiguous.",
                  );
                const bytes = await this.readBytes(filename, guard, stat);
                if (
                  bytes.length !== descriptor.artifact.byteLength ||
                  sha256(bytes) !== descriptor.artifact.sha256
                ) {
                  bytes.fill(0);
                  throw new HostBoundaryError(
                    "ARTIFACT_INTEGRITY",
                    "Retained capture stage differs from its record.",
                  );
                }
                result.stages.push({ descriptor, bytes });
                expected.delete(name);
              }
              const after = await io(() => lstat(directory));
              if (!sameFile(before, after) || after.isSymbolicLink())
                throw new HostBoundaryError(
                  "PATH_FORBIDDEN",
                  "Capture staging directory changed.",
                );
            } else if (
              reference &&
              id === config.outputRootId &&
              /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(entry)
            ) {
              const absolute = await this.resolve(root, entry);
              const stat = await io(() => lstat(absolute));
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                throw new HostBoundaryError(
                  "ARTIFACT_INTEGRITY",
                  "Private export identity is ambiguous.",
                );
              const bytes = await this.readBytes(absolute, guard, stat);
              bytes.fill(0);
            } else {
              throw new HostBoundaryError(
                "ACTION_REQUIRED",
                "Unclassified capture publication requires separate recovery.",
              );
            }
          }
          await this.checkRoot(root);
          guard.check();
        }
        if (expected.size)
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Recorded capture stages are missing.",
          );
        await config.authorize(stages, context);
        result.artifacts.sort((a, b) => a.id.localeCompare(b.id));
        result.stages.sort((a, b) =>
          a.descriptor.stagingId.localeCompare(b.descriptor.stagingId),
        );
        return result;
      } catch (error) {
        for (const stage of result.stages) stage.bytes.fill(0);
        throw error;
      }
    });
  }
  inventory(
    rootId: string,
    context: OperationContext,
    maxEntries: number,
  ): Promise<Outcome<ManagedInventory>> {
    return this.execute(context, async (context) => {
      const { root, guard } = this.guard(rootId, context, "write");
      if (!root.managedBlobs)
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Root is not explicitly provisioned for managed blob maintenance.",
        );
      if (
        !Number.isSafeInteger(maxEntries) ||
        maxEntries <= 0 ||
        maxEntries > 20_000
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Inventory requires a finite entry bound from 1 to 20000.",
        );
      await this.checkRoot(root);
      let remaining = maxEntries;
      const list = async (directory: string) => {
        const entries = await boundedEntries(directory, remaining, guard);
        remaining -= entries.length;
        return entries;
      };
      const result: ManagedInventory = {
        stagedIds: [],
        publishedArtifacts: [],
      };
      const rootEntries = await list(root.path);
      for (const entry of rootEntries) {
        if (entry === "blobs") {
          const directory = await this.resolve(root, "blobs");
          for (const name of await list(directory)) {
            if (!/^[0-9a-f]{64}$/.test(name))
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Managed namespace contains a non-hash blob.",
              );
            const relative = `blobs/${name}`;
            const absolute = await this.resolve(root, relative);
            const bytes = await this.readBytes(absolute, guard);
            if (sha256(bytes) !== name)
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Managed blob content does not match its path.",
              );
            result.publishedArtifacts.push({
              id: `sha256_${name}`,
              path: relative,
              sha256: name,
              byteLength: bytes.byteLength,
              mediaType: "application/octet-stream",
            });
          }
        } else if (/^\.host-[0-9a-f-]{36}$/.test(entry)) {
          const directory = path.join(root.path, entry);
          const stat = await io(() => lstat(directory));
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new HostBoundaryError(
              "PATH_FORBIDDEN",
              "Historical staging entry is not a real directory.",
            );
          for (const name of await list(directory)) {
            if (
              !/^[0-9a-f-]{36}$/.test(name) ||
              result.stagedIds.includes(name)
            )
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Historical staging ID is invalid or duplicated.",
              );
            const file = await io(() => lstat(path.join(directory, name)));
            if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
              throw new HostBoundaryError(
                "PATH_FORBIDDEN",
                "Historical stage is not an exclusively linked file.",
              );
            result.stagedIds.push(name);
          }
        }
      }
      await this.checkRoot(root);
      guard.check();
      return result;
    });
  }
  removeUnreferenced(
    rootId: string,
    input: Artifact,
    context: OperationContext,
  ): Promise<Outcome<{ removed: true }>> {
    return this.execute(context, async (context) => {
      const artifact = Object.freeze({ ...input });
      const { root, guard } = this.guard(rootId, context, "write");
      if (!root.managedBlobs || !this.options.authorizeRemoval)
        throw new HostBoundaryError(
          "FORBIDDEN",
          "Managed-root removal requires an explicit reference-safe reservation.",
        );
      if (
        !validateContract("Artifact", artifact).success ||
        artifact.path !== `blobs/${artifact.sha256}` ||
        artifact.id !== `sha256_${artifact.sha256}` ||
        artifact.mediaType !== "application/octet-stream"
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Removal metadata is not an exact managed-blob identity.",
        );
      if (!(await this.options.authorizeRemoval(artifact, context)))
        throw new HostBoundaryError(
          "FORBIDDEN",
          "No active reference-safe removal reservation.",
        );
      guard.check();
      const absolute = await this.resolve(root, artifact.path);
      const before = await io(() => lstat(absolute));
      const bytes = await this.readBytes(absolute, guard, before);
      if (
        bytes.byteLength !== artifact.byteLength ||
        sha256(bytes) !== artifact.sha256
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Removal bytes do not match the expected artifact.",
        );
      await this.resolve(root, artifact.path);
      const after = await io(() => lstat(absolute));
      if (
        !sameFile(before, after) ||
        after.nlink !== 1 ||
        after.isSymbolicLink()
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Removal target identity changed.",
        );
      guard.check();
      await io(() => unlink(absolute));
      return { removed: true };
    });
  }
  private assertCloseable(): void {
    if ([...this.pending.values()].some((pending) => pending.busy))
      throw new HostBoundaryError(
        "CONFLICT",
        "Cannot close during publication/discard.",
      );
    if (
      [...this.pending.values()].some(
        (pending) => pending.nativeState || pending.publishedDestination,
      )
    )
      throw new HostBoundaryError(
        "OUTPUT_UNCERTAIN",
        "Visible interrupted publications must be reconciled before close; the boundary remains usable for retry.",
      );
  }
  private async cleanup(): Promise<void> {
    this.closeRetainedReads();
    if (this.preserved) return;
    this.assertCloseable();
    this.closed = true;
    for (const [id, pending] of this.pending) {
      await this.checkStaging(pending.root);
      const stats = await io(() => lstat(pending.path));
      if (
        !sameFile(stats, pending.identity) ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Owned staging file was replaced.",
        );
      await io(() => unlink(pending.path));
      this.pending.delete(id);
    }
    for (const root of this.roots.values()) {
      if (root.staging) {
        await this.checkStaging(root);
        await io(() => rmdir(root.staging?.path ?? ""));
        delete root.staging;
      }
    }
    this.nativeReceipts.clear();
  }
}
