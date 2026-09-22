import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostBoundaryError } from "@design-studio/host";
import { CAPTURE_POLICY_SHA256, CAPTURE_PROFILE } from "./capture-profile.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "./capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "./capture-reference-profile.js";
import {
  type InstallationTrace,
  traceInstallation,
} from "./installation-diagnostics.js";
import {
  boundedFile,
  decodeInventory,
  digest,
  encodeInventory,
  exactTree,
  INSTALL_LIMITS,
  type InventoryFile,
  physical,
} from "./installation-manifest.js";
import { guardResolution } from "./installation-resolver.js";
import {
  type Identity,
  type InstallationEntry,
  type Lease,
  loadNative,
  type Native,
  type ReadLease,
  refuse,
} from "./native.js";

export interface FixtureInstallationPaths {
  readonly node: string;
  readonly bootstrapEntry: string;
  readonly cliEntry: string;
  readonly rendererEntry: string;
  readonly fixtureCatalogRoot: string;
  readonly browserRoot: string;
  readonly sqliteBinding: string;
}
export interface FixtureInstallationLease {
  readonly paths: FixtureInstallationPaths;
  readonly identity: string;
  recheck(): Promise<void>;
  checkCurrent(): Promise<void>;
  close(): Promise<void>;
}
export interface CaptureInstallationPaths {
  readonly node: string;
  readonly bootstrapEntry: string;
  readonly cliEntry: string;
  readonly dialogEntry: string;
  readonly sqliteBinding: string;
}
export interface CaptureInstallationLease {
  readonly paths: CaptureInstallationPaths;
  readonly identity: string;
  readonly profile: typeof CAPTURE_PROFILE;
  recheck(): Promise<void>;
  checkCurrent(): Promise<void>;
  close(): Promise<void>;
}
type InstallationLease = FixtureInstallationLease | CaptureInstallationLease;
interface FixtureReleasePolicy {
  version: 1;
  manifestSha256: string;
  catalogSha256: string;
}
interface CaptureReleasePolicy {
  version: 2 | 3 | 4;
  kind: typeof CAPTURE_PROFILE;
  manifestSha256: string;
  capturePolicySha256: string;
  captureRecoveryPolicySha256?: string;
  captureReferencePolicySha256?: string;
}
type ReleasePolicy = FixtureReleasePolicy | CaptureReleasePolicy;
interface Metadata {
  policy: ReleasePolicy;
  manifest: Buffer;
  bootstrapInventory: Buffer;
  files: readonly InventoryFile[];
  bootstrapFiles: readonly InventoryFile[];
  identity: string;
}
interface Receipt {
  version: 1;
  sid: string;
  child: string;
  identity: string;
  root: Identity;
}
interface Verified {
  readonly files: readonly string[];
  readonly leases: ReadLease[];
  readonly identities: readonly Identity[];
}
const active = new WeakMap<
  InstallationLease,
  {
    files: readonly string[];
    root: string;
    live: boolean;
    guards: number;
    profile: "fixture" | typeof CAPTURE_PROFILE;
    recovery: boolean;
    reference: boolean;
  }
>();
let bootstrapOrigin: string | undefined;
const same = (a: Identity, b: Identity) =>
  a.path === b.path && a.file === b.file && a.volume === b.volume;

