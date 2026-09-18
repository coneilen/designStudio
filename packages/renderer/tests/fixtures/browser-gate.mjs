import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const executable = fileURLToPath(
  new URL(
    "../../../../.tools/renderer-browser-1.63.0/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
    import.meta.url,
  ),
);
let browser;
export async function render(_bytes, { signal }) {
  const hash = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (
    hash !== "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c"
  )
    throw new Error("Browser executable identity mismatch");
  signal.throwIfAborted();
  try {
    browser = await chromium.launch({
      executablePath: executable,
      chromiumSandbox: true,
      headless: true,
      timeout: 15_000,
      args: ["--force-color-profile=srgb", "--enable-automation"],
    });
    signal.throwIfAborted();
    const page = await browser.newPage({
      viewport: { width: 16, height: 16 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      serviceWorkers: "block",
    });
    await page.route("**/*", (route) => route.abort("blockedbyclient"));
    await page.setContent(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>',
    );
    const cdp = await browser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
    const png = await page.screenshot({ type: "png", animations: "disabled" });
    if (_bytes[0] === 2) process.exit(17);
    return Buffer.from(
      JSON.stringify({
        version: browser.version(),
        sandboxDisabled: args.some(
          (arg) => arg === "--no-sandbox" || arg === "--disable-setuid-sandbox",
        ),
        pipe: args.includes("--remote-debugging-pipe"),
        debugPort: args.some((arg) =>
          arg.startsWith("--remote-debugging-port"),
        ),
        pngSignature: png.subarray(0, 8).toString("hex"),
      }),
    );
  } catch (error) {
    // Diagnostic-only gate: a failed launch is never a passing renderer response.
    return Buffer.from(
      JSON.stringify({
        status: "gate-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
export async function close() {
  await browser?.close();
}
