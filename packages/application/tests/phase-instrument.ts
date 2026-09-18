import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function replaceOnce(text: string, from: string, to: string) {
  if (text.split(from).length !== 2)
    throw new Error("Diagnostic copied-code pattern is not unique.");
  return text.replace(from, to);
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
  const index = path.join(host, "index.js");
  const indexText = await readFile(index, "utf8");
  if (indexText.includes("f08-diagnostics"))
    throw new Error("Copied diagnostic import already present.");
  await writeFile(index, `import "./f08-diagnostics.mjs";\n${indexText}`);
  const installation = path.join(host, "installation.js");
  const mark =
    'globalThis[Symbol.for("design-studio-owned-phase-test")]?.get(import.meta.url.includes("/bootstrap/") ? 1 : 2)';
  await writeFile(
    installation,
    replaceOnce(
      await readFile(installation, "utf8"),
      "return verifyInstalledRoot(bootstrapOrigin);",
      `${mark}?.("verify-start");\ntry { const result = await verifyInstalledRoot(bootstrapOrigin); ${mark}?.("verify-end"); return result; }\ncatch(error) { ${mark}?.("verify-failed"); throw error; }`,
    ),
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