function release(leases: readonly Lease[]): void {
  const errors: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Installation native handle release failed.",
      { cause: errors[0] },
    );
}
async function rollbackError(
  error: unknown,
  leases: readonly Lease[],
): Promise<never> {
  try {
    release(leases);
  } catch (cleanup) {
    throw new AggregateError(
      [error, cleanup],
      "Installation verification and release failed.",
      { cause: error },
    );
  }
  throw error;
}
async function withLeases<T>(
  leases: readonly Lease[],
  operation: () => Promise<T>,
  trace?: InstallationTrace,
): Promise<T> {
  let value: T;
  try {
    value = await operation();
  } catch (error) {
    return rollbackError(error, leases);
  }
  const started = trace?.time() ?? 0;
  release(leases);
  trace?.phase("release", started, leases.length);
  return value;
}
export function decodeReleasePolicy(policyBytes: Buffer): ReleasePolicy {
  if (policyBytes.length > 1024)
    refuse("Trusted bootstrap policy exceeds its bound.");
  const policy: ReleasePolicy = JSON.parse(policyBytes.toString("utf8"));
  if (
    ![1, 2, 3, 4].includes(policy?.version) ||
    !/^[a-f0-9]{64}$/.test(policy.manifestSha256) ||
    (policy.version === 1
      ? !/^[a-f0-9]{64}$/.test(policy.catalogSha256)
      : policy.kind !== CAPTURE_PROFILE ||
        policy.capturePolicySha256 !== CAPTURE_POLICY_SHA256) ||
    ((policy.version === 3 || policy.version === 4) &&
      policy.captureRecoveryPolicySha256 !== CAPTURE_RECOVERY_POLICY_SHA256) ||
    (policy.version === 4 &&
      policy.captureReferencePolicySha256 !==
        CAPTURE_REFERENCE_POLICY_SHA256) ||
    !policyBytes.equals(
      Buffer.from(
        JSON.stringify(
          policy.version === 1
            ? {
                version: 1,
                manifestSha256: policy.manifestSha256,
                catalogSha256: policy.catalogSha256,
              }
            : {
                version: policy.version,
                kind: CAPTURE_PROFILE,
                manifestSha256: policy.manifestSha256,
                capturePolicySha256: policy.capturePolicySha256,
                ...(policy.version === 3 || policy.version === 4
                  ? {
                      captureRecoveryPolicySha256:
                        CAPTURE_RECOVERY_POLICY_SHA256,
                    }
                  : {}),
                ...(policy.version === 4
                  ? {
                      captureReferencePolicySha256:
                        CAPTURE_REFERENCE_POLICY_SHA256,
                    }
                  : {}),
              },
        ),
      ),
    )
  )
    refuse("Invalid trusted bootstrap release policy.");
  return policy;
}
async function metadata(root: string): Promise<Metadata> {
  const policy = decodeReleasePolicy(
    await boundedFile(
      path.join(root, "bootstrap", "release-policy.json"),
      1024,
    ),
  );
  const manifest = await boundedFile(
    path.join(root, "payload-inventory.json"),
    INSTALL_LIMITS.manifestBytes,
  );
  if (digest(manifest) !== policy.manifestSha256)
    refuse("Payload inventory differs from trusted bootstrap policy.");
  const bootstrapInventory = await boundedFile(
    path.join(root, "bootstrap-inventory.json"),
    INSTALL_LIMITS.manifestBytes,
  );
  return {
    policy,
    manifest,
    bootstrapInventory,
    files: decodeInventory(manifest),
    bootstrapFiles: decodeInventory(bootstrapInventory),
    identity: digest(Buffer.concat([manifest, bootstrapInventory])),
  };
}
function allFiles(meta: Metadata): readonly InventoryFile[] {
  const files = [
    ...meta.files.map((file) => ({ ...file, path: `payload/${file.path}` })),
    ...meta.bootstrapFiles.map((file) => ({
      ...file,
      path: `bootstrap/${file.path}`,
    })),
    {
      path: "payload-inventory.json",
      bytes: meta.manifest.length,
      sha256: digest(meta.manifest),
    },
    {
      path: "bootstrap-inventory.json",
      bytes: meta.bootstrapInventory.length,
      sha256: digest(meta.bootstrapInventory),
    },
  ];
  encodeInventory(files);
  return files;
}
function checkHash(lease: ReadLease, expected: InventoryFile): void {
  const buffer = Buffer.alloc(1024 * 1024);
  const hash = createHash("sha256");
  let total = 0;
  for (;;) {
    const count = lease.read(buffer);
    if (!count) break;
    total += count;
    if (total > expected.bytes)
      refuse("Installation file exceeds manifest byte length.");
    hash.update(buffer.subarray(0, count));
  }
  if (total !== expected.bytes || hash.digest("hex") !== expected.sha256)
    refuse("Installation file bytes differ from the reviewed release.");
}
async function verifyTree(
  native: Native,
  root: string,
  files: readonly InventoryFile[],
  sid?: string,
  hashBytes = true,
  trace?: InstallationTrace,
): Promise<Verified> {
  const leases: ReadLease[] = [];
  try {
    // Pin the root before enumerating; retained handles are not a hostile-owner namespace sandbox.
    let started = trace?.time() ?? 0;
    leases.push(
      sid
        ? native.pinInstallation(root, true, sid)
        : native.pinRead(root, true),
    );
    trace?.phase("root-pin", started, 1);
    started = trace?.time() ?? 0;
    const directories = await exactTree(root, files);
    trace?.phase("enumeration", started, directories.length + files.length);
    started = trace?.time() ?? 0;
    for (const directory of directories.slice(1)) {
      const relative = path.relative(root, directory);
      const browser =
        relative === path.join("payload", "browser") ||
        relative.startsWith(`payload${path.sep}browser${path.sep}`);
      leases.push(
        sid
          ? native.pinInstallation(directory, true, sid, browser)
          : native.pinRead(directory, true),
      );
    }
    trace?.phase("directory-pins", started, directories.length - 1);
    started = trace?.time() ?? 0;
    for (const file of files) {
      const filename = physical(root, file.path);
      const lease = sid
        ? native.pinInstallation(
            filename,
            false,
            sid,
            file.path.startsWith("payload/browser/"),
          )
        : native.pinRead(filename, false);
      leases.push(lease);
      if (lease.byteLength !== file.bytes)
        refuse("Installation file length differs from the reviewed release.");
      if (hashBytes) checkHash(lease, file);
    }
    trace?.phase("file-pins", started, files.length);
    return {
      files: files.map((file) => physical(root, file.path)),
      leases,
      identities: leases.map((lease) => lease.identity),
    };
  } catch (error) {
    return rollbackError(error, leases);
  }
}
function paths(root: string): FixtureInstallationPaths {
  return Object.freeze({
    node: path.join(root, "bootstrap", "runtime", "node.exe"),
    bootstrapEntry: path.join(root, "bootstrap", "launch.mjs"),
    cliEntry: path.join(root, "payload", "packages", "cli", "dist", "main.js"),
    rendererEntry: path.join(
      root,
      "payload",
      "packages",
      "application",
      "dist",
      "render-worker.js",
    ),
    fixtureCatalogRoot: path.join(root, "payload", "fixtures", "foundation"),
    browserRoot: path.join(root, "payload", "browser"),
    sqliteBinding: path.join(root, "payload", "native", "better_sqlite3.node"),
  });
}
function capturePaths(root: string): CaptureInstallationPaths {
  return Object.freeze({
    node: path.join(root, "bootstrap", "runtime", "node.exe"),
    bootstrapEntry: path.join(root, "bootstrap", "launch.mjs"),
    cliEntry: path.join(
      root,
      "payload",
      "packages",
      "cli",
      "dist",
      "capture-main.js",
    ),
    dialogEntry: path.join(
      root,
      "payload",
      "packages",
      "project-host",
      "dist",
      "pat-dialog-helper.js",
    ),
    sqliteBinding: path.join(root, "payload", "native", "better_sqlite3.node"),
  });
}
function required(meta: Metadata): void {
  const files = new Map(meta.files.map((file) => [file.path, file]));
  for (const name of meta.policy.version === 1
    ? [
        "packages/cli/dist/main.js",
        "packages/application/dist/render-worker.js",
        "node_modules/@design-studio/project-host/dist/index.js",
        "native/better_sqlite3.node",
        "browser/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
      ]
    : [
        "packages/cli/dist/capture-main.js",
        "packages/project-host/dist/pat-dialog-helper.js",
        "native/better_sqlite3.node",
        "node_modules/@design-studio/figma-capture/dist/index.js",
        "node_modules/@design-studio/figma-import/dist/index.js",
        "node_modules/@design-studio/project-host/dist/index.js",
        "capture-policy.json",
      ])
    if (!files.has(name))
      refuse(`Release is missing required installed role ${name}.`);
  if (
    meta.policy.version === 1 &&
    files.get("fixtures/foundation/manifest.json")?.sha256 !==
      meta.policy.catalogSha256
  )
    refuse("Release fixture catalog differs from trusted bootstrap policy.");
  if (
    meta.policy.version !== 1 &&
    files.get("capture-policy.json")?.sha256 !== CAPTURE_POLICY_SHA256
  )
    refuse("Release capture policy differs from the closed native profile.");
  if (
    (meta.policy.version === 3 || meta.policy.version === 4) &&
    files.get("capture-recovery-policy.json")?.sha256 !==
      CAPTURE_RECOVERY_POLICY_SHA256
  )
    refuse(
      "Release recovery supplement differs from the closed native profile.",
    );
  if (
    meta.policy.version === 4 &&
    files.get("capture-reference-policy.json")?.sha256 !==
      CAPTURE_REFERENCE_POLICY_SHA256
  )
    refuse(
      "Release reference supplement differs from the closed native profile.",
    );
  const bootstrapFiles = new Set(meta.bootstrapFiles.map((file) => file.path));
  for (const name of [
    "runtime/node.exe",
    "launch.mjs",
    "install.mjs",
    "release-policy.json",
    "node_modules/@design-studio/project-host/dist/installation.js",
  ])
    if (!bootstrapFiles.has(name))
      refuse(`Release is missing trusted bootstrap role ${name}.`);
}
async function namespace(
  native: Native,
  sid: string,
  create: boolean,
  profile: "fixture" | typeof CAPTURE_PROFILE = "fixture",
): Promise<{ root: string; leases: Lease[] }> {
  const folder = native.localAppData();
  const parsed = path.win32.parse(folder);
  if (
    !/^[A-Za-z]:\\$/.test(parsed.root) ||
    folder.split("\\").length > 32 ||
    folder.length > 200
  )
    refuse("Installation KnownFolder is outside supported local path bounds.");
  const leases: Lease[] = [];
  let root = parsed.root;
  try {
    leases.push(native.inspect(root, true));
    for (const part of folder
      .slice(parsed.root.length)
      .split("\\")
      .filter(Boolean)) {
      root = path.join(root, part);
      leases.push(native.inspect(root, true));
    }
    for (const part of [
      "DesignStudio",
      profile === "fixture" ? "installations" : "capture-releases",
    ]) {
      root = path.join(root, part);
      if (create) {
        try {
          native.createDirectory(root, sid);
        } catch (error) {
          if (
            !(error instanceof HostBoundaryError) ||
            error.code !== "CONFLICT"
          )
            throw error;
        }
      }
      leases.push(native.inspect(root, true, sid));
    }
    return { root, leases };
  } catch (error) {
    return rollbackError(error, leases);
  }
}

