import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { generateOpenApi } from "../dist/openapi.js";

const destination = new URL("../generated/openapi.json", import.meta.url);
const browser = await readFile(
  new URL("../../renderer/docs/browser-windows-x64.json", import.meta.url),
);
const browserDestination = new URL(
  "../generated/browser-inventory.json",
  import.meta.url,
);
const format = spawnSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome"),
    "format",
    "--stdin-file-path=openapi.generated.json",
  ],
  { input: JSON.stringify(generateOpenApi()), maxBuffer: 2 * 1024 * 1024 },
);
if (format.status !== 0) throw new Error("Pinned OpenAPI formatter failed.");
const bytes = format.stdout;
if (process.argv.includes("--check")) {
  if (!(await readFile(destination)).equals(bytes))
    throw new Error("OpenAPI output drifted.");
  if (!(await readFile(browserDestination)).equals(browser))
    throw new Error("Browser inventory drifted.");
} else {
  await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
  await writeFile(destination, bytes);
  await writeFile(browserDestination, browser);
}
