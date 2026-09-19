import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function replaceOnce(text: string, from: string, to: string) {
  if (text.split(from).length !== 2)
    throw new Error("Diagnostic copied-code pattern is not unique.");
  return text.replace(from, to);
}
function measureFunction(text: string, name: string, kind: string) {
  return replaceOnce(
    text,
    `function ${name}(`,
    `function ${name}(...args) { return nativeCapture.measure("${kind}", () => diagnostic_${name}(...args)); }\nfunction diagnostic_${name}(`,
  );
}
export async function instrumentCandidate(stage: string, directory: string) {
  const host = path.join(stage, "packages", "project-host", "dist");
  const helper = await readFile(
    new URL("./phase-capture.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(
    path.join(host, "f08-diagnostics.mjs"),
    replaceOnce(
      helper,
      '"__F08_DIAGNOSTIC_DIRECTORY__"',
      JSON.stringify(directory),
    ),
    { flag: "wx" },
  );
  await writeFile(
    path.join(host, "f08-native-timing.mjs"),
    await readFile(new URL("./phase-native.mjs", import.meta.url)),
    { flag: "wx" },
  );
  const nativePath = path.join(host, "native.js");
  let native = await readFile(nativePath, "utf8");
  for (const [name, kind] of [
    ["open", "open"],
    ["inspectHandle", "inspect"],
    ["checkAcl", "acl"],
    ["pin", "pin"],
  ] as const)
    native = measureFunction(native, name, kind);
  const timingImport =
    'import { nativeCapture } from "./f08-native-timing.mjs";\n';
  await writeFile(nativePath, timingImport + native);
  const installation = path.join(host, "installation.js");
  const mark =
    'globalThis[Symbol.for("design-studio-owned-phase-test")]?.get(import.meta.url.includes("/bootstrap/") ? 1 : 2)';
  let installed = replaceOnce(
    await readFile(installation, "utf8"),
    "export async function verifyFixtureInstallation() {\n    return verifyInstalledRoot(await verifiedBootstrapRoot());\n}",
    `export async function verifyFixtureInstallation() {\n${mark}?.("verify-start");\ntry { const result = await verifyInstalledRoot(await verifiedBootstrapRoot()); ${mark}?.("verify-end"); return result; }\ncatch(error) { ${mark}?.("verify-failed"); throw error; }\n}`,
  );
  installed = replaceOnce(
    installed,
    "export async function verifyInstalledRoot(root) {",
    "export async function verifyInstalledRoot(root) { const trace = traceInstallation(true); let success = false; try { const result = await diagnosticVerifyInstalledRoot(root, trace); success = true; return result; } finally { trace?.end(success); } }\nasync function diagnosticVerifyInstalledRoot(root, trace) {",
  );
  installed = replaceOnce(
    installed,
    'const lease = await verifyProfileRoot(root, "fixture");',
    'const lease = await verifyProfileRoot(root, "fixture", trace);',
  );
  installed = replaceOnce(
    installed,
    "async function verifyProfileRoot(root, profile) {",
    "async function verifyProfileRoot(root, profile, trace) {",
  );
  installed = replaceOnce(
    installed,
    "verified = await verifyTree(native, root, allFiles(meta), sid);",
    "verified = await verifyTree(native, root, allFiles(meta), sid, true, trace);",
  );
  installed = measureFunction(installed, "checkHash", "hash");
  await writeFile(
    installation,
    `import "./f08-diagnostics.mjs";\n${timingImport}${installed}`,
  );
  const app = path.join(
    stage,
    "packages",
    "application",
    "dist",
    "installed-project.js",
  );
  let text = await readFile(app, "utf8");
  const appMark =
    'globalThis[Symbol.for("design-studio-owned-phase-test")]?.get(2)';
  text = replaceOnce(
    text,
    "onJobEvent: (event) => {",
    `onJobEvent: (event) => {\nif (event.kind === "claimed") ${appMark}?.("claimed");`,
  );
  const pattern =
    /worker: \(authority\) => new RendererWorkerHost\(([\s\S]*?)\),/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.[1])
    throw new Error("Copied worker factory pattern not unique.");
  text = text.replace(
    pattern,
    (_whole, config: string) =>
      `worker: (authority) => { const worker = new RendererWorkerHost(${config}); return {open: async (context) => { ${appMark}?.("worker-open"); try { const result = await worker.open(context); ${appMark}?.(result.status === "complete" ? "worker-opened" : "worker-failed"); return result; } catch(error) { ${appMark}?.("worker-failed"); throw error; } }}; },`,
  );
  await writeFile(app, text);
}
