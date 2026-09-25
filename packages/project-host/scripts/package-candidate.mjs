import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_DIAGNOSTIC_POLICY_SHA256,
  captureDiagnosticPolicyBytes,
} from "../dist/capture-diagnostic-profile.js";
import {
  CAPTURE_POLICY_SHA256,
  CAPTURE_PROFILE,
  capturePolicyBytes,
} from "../dist/capture-profile.js";
import {
  CAPTURE_RECOVERY_POLICY_SHA256,
  captureRecoveryPolicyBytes,
} from "../dist/capture-recovery-profile.js";
import {
  CAPTURE_REFERENCE_POLICY_SHA256,
  captureReferencePolicyBytes,
} from "../dist/capture-reference-profile.js";
import {
  boundedFile,
  digest,
  encodeInventory,
  exactTree,
  INSTALL_LIMITS,
  relativeName,
} from "../dist/installation-manifest.js";
import {
  REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
  referenceConversionInspectionPolicyBytes,
} from "../dist/reference-conversion-inspection-profile.js";
import {
  REFERENCE_OFFLINE_POLICY_SHA256,
  referenceOfflinePolicyBytes,
} from "../dist/reference-offline-profile.js";
import {
  REFERENCE_VALIDATION_POLICY_SHA256,
  referenceValidationPolicyBytes,
} from "../dist/reference-validation-profile.js";

const bootstrapScripts = fileURLToPath(
  new URL("../bootstrap/", import.meta.url),
);
const requiredPackages = [
  "contracts",
  "design-ir",
  "assets",
  "host",
  "storage",
  "jobs",
  "renderer",
  "renderer-host",
  "project-host",
  "application",
  "cli",
];
const sqliteHash =
  "194c049b8781c3ca39f7e12b4f4a47c79027502b366151404ae8847fe6e2a9a1";