/** Trusted bootstrap only; never exported through the package public entrypoint. */
export function establishBootstrapOrigin(root: string): void {
  root = path.resolve(root);
  if (bootstrapOrigin !== undefined && bootstrapOrigin !== root)
    refuse("Bootstrap origin cannot change in a process.");
  if (
    !path.isAbsolute(root) ||
    process.execPath.toLowerCase() !== paths(root).node.toLowerCase() ||
    process.version !== "v24.21.0" ||
    process.execArgv.length !== 0 ||
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    Object.keys(process.env).some(
      (key) => /^(NODE_OPTIONS|NODE_PATH)$/i.test(key) && process.env[key],
    )
  )
    refuse(
      "Launch with the explicitly trusted pinned bootstrap; runtime injection is forbidden.",
    );
  bootstrapOrigin = root;
}

/** The local offline installer invokes this only after the user selects BOTH release identities. */
export async function installCandidate(
  root: string,
  approvedManifest: string,
  approvedBootstrap: string,
): Promise<string> {
  if (!path.isAbsolute(root))
    refuse("Candidate root must be an explicit local absolute path.");
  root = path.resolve(root);
  const meta = await metadata(root);
  required(meta);
  if (
    approvedManifest !== digest(meta.manifest) ||
    approvedBootstrap !== digest(meta.bootstrapInventory)
  )
    refuse(
      "Both exact user-selected release identities must match. Hashes alone do not establish review/provenance.",
    );
  const native = await loadNative();
  const sid = native.principal();
  const source = await verifyTree(native, root, allFiles(meta));
  const held: Lease[] = [...source.leases];
  const entries: InstallationEntry[] = [];
  return withLeases(held, async () => {
    const parent = await namespace(
      native,
      sid,
      true,
      meta.policy.version === 1 ? "fixture" : CAPTURE_PROFILE,
    );
    held.push(...parent.leases);
    const reservation = path.join(
      parent.root,
      Buffer.from(meta.identity, "hex").toString("base64url"),
    );
    native.createDirectory(reservation, sid);
    held.push(native.inspect(reservation, true, sid));
    const child = randomUUID();
    const target = path.join(reservation, child);
    const directories = await exactTree(root, allFiles(meta));
    for (const directory of directories) {
      const destination = path.join(target, path.relative(root, directory));
      const entry = native.createInstallationEntry(destination, true, sid);
      entries.push(entry);
      held.push(entry);
    }
    const buffer = Buffer.alloc(1024 * 1024);
    for (const file of allFiles(meta)) {
      const output = native.createInstallationEntry(
        physical(target, file.path),
        false,
        sid,
      );
      entries.push(output);
      held.push(output);
      const input = native.pinRead(physical(root, file.path), false);
      held.push(input);
      await withLeases([input, output], async () => {
        const hash = createHash("sha256");
        let total = 0;
        for (;;) {
          const count = input.read(buffer);
          if (!count) break;
          total += count;
          if (total > file.bytes) refuse("Candidate changed while copying.");
          hash.update(buffer.subarray(0, count));
          output.write(buffer.subarray(0, count));
        }
        if (total !== file.bytes || hash.digest("hex") !== file.sha256)
          refuse("Candidate changed while copying.");
        output.finalize(file.path.startsWith("payload/browser/"));
      });
    }
    for (const entry of [...entries].reverse()) {
      if (
        directories.some(
          (directory) =>
            path.join(target, path.relative(root, directory)) ===
            entry.identity.path,
        )
      ) {
        const relative = path.relative(target, entry.identity.path);
        entry.finalize(
          relative === path.join("payload", "browser") ||
            relative.startsWith(`payload${path.sep}browser${path.sep}`),
        );
      }
      entry.close();
    }
    const checked = await verifyTree(native, target, allFiles(meta), sid);
    await withLeases(checked.leases, async () => {
      const rootIdentity = checked.identities[0];
      if (!rootIdentity) refuse("Installation root verification missing.");
      const receipt: Receipt = {
        version: 1,
        sid,
        child,
        identity: meta.identity,
        root: rootIdentity,
      };
      native.createFile(
        path.join(reservation, `${randomUUID()}.pending`),
        sid,
        Buffer.from(JSON.stringify(receipt)),
        path.join(reservation, "registration.json"),
      );
    });
    return paths(target).bootstrapEntry;
  });
}

