import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardResolution } from "./resolver.mjs";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
let browser;
let guard;
export async function render() {
  try {
    guard = guardResolution(
      JSON.parse(await readFile(path.join(root, "allowed-files.json"), "utf8")),
    );
    const { chromium } = await import("playwright");
    const koffi = require("koffi");
    const library = koffi.load("kernel32.dll");
    const current = library.func("uint32_t __stdcall GetCurrentProcessId()");
    const sqlite = { exports: {} };
    process.dlopen(sqlite, path.join(root, "better_sqlite3.node"));
    if (typeof sqlite.exports.Database !== "function")
      throw new Error("Pinned SQLite addon did not expose Database.");
    browser = await chromium.launch({
      executablePath: path.join(
        root,
        "browser",
        "chromium_headless_shell-1243",
        "chrome-headless-shell-win64",
        "chrome-headless-shell.exe",
      ),
      chromiumSandbox: true,
      headless: true,
      timeout: 15000,
      args: ["--enable-automation"],
    });
    const page = await browser.newPage({
      viewport: { width: 16, height: 16 },
      serviceWorkers: "block",
    });
    await page.route("**/*", (route) => route.abort("blockedbyclient"));
    await page.setContent(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>',
    );
    const png = await page.screenshot({ type: "png" });
    const cdp = await browser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
    return Buffer.from(
      JSON.stringify({
        node: process.version,
        koffi: current() === process.pid,
        sqlite: true,
        png: png.subarray(0, 8).toString("hex"),
        sandboxDisabled:
          args.includes("--no-sandbox") ||
          args.includes("--disable-setuid-sandbox"),
        pipe: args.includes("--remote-debugging-pipe"),
        debugPort: args.some((arg) =>
          arg.startsWith("--remote-debugging-port"),
        ),
      }),
    );
  } catch (error) {
    return Buffer.from(
      JSON.stringify({
        status: "probe-failed",
        message: error instanceof Error ? error.stack : String(error),
      }),
    );
  }
}
export async function close() {
  await browser?.close();
  guard?.close();
}
