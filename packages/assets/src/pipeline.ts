import type {
  Artifact,
  ArtifactReference,
  AssetResource,
  FileSystemBoundary,
  FontResource,
  LicenseEvidence,
  OperationContext,
  StagedArtifact,
} from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  AssetError,
  bound,
  fail,
  inputLimit,
  type RightsAuthority,
  sha256,
  verifyBytes,
  verifyRights,
} from "./core.js";
import { verifyFont } from "./font.js";
import { classify, decodeRaster } from "./media.js";
import { checkContext } from "./remote.js";
import { sanitizeSvg } from "./svg.js";

export const ASSET_PROFILE = Object.freeze({
  adapterVersion: "assets-1.0.0",
  schemaVersion: "1.0",
  derivativeVersion: "static-svg-v1",
  png: "decoded-8bit-rgb-rgba-noninterlaced",
  jpeg: "unsupported-decoder",
  webp: "unsupported-decoder",
  svg: "sanitized-static-shapes-no-css-text-or-references",
  font: "static-truetype-identity-cmap-not-rasterization",
  remote: "injected-pinned-transport-only-no-native-network-default",
} as const);

export interface ImageInput {
  kind: "image";
  id: string;
  bytes: Uint8Array;
  license: LicenseEvidence;
  notice: Uint8Array;
  source: ArtifactReference;
  usageNodeIds: string[];
}
export interface FontInput {
  kind: "font";
  bytes: Uint8Array;
  face: FontResource;
  text: string;
  notice: Uint8Array;
}
export type AssetInput = ImageInput | FontInput;
export interface AssetAccess {
  permissionScope: string;
  offlineAllowed: boolean;
}
export interface AssetDependencies {
  filesystem: FileSystemBoundary;
  /** Must invoke the trusted F04 authority gate; claims alone cannot grant access. */
  authorize(
    context: OperationContext,
    artifactRootId: string,
    operation: "read" | "write",
  ): Promise<AssetAccess>;
  rightsAuthority: RightsAuthority;
}
export interface CacheIdentity {
  projectId: string;
  artifactRootId: string;
  permissionScope: string;
  sourceSha256: string;
  dependencyHashes: readonly string[];
  adapterVersion: string;
  schemaVersion: string;
  derivativeVersion: string;
}
export function cacheIdentity(identity: CacheIdentity): string {
  if (
    ![
      identity.projectId,
      identity.artifactRootId,
      identity.permissionScope,
      identity.adapterVersion,
      identity.schemaVersion,
      identity.derivativeVersion,
    ].every(
      (part) =>
        typeof part === "string" && part.length > 0 && part.length <= 1024,
    ) ||
    ![identity.sourceSha256, ...identity.dependencyHashes].every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    )
  )
    fail(
      "CACHE_IDENTITY",
      "Cache identities require exact versioned project/permission and byte dependencies",
    );
  return sha256(
    JSON.stringify([
      identity.projectId,
      identity.artifactRootId,
      identity.permissionScope,
      identity.sourceSha256,
      [...new Set(identity.dependencyHashes)].sort(),
      identity.adapterVersion,
      identity.schemaVersion,
      identity.derivativeVersion,
    ]),
  );
}
export interface CachedAsset {
  key: string;
  projectId: string;
  permissionScope: string;
  artifact: Artifact;
}
export interface CacheRequest {
  artifactRootId: string;
  sourceSha256: string;
  dependencyHashes: readonly string[];
  derivativeVersion: string;
}
export type CacheLookup = (key: string) => Promise<CachedAsset | undefined>;

export interface StagedSnapshot {
  staged: StagedArtifact[];
  images: { resource: AssetResource; mediaType: string; original: Artifact }[];
  fonts: { resource: FontResource; face: ReturnType<typeof verifyFont> }[];
  totalBytes: number;
  permissionScope: string;
}
export class AssetStagingError extends AssetError {
  constructor(
    readonly staged: readonly StagedArtifact[],
    readonly boundaryStatus: string,
  ) {
    super({
      code: "STAGING_FAILED",
      message:
        "Incomplete staging; caller retains receipts for F03 recovery, no publication or deletion performed",
    });
  }
}