async function verifiedBootstrapRoot(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new HostBoundaryError(
      "UNSUPPORTED_HOST",
      "Offline fixture installation currently supports only Windows x64.",
      true,
    );
  if (!bootstrapOrigin) {
    const ownFile = fileURLToPath(import.meta.url);
    for (const area of ["bootstrap", "payload"]) {
      const suffix = path.join(
        area,
        "node_modules",
        "@design-studio",
        "project-host",
        "dist",
        "installation.js",
      );
      if (ownFile.endsWith(`${path.sep}${suffix}`))
        establishBootstrapOrigin(ownFile.slice(0, -suffix.length - 1));
    }
  }
  if (!bootstrapOrigin)
    refuse(
      "ACTION_REQUIRED: no user-approved offline release has established this bootstrap. Never approve current-worktree hashes implicitly.",
    );
  return bootstrapOrigin;
}
export async function verifyFixtureInstallation(): Promise<FixtureInstallationLease> {
  return verifyInstalledRoot(await verifiedBootstrapRoot());
}
export async function verifyCaptureInstallation(): Promise<CaptureInstallationLease> {
  return verifyCaptureInstalledRoot(await verifiedBootstrapRoot());
}

/** Internal verification engine; the public API establishes the trusted bootstrap origin first. */
export async function verifyInstalledRoot(
  root: string,
): Promise<FixtureInstallationLease> {
  const lease = await verifyProfileRoot(root, "fixture");
  if ("profile" in lease)
    refuse("Capture profile cannot authorize fixture roles.");
  return lease;
}
export async function verifyCaptureInstalledRoot(
  root: string,
): Promise<CaptureInstallationLease> {
  const lease = await verifyProfileRoot(root, CAPTURE_PROFILE);
  if (!("profile" in lease))
    refuse("Fixture profile cannot authorize capture roles.");
  return lease;
}
async function verifyProfileRoot(
  root: string,
  profile: "fixture" | typeof CAPTURE_PROFILE,
): Promise<InstallationLease> {
  root = path.resolve(root);
  const meta = await metadata(root);
  required(meta);
  if ((meta.policy.version === 1 ? "fixture" : CAPTURE_PROFILE) !== profile)
    refuse("Installed release profile does not authorize the requested role.");
  const native = await loadNative();
  const sid = native.principal();
  const parent = await namespace(native, sid, false, profile);
  const reservation = path.join(
    parent.root,
    Buffer.from(meta.identity, "hex").toString("base64url"),
  );
  let verified: Verified | undefined;
  try {
    parent.leases.push(native.inspect(reservation, true, sid));
    const receiptPath = path.join(reservation, "registration.json");
    parent.leases.push(native.inspect(receiptPath, false, sid));
    const receiptBytes = await boundedFile(receiptPath, 4096);
    const receipt: Receipt = JSON.parse(receiptBytes.toString());
    if (
      receipt?.version !== 1 ||
      receipt.sid !== sid ||
      receipt.identity !== meta.identity ||
      typeof receipt.child !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        receipt.child,
      ) ||
      path.join(reservation, receipt.child) !== root
    )
      refuse(
        "Installation registration differs from current native principal/approved bootstrap.",
      );
    if (
      !receiptBytes.equals(
        Buffer.from(
          JSON.stringify({
            version: 1,
            sid,
            child: receipt.child,
            identity: meta.identity,
            root: receipt.root,
          }),
        ),
      )
    )
      refuse("Installation registration is noncanonical.");
    verified = await verifyTree(native, root, allFiles(meta), sid);
    if (
      !verified.identities[0] ||
      !receipt.root ||
      !same(verified.identities[0], receipt.root)
    )
      refuse("Registered installation root identity changed.");
    if (native.principal() !== sid)
      refuse("Native principal changed during installation verification.");
    const held = verified;
    let closed = false;
    let closing = false;
    const state = {
      files: held.files,
      root,
      live: true,
      guards: 0,
      profile,
      recovery: meta.policy.version === 3 || meta.policy.version === 4,
      reference: meta.policy.version === 4,
    };
    const checkpoint = async (hashBytes: boolean): Promise<void> => {
      const trace = traceInstallation(hashBytes);
      let success = false;
      try {
        let started = trace?.time() ?? 0;
        if (closed || closing || native.principal() !== sid)
          refuse("Installation lease is closed or principal changed.");
        const files = allFiles(meta);
        trace?.phase("prepare", started, files.length);
        const checked = await verifyTree(
          native,
          root,
          files,
          sid,
          hashBytes,
          trace,
        );
        await withLeases(
          checked.leases,
          async () => {
            started = trace?.time() ?? 0;
            if (
              checked.identities.length !== held.identities.length ||
              checked.identities.some(
                (identity, index) =>
                  !held.identities[index] ||
                  !same(identity, held.identities[index]),
              )
            )
              refuse("Installation identity/registration changed.");
            trace?.phase("identity", started, checked.identities.length);
            started = trace?.time() ?? 0;
            const currentReceipt = await boundedFile(receiptPath, 4096);
            if (!currentReceipt.equals(receiptBytes))
              refuse("Installation identity/registration changed.");
            trace?.phase("registration", started, currentReceipt.length);
            started = trace?.time() ?? 0;
            for (const ancestor of parent.leases) {
              const check = native.inspect(
                ancestor.identity.path,
                ancestor.identity.path !== receiptPath,
                ancestor.identity.path.startsWith(
                  path.join(native.localAppData(), "DesignStudio"),
                )
                  ? sid
                  : undefined,
              );
              await withLeases([check], async () => {
                if (!same(check.identity, ancestor.identity))
                  refuse("Installation ancestor changed.");
              });
            }
            if (closed || closing)
              refuse("Installation lease closed during recheck.");
            if (native.principal() !== sid)
              refuse("Native principal changed during installation recheck.");
            trace?.phase("ancestors", started, parent.leases.length);
          },
          trace,
        );
        success = true;
      } finally {
        trace?.end(success);
      }
    };
    const lifecycle = {
      identity: meta.identity,
      recheck: () => checkpoint(true),
      checkCurrent: () => checkpoint(false),
      async close() {
        if (closed) return;
        if (state.guards)
          refuse(
            "Close installation guards only after actual worker/job quiescence, before releasing the installation lease.",
          );
        closing = true;
        state.live = false;
        release([...parent.leases, ...held.leases]);
        closed = true;
      },
    };
    const lease: InstallationLease = Object.freeze(
      profile === "fixture"
        ? { ...lifecycle, paths: paths(root) }
        : { ...lifecycle, paths: capturePaths(root), profile: CAPTURE_PROFILE },
    );
    active.set(lease, state);
    return lease;
  } catch (error) {
    return rollbackError(error, [
      ...parent.leases,
      ...(verified?.leases ?? []),
    ]);
  }
}

