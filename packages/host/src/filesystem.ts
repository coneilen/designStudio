import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  type Artifact,
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

export interface ProjectRoot {
  id: string;
  path: string;
  access: "read" | "read-write";
  /** Caller attests no untrusted concurrent writers or directory replacement. */
  trustedExclusiveAccess: true;
}
export interface ProjectFileSystemOptions {
  projectId: string;
  authority: Authority;
  roots: readonly ProjectRoot[];
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

export class ProjectFileSystem implements FileSystemBoundary {
  private readonly roots = new Map<string, Root>();
  private readonly pending = new Map<string, Pending>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(private readonly options: ProjectFileSystemOptions) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Release the queue on failure; the original promise still reports the error.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private execute<T>(
    context: OperationContext,
    operation: () => Promise<T>,
  ): Promise<Outcome<T>> {
    return this.serial(() => boundary(context, operation));
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
      const entries = await io(() => readdir(current));
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
          before.nlink !== 1 ||
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
    request: FileRequest,
    context: OperationContext,
  ): Promise<Outcome<Uint8Array>> {
    return this.execute(context, async () => {
      const { root, guard } = this.guard(
        request.artifactRootId,
        context,
        "read",
      );
      const absolute = await this.resolve(root, request.path);
      const result = await this.readBytes(absolute, guard);
      await this.resolve(root, request.path);
      guard.check();
      return result;
    });
  }
  stage(
    request: FileRequest,
    bytes: Uint8Array,
    context: OperationContext,
  ): Promise<Outcome<StagedArtifact>> {
    return this.execute(context, async () => {
      const { root, guard } = this.guard(
        request.artifactRootId,
        context,
        "write",
      );
      guard.consume("input", bytes.byteLength);
      guard.consume("output", bytes.byteLength);
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
      const owned = Uint8Array.from(bytes);
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
    staged: StagedArtifact,
    context: OperationContext,
  ): Promise<Outcome<Artifact>> {
    return this.execute(context, async () => {
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
        // Same-filesystem hard-link publication is atomic and never replaces an existing file.
        await io(() => link(pending.path, destination));
        await io(() => unlink(pending.path));
        this.pending.delete(staged.stagingId);
        return structuredClone(pending.staged.artifact);
      } finally {
        pending.busy = false;
      }
    });
  }
  discard(
    stagingId: string,
    context: OperationContext,
  ): Promise<Outcome<{ discarded: true }>> {
    return this.execute(context, async () => {
      const { pending, guard } = this.own(stagingId, context);
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
    return this.serial(() => this.cleanup());
  }
  private async cleanup(): Promise<void> {
    if ([...this.pending.values()].some((pending) => pending.busy))
      throw new HostBoundaryError(
        "CONFLICT",
        "Cannot close during publication/discard.",
      );
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
  }
}