export class AssetPipeline {
  constructor(private readonly dependencies: AssetDependencies) {}

  private async access(
    root: string,
    context: OperationContext,
    operation: "read" | "write",
  ): Promise<AssetAccess> {
    checkContext(context);
    if (!validateContract("StableId", root).success)
      fail("ROOT_ID", "Expected an authorized artifact root ID, not a path");
    const access = await this.dependencies.authorize(context, root, operation);
    checkContext(context);
    if (
      !access.permissionScope ||
      access.permissionScope.length > 1024 ||
      typeof access.offlineAllowed !== "boolean"
    )
      fail(
        "AUTH_CONTRACT",
        "Trusted gate must return an explicit permission revision and offline policy",
      );
    return access;
  }

  async stageSnapshot(
    artifactRootId: string,
    inputs: readonly AssetInput[],
    context: OperationContext,
  ): Promise<StagedSnapshot> {
    checkContext(context);
    const started = context.clock.now();
    const limits = { ...context.budget };
    const checkpoint = () => {
      checkContext(context);
      bound(
        "DURATION",
        Math.ceil(context.clock.now() - started),
        limits.maxDurationMs,
      );
    };
    const access = await this.access(artifactRootId, context, "write");
    checkpoint();
    bound("ASSET_COUNT", inputs.length, limits.maxExpandedNodes);
    const blobs = new Map<string, Buffer>();
    let totalBytes = 0;
    const add = (bytes: Uint8Array): string => {
      inputLimit(bytes, limits);
      const hash = sha256(bytes);
      if (!blobs.has(hash)) {
        bound(
          "SNAPSHOT_BYTES",
          totalBytes + bytes.byteLength,
          limits.maxSnapshotAssetBytes,
        );
        totalBytes += bytes.byteLength;
        blobs.set(hash, Buffer.from(bytes));
      }
      return hash;
    };
    // Snapshot bytes before any later awaits. Each unique original/notice counts once.
    const captured = inputs.map((input) => {
      const hash = add(input.bytes);
      const notice = add(input.notice);
      return input.kind === "image"
        ? {
            ...structuredClone({
              ...input,
              bytes: undefined,
              notice: undefined,
            }),
            kind: "image" as const,
            hash,
            notice,
          }
        : {
            ...structuredClone({
              ...input,
              bytes: undefined,
              notice: undefined,
            }),
            kind: "font" as const,
            hash,
            notice,
          };
    });
    const get = (hash: string) => {
      const bytes = blobs.get(hash);
      if (!bytes) fail("PIPELINE_STATE", "Missing prepared bytes");
      return bytes;
    };
    const imagePlans: {
      input: ImageInput;
      original: string;
      selected: string;
      width: number;
      height: number;
      colorSpace: AssetResource["colorSpace"];
      alpha: AssetResource["alpha"];
      mediaType: string;
      sanitized: boolean;
    }[] = [];
    const fontPlans: {
      input: FontInput;
      hash: string;
      face: ReturnType<typeof verifyFont>;
    }[] = [];
    const ids = new Set<string>();
    for (const item of captured) {
      checkpoint();
      const bytes = get(item.hash);
      const notice = get(item.notice);
      const id = item.kind === "image" ? item.id : item.face.id;
      if (!validateContract("StableId", id).success || ids.has(id))
        fail("ASSET_ID", "Resource IDs must be valid and unique");
      ids.add(id);
      if (item.kind === "font") {
        if (item.face.kind !== "bundled")
          fail(
            "FONT_LOCAL_ONLY",
            "Local requirements may be verified in place but cannot be staged as bundled fonts",
          );
        const input: FontInput = {
          kind: "font",
          bytes,
          face: item.face,
          text: item.text,
          notice,
        };
        const face = verifyFont(
          bytes,
          input.face,
          input.text,
          notice,
          "redistribute",
          this.dependencies.rightsAuthority,
          limits,
        );
        fontPlans.push({ input, hash: item.hash, face });
      } else {
        if (
          !validateContract("ArtifactReference", item.source).success ||
          !item.usageNodeIds.every(
            (node) => validateContract("StableId", node).success,
          )
        )
          fail("ASSET_PROVENANCE", "Invalid provenance or usage identity");
        const input: ImageInput = {
          kind: "image",
          id: item.id,
          bytes,
          notice,
          source: item.source,
          usageNodeIds: item.usageNodeIds,
          license: item.license,
        };
        verifyRights(
          input.license,
          bytes,
          notice,
          "redistribute",
          this.dependencies.rightsAuthority,
        );
        const mediaType = classify(bytes);
        if (mediaType === "image/svg+xml") {
          const safe = sanitizeSvg(bytes, limits);
          const selected = add(safe.bytes);
          imagePlans.push({
            input,
            original: item.hash,
            selected,
            width: safe.width,
            height: safe.height,
            colorSpace: "srgb",
            alpha: "straight",
            mediaType,
            sanitized: true,
          });
        } else {
          const decoded = decodeRaster(bytes, limits);
          imagePlans.push({
            input,
            original: item.hash,
            selected: item.hash,
            width: decoded.width,
            height: decoded.height,
            colorSpace: decoded.colorSpace,
            alpha: decoded.alpha,
            mediaType,
            sanitized: false,
          });
        }
      }
    }
    checkpoint();
    bound("SNAPSHOT_BYTES", totalBytes, limits.maxSnapshotAssetBytes);
    bound("OPERATION_OUTPUT_BYTES", totalBytes, limits.maxOutputBytes);
    const staged: StagedArtifact[] = [];
    const artifacts = new Map<string, Artifact>();
    try {
      for (const [hash, bytes] of blobs) {
        const current = await this.access(artifactRootId, context, "write");
        checkpoint();
        if (current.permissionScope !== access.permissionScope)
          throw new AssetStagingError(staged, "permission-changed");
        const outcome = await this.dependencies.filesystem.stage(
          { artifactRootId, path: `blobs/${hash}` },
          bytes,
          context,
        );
        if (
          outcome.projectId !== context.projectId ||
          outcome.requestId !== context.requestId
        )
          throw new AssetStagingError(staged, "scope-mismatch");
        if (outcome.status === "partial") {
          staged.push(structuredClone(outcome.value));
          throw new AssetStagingError(staged, outcome.status);
        }
        if (outcome.status !== "complete")
          throw new AssetStagingError(staged, outcome.status);
        staged.push(structuredClone(outcome.value));
        if (
          outcome.projectId !== context.projectId ||
          outcome.requestId !== context.requestId ||
          !validateContract("Artifact", outcome.value.artifact).success ||
          outcome.value.artifact.sha256 !== hash ||
          outcome.value.artifact.byteLength !== bytes.length
        )
          throw new AssetStagingError(staged, "integrity-mismatch");
        artifacts.set(hash, structuredClone(outcome.value.artifact));
        checkpoint();
      }
    } catch (error) {
      if (error instanceof AssetStagingError) throw error;
      throw new AssetStagingError(
        staged,
        error instanceof AssetError
          ? error.diagnostic.code
          : "boundary-exception",
      );
    }
    const artifact = (hash: string) => {
      const result = artifacts.get(hash);
      if (!result) fail("PIPELINE_STATE", "Missing stage receipt");
      return result;
    };
    return {
      staged,
      totalBytes,
      permissionScope: access.permissionScope,
      images: imagePlans.map((plan) => ({
        mediaType: plan.mediaType,
        original: artifact(plan.original),
        resource: {
          id: plan.input.id,
          artifact: artifact(plan.selected),
          width: plan.width,
          height: plan.height,
          colorSpace: plan.colorSpace,
          alpha: plan.alpha,
          license: {
            ...plan.input.license,
            notice: artifact(sha256(plan.input.notice)),
          },
          source: plan.input.source,
          usageNodeIds: plan.input.usageNodeIds,
          verification: plan.sanitized ? "sanitized" : "decoded",
          ...(plan.sanitized
            ? {
                derivativeOf: {
                  id: artifact(plan.original).id,
                  sha256: plan.original,
                },
              }
            : {}),
        },
      })),
      fonts: fontPlans.map((plan) => ({
        face: plan.face,
        resource: {
          ...plan.input.face,
          artifact: artifact(plan.hash),
          license: {
            ...plan.input.face.license,
            notice: artifact(sha256(plan.input.notice)),
          },
          availability: "verified",
          glyphCoverage: "fixture-verified",
        },
      })),
    };
  }

