import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorker } from "../../dist/worker.js";

const root = fileURLToPath(
  new URL("../../../../.tools/renderer-browser-1.63.0", import.meta.url),
);
const manifest = JSON.parse(
  await readFile(
    new URL("../../docs/browser-windows-x64.json", import.meta.url),
    "utf8",
  ),
);
const worker = createWorker({
  root,
  executable:
    "chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
  files: manifest.files,
});
export const render = worker.render;
export const close = worker.close;