const runtimeFiles = Object.freeze([
  Object.freeze({
    path: "node.exe",
    bytes: 93580104,
    sha256: "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
  }),
  Object.freeze({
    path: "LICENSE",
    bytes: 160555,
    sha256: "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9",
  }),
]);
let copiedFiles = 0;
let copiedBytes = 0;
async function hashFile(filename, sourceLinks = false) {
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (!sourceLinks && stat.nlink !== 1) ||
      stat.size > INSTALL_LIMITS.fileBytes
    )
      throw new Error("Candidate source must be a bounded single-link file.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > INSTALL_LIMITS.fileBytes)
        throw new Error("Candidate source grew past bound.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      stat.ino !== after.ino ||
      stat.dev !== after.dev ||
      stat.size !== bytes ||
      stat.mtimeMs !== after.mtimeMs
    )
      throw new Error("Candidate source changed during inventory.");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
async function copyPhysical(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink())
    throw new Error(`Refusing nonphysical source entry ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination);
    for (const entry of await readdir(source)) {
      if (entry === "node_modules") continue;
      relativeName(entry);
      await copyPhysical(
        path.join(source, entry),
        path.join(destination, entry),
      );
    }
    if ((await readdir(destination)).length === 0) await rmdir(destination);
  } else {
    if (!stat.isFile())
      throw new Error("Unsupported source filesystem object.");
    const expected = await hashFile(source, true);
    copiedFiles++;
    copiedBytes += expected.bytes;
    if (
      copiedFiles > INSTALL_LIMITS.files ||
      copiedBytes > INSTALL_LIMITS.totalBytes
    )
      throw new Error("Candidate copy exceeds aggregate file/byte bounds.");
    await copyFile(source, destination, 1);
    const actual = await hashFile(destination);
    if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256)
      throw new Error("Candidate copy differs from observed source.");
  }
}
async function verifyRuntime(source) {
  if (
    !/^[A-Za-z]:\\/.test(source) ||
    path.resolve(source) !== source ||
    (await realpath(source)) !== source
  )
    throw new Error("Runtime source requires an exact physical local path.");
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Runtime source must be a physical directory.");
  for (const file of runtimeFiles) {
    const filename = path.join(source, file.path);
    const entry = await lstat(filename);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      (await realpath(filename)) !== filename
    )
      throw new Error(
        "Runtime files must be exact physical single-link paths.",
      );
    const actual = await hashFile(filename);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error("Unapproved pinned Node executable or license notice.");
  }
}
export async function copyRuntime(source, destination) {
  await verifyRuntime(source);
  await mkdir(destination);
  for (const file of runtimeFiles)
    await copyPhysical(
      path.join(source, file.path),
      path.join(destination, file.path),
    );
  // Revalidate the fixed pins after copying, not merely equality to mutable source bytes.
  await verifyRuntime(destination);
  await exactTree(destination, runtimeFiles);
}
export async function inventory(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeName(name);
      if (entry.isSymbolicLink())
        throw new Error("Candidate cannot contain symlinks.");
      if (entry.isDirectory())
        await visit(path.join(directory, entry.name), name);
      else
        files.push({
          path: name,
          ...(await hashFile(path.join(directory, entry.name))),
        });
      if (files.length > INSTALL_LIMITS.files)
        throw new Error("Candidate file count exceeds bound.");
    }
  };
  await visit(root, "");
  return encodeInventory(files);
}
function supports(values, actual) {
  return (
    !values ||
    (!values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith("!")) ||
        values.includes(actual)))
  );
}
function packageName(name) {
  if (
    typeof name !== "string" ||
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
    name === "node_modules" ||
    name === "favicon.ico"
  )
    throw new Error("Invalid canonical package name.");
  // npm spelling alone is insufficient for Windows reserved/trailing-dot aliases.
  try {
    relativeName(name);
  } catch (cause) {
    throw new Error("Invalid Windows-safe package name.", { cause });
  }
  return name;
}
function packageDestination(destination, name) {
  packageName(name);
  const root = path.resolve(destination);
  const target = path.resolve(root, ...name.split("/"));
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Package destination escaped the exact node_modules root.");
  return target;
}
async function packageManifest(directory, requestedName) {
  const manifest = JSON.parse(
    (
      await boundedFile(path.join(directory, "package.json"), 1024 * 1024)
    ).toString("utf8"),
  );
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Invalid package manifest.");
  packageName(manifest.name);
  if (
    requestedName !== undefined &&
    manifest.name !== packageName(requestedName)
  )
    throw new Error(
      "Requested package name differs from resolved manifest name.",
    );
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    )
      throw new Error("Invalid package dependency map.");
    for (const [name, version] of Object.entries(dependencies)) {
      packageName(name);
      if (typeof version !== "string")
        throw new Error("Invalid package dependency version.");
    }
  }
  return manifest;
}
export async function readBrowserInventory(filename) {
  const browserInventory = JSON.parse(
    (await boundedFile(filename, INSTALL_LIMITS.manifestBytes)).toString(
      "utf8",
    ),
  );
  if (
    !browserInventory ||
    typeof browserInventory !== "object" ||
    Array.isArray(browserInventory) ||
    browserInventory.playwright !== "1.63.0" ||
    !Array.isArray(browserInventory.files) ||
    browserInventory.files.length !== 299
  )
    throw new Error("Unreviewed browser inventory revision.");
  const files = browserInventory.files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof file.path !== "string" ||
      typeof file.byteLength !== "number" ||
      typeof file.sha256 !== "string"
    )
      throw new Error("Invalid browser inventory entry.");
    return {
      path: file.path,
      byteLength: file.byteLength,
      sha256: file.sha256,
    };
  });
  // Validate every path, identity, alias and aggregate bound before traversing any source path.
  encodeInventory(
    files.map((file) => ({
      path: file.path,
      bytes: file.byteLength,
      sha256: file.sha256,
    })),
  );
  return { playwright: browserInventory.playwright, files };
}
export async function physicalDependencies(workspace, roots, destination) {
  const packages = new Map();
  const workspacePackages = new Map();
  for (const entry of await readdir(path.join(workspace, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(workspace, "packages", entry.name);
    const manifest = await packageManifest(directory);
    if (workspacePackages.has(manifest.name))
      throw new Error("Duplicate workspace package name.");
    workspacePackages.set(manifest.name, directory);
  }
  const resolvePackage = async (parent, name) => {
    packageName(name);
    if (workspacePackages.has(name)) return workspacePackages.get(name);
    let current = parent;
    while (
      current === workspace ||
      current.startsWith(`${workspace}${path.sep}`)
    ) {
      const link = packageDestination(path.join(current, "node_modules"), name);
      try {
        return await realpath(link);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const next = path.dirname(current);
      if (next === current) break;
      current = next;
    }
    throw new Error(
      `Missing offline dependency ${name}; restore approved artifacts with scripts disabled first.`,
    );
  };
  const add = async (directory, requestedName) => {
    directory = await realpath(directory);
    if (!directory.startsWith(`${workspace}${path.sep}`))
      throw new Error(
        "Dependency source escaped explicit integrated workspace.",
      );
    const manifest = await packageManifest(directory, requestedName);
    if (!supports(manifest.os, "win32") || !supports(manifest.cpu, "x64"))
      return;
    const existing = packages.get(manifest.name);
    if (existing) {
      if (
        existing.version !== manifest.version ||
        existing.directory !== directory
      )
        throw new Error(
          `Flat physical release has conflicting resolutions for ${manifest.name}; explicit packaging support required.`,
        );
      return;
    }
    packages.set(manifest.name, { version: manifest.version, directory });
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(dependencies).sort()) {
      let dependency;
      try {
        dependency = await resolvePackage(directory, name);
      } catch (error) {
        // Only known foreign-platform optional packages can be omitted before resolution.
        if (
          manifest.optionalDependencies?.[name] &&
          /(?:darwin|linux|freebsd|android|openbsd|win32-arm64|win32-ia32)/.test(
            name,
          )
        )
          continue;
        throw error;
      }
      await add(dependency, name);
    }
  };
  for (const root of roots) await add(root);
  await mkdir(destination, { recursive: true });
  for (const [name, info] of packages) {
    const target = packageDestination(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (workspacePackages.has(name))
      await copyWorkspacePackage(info.directory, target, name);
    else await copyPhysical(info.directory, target);
  }
}
async function copyWorkspacePackage(source, target, name) {
  const manifest = await packageManifest(source, name);
  await mkdir(target);
  await copyPhysical(
    path.join(source, "package.json"),
    path.join(target, "package.json"),
  );
  // Workspace source/tests/build caches are not runtime closure. Compiled bytes and shipped data are.
  for (const entry of manifest.files ?? ["dist"]) {
    if (
      entry === "README.md" ||
      entry === "dist" ||
      entry === "schemas" ||
      entry === "generated" ||
      entry === "bootstrap"
    ) {
      await copyPhysical(path.join(source, entry), path.join(target, entry));
    }
  }
  if (name === "@design-studio/renderer-host") {
    await mkdir(path.join(target, "src"));
    await copyPhysical(
      path.join(source, "src", "bootstrap.mjs"),
      path.join(target, "src", "bootstrap.mjs"),
    );
  }
}
export async function packageCandidate({
  workspace,
  nodeRoot,
  browserRoot,
  sqliteBinding,
  output,
  profile = "fixture",
}) {
  copiedFiles = 0;
  copiedBytes = 0;
  if (!["fixture", CAPTURE_PROFILE].includes(profile))
    throw new Error("Unknown closed release profile.");
  const capture = profile === CAPTURE_PROFILE;
  const packages = capture
    ? [
        "contracts",
        "host",
        "project-host",
        "application",
        "cli",
        "figma-capture",
        "figma-import",
        "design-ir",
        "assets",
        "storage",
        "jobs",
      ]
    : requiredPackages;
  if (
    process.version !== "v24.21.0" ||
    process.platform !== "win32" ||
    process.arch !== "x64"
  )
    throw new Error(
      "Candidate tooling requires pinned Windows x64 Node 24.21.0.",
    );
  for (const item of capture
    ? [workspace, nodeRoot, sqliteBinding, output]
    : [workspace, nodeRoot, browserRoot, sqliteBinding, output])
    if (!path.isAbsolute(item))
      throw new Error(
        "Explicit local absolute candidate inputs/output required.",
      );
  workspace = await realpath(workspace);
  // Refuse before output allocation until the actual F08 integrated build exists.
  for (const name of packages) {
    await lstat(
      path.join(
        workspace,
        "packages",
        name,
        "dist",
        name === "cli" ? (capture ? "capture-main.js" : "main.js") : "index.js",
      ),
    );
  }
  await lstat(
    capture
      ? path.join(
          workspace,
          "packages",
          "project-host",
          "dist",
          "pat-dialog-helper.js",
        )
      : path.join(
          workspace,
          "packages",
          "application",
          "dist",
          "render-worker.js",
        ),
  );
  const browserInventory = capture
    ? undefined
    : await readBrowserInventory(
        path.join(
          workspace,
          "packages",
          "renderer",
          "docs",
          "browser-windows-x64.json",
        ),
      );
  if ((await hashFile(sqliteBinding)).sha256 !== sqliteHash)
    throw new Error("Unapproved SQLite addon.");
  await verifyRuntime(nodeRoot);
  if ((await hashFile(process.execPath)).sha256 !== runtimeFiles[0].sha256)
    throw new Error(
      "Candidate tooling must run with the explicitly trusted pinned Node bytes; never execute candidate source to inspect it.",
    );
  await mkdir(output);
  const payload = path.join(output, "payload");
  const bootstrap = path.join(output, "bootstrap");
  await mkdir(payload);
  await mkdir(bootstrap);
  await writeFile(path.join(payload, "package.json"), '{"type":"module"}', {
    flag: "wx",
  });
  await mkdir(path.join(payload, "packages"));
  for (const name of packages)
    await copyWorkspacePackage(
      path.join(workspace, "packages", name),
      path.join(payload, "packages", name),
      `@design-studio/${name}`,
    );
  await physicalDependencies(
    workspace,
    packages.map((name) => path.join(workspace, "packages", name)),
    path.join(payload, "node_modules"),
  );
  await mkdir(path.join(payload, "native"));
  await copyPhysical(
    sqliteBinding,
    path.join(payload, "native", "better_sqlite3.node"),
  );
  if (capture) {
    await writeFile(
      path.join(payload, "capture-policy.json"),
      capturePolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "capture-recovery-policy.json"),
      captureRecoveryPolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "capture-reference-policy.json"),
      captureReferencePolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "capture-diagnostic-policy.json"),
      captureDiagnosticPolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "reference-validation-policy.json"),
      referenceValidationPolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "reference-offline-policy.json"),
      referenceOfflinePolicyBytes(),
      { flag: "wx" },
    );
    await writeFile(
      path.join(payload, "reference-conversion-inspection-policy.json"),
      referenceConversionInspectionPolicyBytes(),
      { flag: "wx" },
    );
  } else {
    await mkdir(path.join(payload, "fixtures"));
    await copyPhysical(
      path.join(workspace, "tests", "fixtures", "foundation"),
      path.join(payload, "fixtures", "foundation"),
    );
    await mkdir(path.join(payload, "browser"));
    for (const file of browserInventory.files) {
      relativeName(file.path);
      const source = path.join(browserRoot, ...file.path.split("/"));
      const actual = await hashFile(source);
      if (actual.bytes !== file.byteLength || actual.sha256 !== file.sha256)
        throw new Error("Public browser inventory mismatch.");
      const target = path.join(payload, "browser", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyPhysical(source, target);
    }
  }
  await copyRuntime(nodeRoot, path.join(bootstrap, "runtime"));
  await physicalDependencies(
    workspace,
    [path.join(workspace, "packages", "project-host")],
    path.join(bootstrap, "node_modules"),
  );
  for (const script of ["install.mjs", "launch.mjs"])
    await copyPhysical(
      path.join(bootstrapScripts, script),
      path.join(bootstrap, script),
    );
  const moduleInventory = await inventory(path.join(bootstrap, "node_modules"));
  await writeFile(
    path.join(bootstrap, "bootstrap-modules.json"),
    moduleInventory,
    { flag: "wx" },
  );
  const preflight = (
    await readFile(path.join(bootstrapScripts, "preflight.mjs"), "utf8")
  ).replace(
    "__REVIEWED_BOOTSTRAP_MODULE_INVENTORY_SHA256__",
    digest(moduleInventory),
  );
  await writeFile(path.join(bootstrap, "preflight.mjs"), preflight, {
    flag: "wx",
  });
  const manifest = await inventory(payload);
  const catalogSha256 = capture
    ? undefined
    : (
        await hashFile(
          path.join(payload, "fixtures", "foundation", "manifest.json"),
        )
      ).sha256;
  await writeFile(
    path.join(bootstrap, "release-policy.json"),
    JSON.stringify(
      capture
        ? {
            version: 8,
            kind: CAPTURE_PROFILE,
            manifestSha256: digest(manifest),
            capturePolicySha256: CAPTURE_POLICY_SHA256,
            captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
            captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
            captureDiagnosticPolicySha256: CAPTURE_DIAGNOSTIC_POLICY_SHA256,
            referenceValidationPolicySha256: REFERENCE_VALIDATION_POLICY_SHA256,
            referenceOfflinePolicySha256: REFERENCE_OFFLINE_POLICY_SHA256,
            referenceConversionInspectionPolicySha256:
              REFERENCE_CONVERSION_INSPECTION_POLICY_SHA256,
          }
        : {
            version: 1,
            manifestSha256: digest(manifest),
            catalogSha256,
          },
    ),
    { flag: "wx" },
  );
  const bootstrapInventory = await inventory(bootstrap);
  await writeFile(path.join(output, "payload-inventory.json"), manifest, {
    flag: "wx",
  });
  await writeFile(
    path.join(output, "bootstrap-inventory.json"),
    bootstrapInventory,
    { flag: "wx" },
  );
  return {
    status: "candidate-awaiting-user-release-approval",
    manifestSha256: digest(manifest),
    bootstrapSha256: digest(bootstrapInventory),
    ...(capture
      ? {
          profile: CAPTURE_PROFILE,
          capturePolicySha256: CAPTURE_POLICY_SHA256,
          captureRecoveryPolicySha256: CAPTURE_RECOVERY_POLICY_SHA256,
          captureReferencePolicySha256: CAPTURE_REFERENCE_POLICY_SHA256,
        }
      : { catalogSha256 }),
    output,
    provenance:
      "Candidate inventory only. User must independently trust and approve exact bootstrap and payload release before running installation.",
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = [
    "--workspace",
    "--node-root",
    "--browser-root",
    "--sqlite-binding",
    "--output",
  ];
  const args = process.argv.slice(2);
  if (
    args.length === 10 &&
    args[0] === "--profile" &&
    args[1] === CAPTURE_PROFILE &&
    args[2] === "--workspace" &&
    args[4] === "--node-root" &&
    args[6] === "--sqlite-binding" &&
    args[8] === "--output"
  ) {
    process.stdout.write(
      `${JSON.stringify(
        await packageCandidate({
          profile: CAPTURE_PROFILE,
          workspace: args[3],
          nodeRoot: args[5],
          sqliteBinding: args[7],
          output: args[9],
        }),
        null,
        2,
      )}\n`,
    );
  } else {
    if (
      args.length !== 10 ||
      names.some((name, index) => args[index * 2] !== name)
    )
      throw new Error(
        "Usage: package-candidate.mjs --workspace <integrated build> --node-root <runtime> --browser-root <r1243> --sqlite-binding <ABI137> --output <NEW candidate>",
      );
    process.stdout.write(
      `${JSON.stringify(await packageCandidate({ workspace: args[1], nodeRoot: args[3], browserRoot: args[5], sqliteBinding: args[7], output: args[9] }), null, 2)}\n`,
    );
  }
}