  async readCached(
    request: CacheRequest,
    mode: "offline" | "online",
    context: OperationContext,
    lookup: CacheLookup,
  ) {
    checkContext(context);
    const started = context.clock.now();
    const maxDurationMs = context.budget.maxDurationMs;
    const checkpoint = () => {
      checkContext(context);
      bound(
        "DURATION",
        Math.ceil(context.clock.now() - started),
        maxDurationMs,
      );
    };
    const access = await this.access(request.artifactRootId, context, "read");
    checkpoint();
    if (mode === "offline" && !access.offlineAllowed)
      fail(
        "OFFLINE_DENIED",
        "Retained bytes are not permitted for offline use",
      );
    const key = cacheIdentity({
      ...request,
      projectId: context.projectId,
      permissionScope: access.permissionScope,
      adapterVersion: ASSET_PROFILE.adapterVersion,
      schemaVersion: ASSET_PROFILE.schemaVersion,
    });
    const cached = await lookup(key);
    checkpoint();
    if (!cached)
      fail(
        "CACHE_MISSING",
        "No permitted cached asset; no implicit network retrieval",
      );
    if (
      cached.key !== key ||
      cached.projectId !== context.projectId ||
      cached.permissionScope !== access.permissionScope ||
      !validateContract("Artifact", cached.artifact).success
    )
      fail(
        "CACHE_SCOPE",
        "Cache record does not match the authorized identity",
      );
    bound(
      "INPUT_BYTES",
      cached.artifact.byteLength,
      context.budget.maxInputBytes,
    );
    bound(
      "OUTPUT_BYTES",
      cached.artifact.byteLength,
      context.budget.maxOutputBytes,
    );
    const current = await this.access(request.artifactRootId, context, "read");
    checkpoint();
    if (
      current.permissionScope !== access.permissionScope ||
      (mode === "offline" && !current.offlineAllowed)
    )
      fail("CACHE_SCOPE", "Permission changed during cache access");
    const result = await this.dependencies.filesystem.read(
      { artifactRootId: request.artifactRootId, path: cached.artifact.path },
      context,
    );
    if (result.status !== "complete")
      fail(
        "CACHE_READ",
        "Cached artifact is unavailable; no implicit refresh/fallback",
      );
    if (
      result.projectId !== context.projectId ||
      result.requestId !== context.requestId
    )
      fail("CACHE_SCOPE", "Filesystem response scope mismatch");
    checkpoint();
    inputLimit(result.value, context.budget);
    bound(
      "OUTPUT_BYTES",
      result.value.byteLength,
      context.budget.maxOutputBytes,
    );
    verifyBytes(result.value, cached.artifact);
    return {
      bytes: Buffer.from(result.value),
      artifact: structuredClone(cached.artifact),
      freshness:
        mode === "offline"
          ? ("unknown/offline" as const)
          : ("not-checked" as const),
    };
  }
}
