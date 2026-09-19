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
  busy: boolean;
  publishedDestination?: string;
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
  private readonly roots = new Map<string, Root>();
  private readonly pending = new Map<string, Pending>();
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
    const boundary = new ProjectFileSystem({ ...options });
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
        const bytes = new Uint8Array(before.size);
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
        const result = await this.readBytes(absolute, guard);
        await this.resolve(root, request.path);
        guard.check();
        return result;
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
        const { pending, guard } = this.own(staged.stagingId, context);
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
            if (
              bytes.byteLength !== pending.staged.artifact.byteLength ||
              sha256(bytes) !== pending.staged.artifact.sha256
            )
              throw new HostBoundaryError(
                "ARTIFACT_INTEGRITY",
                "Interrupted native publication bytes changed.",
              );
            const proof = await this.nativePublisher.resume(
              destination,
              pending.nativeState,
              guard,
            );
            await this.recordNativeReceipt(pending, proof);
            this.pending.delete(staged.stagingId);
            return structuredClone(pending.staged.artifact);
          }
          if (pending.publishedDestination) {
            await this.resolve(pending.root, staged.artifact.path);
            await this.finishPublishedPair(
              pending.path,
              pending.publishedDestination,
              pending.staged.artifact,
              guard,
              pending.identity,
            );
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
  /** Dispose this boundary without discarding privately journaled source attempts. */
  closePreservingStages(): Promise<void> {
    return this.serial(async () => {
      if (this.preserved) return;
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