export function registerFixtureInstallationGuards(
  lease: FixtureInstallationLease,
): { close(): void } {
  if (active.get(lease)?.profile !== "fixture")
    refuse(
      "Fixture guards require this process's live native-verified fixture installation lease.",
    );
  return registerGuards(lease);
}
export function registerCaptureInstallationGuards(
  lease: CaptureInstallationLease,
): { close(): void } {
  assertCaptureInstallation(lease);
  return registerGuards(lease);
}
/** Internal lifetime admission; JSON or fixture leases never establish capture authority. */
export function assertCaptureInstallation(
  lease: CaptureInstallationLease,
): void {
  const state = active.get(lease);
  if (!state?.live || state.profile !== CAPTURE_PROFILE)
    refuse(
      "Capture operation requires this process's live verified capture installation.",
    );
}
export function retainCaptureInstallation(
  lease: CaptureInstallationLease,
): () => void {
  assertCaptureInstallation(lease);
  const state = active.get(lease);
  if (!state) refuse("Capture installation missing.");
  state.guards++;
  let closed = false;
  return () => {
    if (!closed) {
      state.guards--;
      closed = true;
    }
  };
}
export function assertCaptureRecoveryInstallation(
  lease: CaptureInstallationLease,
): void {
  assertCaptureInstallation(lease);
  if (!active.get(lease)?.recovery)
    refuse("This installed release does not authorize capture recovery.");
}
export function assertCaptureReferenceInstallation(
  lease: CaptureInstallationLease,
): void {
  assertCaptureInstallation(lease);
  if (!active.get(lease)?.reference)
    refuse("This installed release does not authorize reference acquisition.");
}
function registerGuards(lease: InstallationLease): { close(): void } {
  const state = active.get(lease);
  if (!state?.live)
    refuse(
      "Module guards require this process's live native-verified installation lease.",
    );
  const guard = guardResolution(
    state.files,
    ["bootstrap", "payload"].map((area) => ({
      scope: path.join(state.root, area),
      modules: path.join(state.root, area, "node_modules"),
    })),
  );
  state.guards++;
  let closed = false;
  return Object.freeze({
    close() {
      if (!closed) {
        guard.close();
        state.guards--;
        closed = true;
      }
    },
  });
}
