/// <reference lib="dom" />
import { lstat, readFile, realpath } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import {
  ASSET_PROFILE,
  decodeRaster,
  inspectFont,
  sanitizeSvg,
} from "@design-studio/assets";
import {
  type BoundsMap,
  type Budget,
  DEFAULT_BUDGETS,
  type DesignIR,
  type ErrorCode,
  type RenderProfile,
  validateContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import { HostBoundaryError } from "@design-studio/host";
import type { TrustedRendererImplementation } from "@design-studio/renderer-host";
import { type Browser, chromium, type Page } from "playwright";
import {
  compileDocument,
  fontStyles,
  shell,
  textMarkup,
  typography,
} from "./document.js";
import {
  compose,
  IDENTITY,
  type Matrix,
  mapRect,
  multiply,
} from "./geometry.js";
import {
  children,
  type LayoutResult,
  layoutDesign,
  scalar,
  type TextMeasurement,
} from "./layout.js";
import { installedBuildIdentity } from "./profile.js";
import type { PreparedFont, PreparedImage } from "./resources.js";
import { decodeEnvelope, logicalBytes } from "./wire.js";

export interface BrowserInstallation {
  root: string;
  executable: string;
  files: { path: string; byteLength: number; sha256: string }[];
}
export interface RenderWire {
  version: 1;
  design: DesignIR;
  profile: RenderProfile;
  mode: "strict" | "inspection";
  budget: Budget;
  fonts: PreparedFont[];
  images: PreparedImage[];
  telemetry?: boolean;
}
export interface FaceUse {
  nodeId: string;
  fontId: string;
  fontSha256: string;
  family: string;
  custom: boolean;
  glyphs: number;
}
export type CaptureReply =
  | {
      ok: true;
      png: string;
      nodes: BoundsMap["nodes"];
      fonts: FaceUse[];
      overflow: string[];
      textExcess: LayoutResult["textExcess"];
      profile: RenderProfile;
      telemetry?: {
        workerMs: number;
        browserStartupMs: number;
        workerPid: number;
        workerRss: number;
        processes: { id: number; type: string; cpuTime: number }[];
      };
    }
  | { ok: false; code: ErrorCode; message: string };
function object(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function decodeWire(bytes: Uint8Array, limits: Readonly<Budget>): RenderWire {
  const x = decodeEnvelope(bytes, limits.maxInputBytes);
  if (
    !object(x) ||
    x.version !== 1 ||
    (x.mode !== "strict" && x.mode !== "inspection") ||
    !Array.isArray(x.fonts) ||
    !Array.isArray(x.images)
  )
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid renderer wire envelope.",
    );
  const design = validateContract("DesignIR", x.design);
  const profile = validateContract("RenderProfile", x.profile);
  const budget = validateContract("Budget", x.budget);
  if (!design.success || !profile.success || !budget.success)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid renderer wire artifacts.",
    );
  const admittedBudget = budget.value;
  for (const key of Object.keys(limits) as (keyof Budget)[])
    if (
      !Number.isSafeInteger(budget.value[key]) ||
      budget.value[key] > limits[key]
    )
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Wire budgets exceed installed trusted limits.",
      );
  if (x.fonts.length + x.images.length > budget.value.maxExpandedNodes)
    throw new HostBoundaryError("ASSET_LIMIT", "Too many wire resources.");
  const fonts = x.fonts.map((f: unknown): PreparedFont => {
    if (
      !object(f) ||
      typeof f.id !== "string" ||
      typeof f.bytes !== "string" ||
      !object(f.face)
    )
      throw new HostBoundaryError("INVALID_INPUT", "Invalid wire font.");
    const actual = inspectFont(strictBase64(f.bytes), "", budget.value);
    if (
      f.face.sha256 !== actual.sha256 ||
      f.face.family !== actual.family ||
      f.face.postScriptName !== actual.postScriptName ||
      actual.weight !== 400 ||
      actual.style !== "normal"
    )
      throw new HostBoundaryError(
        "FONT_MISSING",
        "Wire font identity mismatch.",
      );
    return { id: f.id, bytes: f.bytes, face: actual };
  });
  const images = x.images.map((a: unknown): PreparedImage => {
    if (
      !object(a) ||
      typeof a.id !== "string" ||
      typeof a.bytes !== "string" ||
      typeof a.sha256 !== "string" ||
      typeof a.width !== "number" ||
      typeof a.height !== "number" ||
      (a.mediaType !== "image/png" && a.mediaType !== "image/svg+xml")
    )
      throw new HostBoundaryError("INVALID_INPUT", "Invalid wire image.");
    return {
      id: a.id,
      bytes: a.bytes,
      sha256: a.sha256,
      width: a.width,
      height: a.height,
      mediaType: a.mediaType,
    };
  });
  const ids = new Set<string>();
  function visit(node: DesignIR["root"], depth: number) {
    if (depth > admittedBudget.maxDepth)
      throw new HostBoundaryError("DEPTH_LIMIT", "Wire tree depth limit.");
    if (ids.has(node.id))
      throw new HostBoundaryError("DUPLICATE_NODE_ID", "Duplicate wire node.");
    ids.add(node.id);
    if (ids.size > admittedBudget.maxExpandedNodes)
      throw new HostBoundaryError("NODE_LIMIT", "Wire expanded node limit.");
    for (const child of children(node)) visit(child, depth + 1);
  }
  visit(design.value.root, 1);
  if (x.telemetry !== undefined && typeof x.telemetry !== "boolean")
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid telemetry selection.",
    );
  const wire: RenderWire = {
    version: 1,
    design: design.value,
    profile: profile.value,
    budget: budget.value,
    mode: x.mode,
    fonts,
    images,
    ...(x.telemetry === true ? { telemetry: true } : {}),
  };
  if (
    bytes.byteLength > wire.budget.maxInputBytes ||
    logicalBytes(bytes) > wire.budget.maxInputBytes
  )
    throw new HostBoundaryError(
      "INPUT_LIMIT",
      "Wire/logical input byte limit.",
    );
  return wire;
}
function strictBase64(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Noncanonical resource encoding.",
    );
  return bytes;
}
async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
}
export function createWorker(
  installation: BrowserInstallation,
  budgetLimits: Readonly<Budget> = DEFAULT_BUDGETS,
): TrustedRendererImplementation {
  const config = structuredClone(installation);
  if (!validateContract("Budget", budgetLimits).success)
    throw new HostBoundaryError(
      "INVALID_INPUT",
      "Invalid installed worker limits.",
    );
  const limits = Object.freeze({ ...budgetLimits });
  let browser: Browser | undefined;
  const verifiedImages = new Map<string, { width: number; height: number }>();
  let phase = "preflight";
  let browserStartupMs = 0;
  async function launch() {
    if (browser) return browser;
    const startup = performance.now();
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Windows x64 browser profile required.",
        true,
      );
    if (
      !path.isAbsolute(config.root) ||
      (await realpath(config.root)) !== config.root
    )
      throw new HostBoundaryError(
        "PATH_FORBIDDEN",
        "Browser root must be a trusted real directory.",
      );
    for (const file of config.files) {
      if (
        !file.path ||
        file.path.includes("\\") ||
        file.path.split("/").some((p) => p === ".." || p === "." || !p) ||
        path.isAbsolute(file.path)
      )
        throw new HostBoundaryError(
          "PATH_FORBIDDEN",
          "Invalid browser manifest path.",
        );
      const target = path.join(config.root, ...file.path.split("/"));
      const stat = await lstat(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== file.byteLength ||
        hashBytes(await readFile(target)) !== file.sha256
      )
        throw new HostBoundaryError(
          "ARTIFACT_INTEGRITY",
          "Browser payload identity mismatch.",
        );
    }
    const executable = config.files.find((f) => f.path === config.executable);
    if (
      executable?.sha256 !==
        "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c" ||
      !config.files.some((f) => f.path.endsWith("LICENSE.headless_shell"))
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Missing pinned shell executable or notices.",
      );
    phase = "browser-launch";
    browser = await chromium.launch({
      executablePath: path.join(config.root, ...config.executable.split("/")),
      chromiumSandbox: true,
      headless: true,
      timeout: 15_000,
      args: ["--force-color-profile=srgb", "--enable-automation"],
    });
    const cdp = await browser.newBrowserCDPSession();
    const command = await cdp.send("Browser.getBrowserCommandLine");
    if (
      browser.version() !== "153.0.8010.12" ||
      command.arguments.some(
        (a) =>
          a === "--no-sandbox" ||
          a === "--disable-setuid-sandbox" ||
          a.startsWith("--remote-debugging-port"),
      ) ||
      !command.arguments.includes("--remote-debugging-pipe")
    )
      throw new HostBoundaryError(
        "TOOL_VERSION_UNSUPPORTED",
        "Browser sandbox/transport/profile mismatch.",
      );
    await cdp.detach();
    browserStartupMs = performance.now() - startup;
    return browser;
  }
  return {
    async render(bytes, { signal }) {
      const started = performance.now();
      const wasCold = browser === undefined;
      let page: Page | undefined;
      let abort: (() => void) | undefined;
      try {
        phase = "request";
        const wire = decodeWire(bytes, limits);
        const build = await installedBuildIdentity();
        signal.throwIfAborted();
        const p = wire.profile,
          screen = wire.design.screen;
        if (
          p.host.os !== "windows" ||
          p.host.architecture !== "x64" ||
          p.host.version !== release() ||
          p.host.evidence !== "observed" ||
          p.browser.version !== "153.0.8010.12" ||
          p.browser.sha256 !==
            "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c" ||
          p.browser.name !== "chromium-headless-shell" ||
          canonicalDigest(p.renderer) !== canonicalDigest(build.renderer) ||
          p.locale !== "en-US" ||
          p.theme !== "light" ||
          p.fontFallback !== "forbidden" ||
          Object.keys(p.state).length !== 0 ||
          p.capture.systemBars !== "excluded" ||
          Object.values(p.capture.insets).some((value) => value !== 0) ||
          p.viewport.width !== screen.viewport.width ||
          p.viewport.height !== screen.viewport.height ||
          p.viewport.unit !== "design-unit" ||
          p.viewport.x !== 0 ||
          p.viewport.y !== 0 ||
          p.capture.bounds.unit !== "design-unit" ||
          p.capture.bounds.x < 0 ||
          p.capture.bounds.y < 0 ||
          p.capture.bounds.x + p.capture.bounds.width > p.viewport.width ||
          p.capture.bounds.y + p.capture.bounds.height > p.viewport.height ||
          ![1, 2].includes(p.deviceScale) ||
          p.viewport.width <= 0 ||
          p.viewport.height <= 0 ||
          !Number.isSafeInteger(p.viewport.width * p.deviceScale) ||
          !Number.isSafeInteger(p.viewport.height * p.deviceScale)
        )
          throw new HostBoundaryError(
            "UNSUPPORTED_FEATURE",
            "Unsupported or unobserved render profile.",
          );
        if (
          p.viewport.width * p.viewport.height * p.deviceScale ** 2 >
            wire.budget.maxRasterPixels ||
          p.viewport.width * p.viewport.height * p.deviceScale ** 2 * 4 >
            wire.budget.maxOutputBytes
        )
          throw new HostBoundaryError("RASTER_LIMIT", "Capture raster limit.");
        for (const f of wire.fonts) {
          const raw = strictBase64(f.bytes),
            face = inspectFont(raw, "", wire.budget);
          if (
            face.sha256 !== f.face.sha256 ||
            face.family !== f.face.family ||
            face.postScriptName !== f.face.postScriptName ||
            !p.fontHashes.some((ref) => ref.sha256 === face.sha256)
          )
            throw new HostBoundaryError(
              "FONT_MISSING",
              "Wire face identity mismatch.",
            );
        }
        for (const image of wire.images) {
          const raw = strictBase64(image.bytes);
          if (hashBytes(raw) !== image.sha256)
            throw new HostBoundaryError(
              "ASSET_INVALID",
              "Wire image identity mismatch.",
            );
          const key = canonicalDigest([
            image.sha256,
            image.mediaType,
            image.width,
            image.height,
            p,
            wire.budget,
            ASSET_PROFILE,
          ]);
          let measured = verifiedImages.get(key);
          if (!measured) {
            const decoded =
              image.mediaType === "image/png"
                ? decodeRaster(raw, wire.budget)
                : sanitizeSvg(raw, wire.budget);
            measured = { width: decoded.width, height: decoded.height };
            if (verifiedImages.size >= 256) {
              const first = verifiedImages.keys().next().value;
              if (first !== undefined) verifiedImages.delete(first);
            }
            verifiedImages.set(key, measured);
          }
          if (
            measured.width !== image.width ||
            measured.height !== image.height
          )
            throw new HostBoundaryError(
              "ASSET_INVALID",
              "Wire image dimensions mismatch.",
            );
        }
        const activeBrowser = await launch();
        signal.throwIfAborted();
        const context = await activeBrowser.newContext({
          viewport: { width: p.viewport.width, height: p.viewport.height },
          deviceScaleFactor: p.deviceScale,
          locale: p.locale,
          timezoneId: "UTC",
          colorScheme: "light",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          acceptDownloads: false,
          javaScriptEnabled: true,
        });
        let denied = false;
        await context.route("**/*", async (route) => {
          denied = true;
          await route.abort("blockedbyclient");
        });
        await context.routeWebSocket("**/*", (socket) => {
          denied = true;
          socket.close();
        });
        page = await context.newPage();
        const activePage = page;
        page.setDefaultTimeout(10_000);
        page.on("popup", async (popup) => {
          denied = true;
          await popup.close();
        });
        const closed: Promise<void>[] = [];
        abort = () => {
          closed.push(context.close());
        };
        signal.addEventListener("abort", abort, { once: true });
        phase = "font-readiness";
        await page.clock.install({ time: new Date(p.frozenTime) });
        await page.clock.pauseAt(new Date(p.frozenTime));
        await page.setContent(shell("", fontStyles(wire.fonts)));
        await page.evaluate(async (fonts) => {
          await Promise.all(
            fonts.map((font) =>
              document.fonts.load(`16px f_${font.face.sha256}`),
            ),
          );
        }, wire.fonts);
        await ready(page);
        phase = "layout";
        const expanded = structuredClone(wire.design);
        function intrinsicImages(node: DesignIR["root"]) {
          if (node.type === "image" || node.type === "icon") {
            const image = wire.images.find((a) => a.id === node.assetId);
            if (!image)
              throw new HostBoundaryError("ASSET_INVALID", "Missing image.");
            if (node.layout.width === "hug")
              node.layout.width = node.crop?.width ?? image.width;
            if (node.layout.height === "hug")
              node.layout.height = node.crop?.height ?? image.height;
          }
          for (const child of children(node)) intrinsicImages(child);
        }
        intrinsicImages(expanded.root);
        const measurements = new Map<string, TextMeasurement>();
        const layout = await layoutDesign(
          expanded.root,
          p.viewport.width,
          p.viewport.height,
          async (node, width) => {
            signal.throwIfAborted();
            const key = canonicalDigest([
              node.content,
              node.typography,
              node.styledRanges ?? [],
              width ?? null,
            ]);
            const cached = measurements.get(key);
            if (cached) return cached;
            const css: string[] = [],
              runs: import("./document.js").TextRun[] = [];
            const markup = textMarkup(node, wire.fonts, css, runs, "m");
            const style = typography(node.typography, wire.fonts);
            const result = await activePage.evaluate(
              ({ markup, css, style, width }) => {
                const sheet = document.createElement("style");
                sheet.nonce = "renderer-style";
                sheet.textContent = css.join("\n");
                document.head.append(sheet);
                const element = document.createElement("div");
                element.style.cssText = `${style};position:absolute;left:0;top:0;width:${width === null ? "max-content" : `${width}px`};height:auto`;
                element.innerHTML = markup;
                document.body.append(element);
                const rect = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                const lineRects = [...range.getClientRects()];
                const right = Math.max(
                  rect.right,
                  ...lineRects.map((r) => r.right),
                );
                const left = Math.min(
                  rect.left,
                  ...lineRects.map((r) => r.left),
                );
                const value = {
                  width: right - left,
                  height: rect.height,
                  left: left - rect.left,
                  right: right - rect.left,
                };
                element.remove();
                sheet.remove();
                return value;
              },
              { markup, css, style, width: width ?? null },
            );
            measurements.set(key, result);
            return result;
          },
        );
        const compiled = compileDocument(
          expanded.root,
          layout,
          wire.fonts,
          wire.images,
          p.capture.scrollOffset,
        );
        phase = "paint";
        await page.setContent(compiled.html);
        await ready(page);
        const cdp = await context.newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const dom = await cdp.send("DOM.getDocument");
        const textNodes = await cdp.send("DOM.querySelectorAll", {
          nodeId: dom.root.nodeId,
          selector: "#capture-origin span",
        });
        if (textNodes.nodeIds.length !== compiled.runs.length)
          throw new HostBoundaryError(
            "ARTIFACT_INTEGRITY",
            "Rendered text-run correspondence changed.",
          );
        const faceUses: FaceUse[] = [];
        phase = "actual-face";
        for (let offset = 0; offset < compiled.runs.length; offset += 8) {
          const measured = await Promise.all(
            compiled.runs
              .slice(offset, offset + 8)
              .map(async (run, index): Promise<FaceUse[]> => {
                if (!run.content.trim()) return [];
                const nodeId = textNodes.nodeIds[offset + index];
                if (nodeId === undefined)
                  throw new HostBoundaryError(
                    "ARTIFACT_INTEGRITY",
                    "Missing text run.",
                  );
                const actual = await cdp.send("CSS.getPlatformFontsForNode", {
                  nodeId,
                });
                if (
                  !actual.fonts.length ||
                  actual.fonts.some(
                    (f) =>
                      !f.isCustomFont ||
                      f.glyphCount <= 0 ||
                      f.familyName !== run.font.face.family,
                  )
                )
                  throw new HostBoundaryError(
                    "FONT_FALLBACK",
                    "Browser did not prove sole requested custom face.",
                  );
                return actual.fonts.map((face) => ({
                  nodeId: run.owner,
                  fontId: run.font.id,
                  fontSha256: run.font.face.sha256,
                  family: face.familyName,
                  custom: face.isCustomFont,
                  glyphs: face.glyphCount,
                }));
              }),
          );
          faceUses.push(...measured.flat());
        }
        phase = "geometry";
        const readGeometry = () =>
          activePage.evaluate(
            (ids) =>
              ids.map((id) => {
                const el = document.getElementById(id);
                if (!el) throw new Error("Missing capture node");
                const b = el.getBoundingClientRect();
                return { x: b.x, y: b.y, width: b.width, height: b.height };
              }),
            compiled.elements.map((e) => e.id),
          );
        const before = await readGeometry();
        const nodes: BoundsMap["nodes"] = Object.create(null);
        const matrices = new Map<string, Matrix>(),
          chains = new Map<string, string[]>();
        let order = 0;
        for (const [index, { node }] of compiled.elements.entries()) {
          const box = layout.boxes[node.id],
            measured = before[index];
          if (!box || !measured)
            throw new HostBoundaryError(
              "INVALID_LAYOUT",
              "Incomplete measured map.",
            );
          const parent = layout.parents[node.id];
          let inherited: Matrix = parent
            ? (matrices.get(parent) ?? IDENTITY)
            : [
                1,
                0,
                0,
                1,
                -p.capture.scrollOffset.x,
                -p.capture.scrollOffset.y,
              ];
          const parentNode = compiled.elements.find(
            (e) => e.node.id === parent,
          )?.node;
          if (parentNode?.type === "scroll")
            inherited = multiply(inherited, [
              1,
              0,
              0,
              1,
              -parentNode.scroll.captureOffset.x,
              -parentNode.scroll.captureOffset.y,
            ]);
          const transform =
            "transform" in node && node.transform
              ? node.transform
              : {
                  matrix: [...IDENTITY] as [
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                  ],
                  origin: { x: 0, y: 0 },
                };
          const world = compose(
            multiply(inherited, [1, 0, 0, 1, box.x, box.y]),
            transform.matrix,
            transform.origin,
          );
          matrices.set(node.id, world);
          const expected = mapRect(
            { x: 0, y: 0, width: box.width, height: box.height },
            world,
          );
          if (
            Object.keys(expected).some(
              (key) =>
                Math.abs(
                  expected[key as keyof typeof expected] -
                    measured[key as keyof typeof measured],
                ) >
                1 / 32,
            )
          )
            throw new HostBoundaryError(
              "INVALID_LAYOUT",
              "Browser geometry differs from allocated transform geometry.",
            );
          const clips = [...(parent ? (chains.get(parent) ?? []) : [])];
          const appearance = "appearance" in node ? node.appearance : undefined;
          const parentAppearance =
            parentNode && "appearance" in parentNode
              ? parentNode.appearance
              : undefined;
          const parentBox = parent ? layout.boxes[parent] : undefined;
          if (
            parentNode &&
            parentBox &&
            parentNode.type !== "scroll" &&
            (!parentAppearance?.clip || parentAppearance.clip.kind === "none")
          ) {
            const relative = mapRect(
              { x: 0, y: 0, width: box.width, height: box.height },
              compose(
                [1, 0, 0, 1, box.x, box.y],
                transform.matrix,
                transform.origin,
              ),
            );
            const pad = parentNode.layout.padding;
            if (
              relative.x < scalar(pad?.left) - 1 / 32 ||
              relative.y < scalar(pad?.top) - 1 / 32 ||
              relative.x + relative.width >
                parentBox.width - scalar(pad?.right) + 1 / 32 ||
              relative.y + relative.height >
                parentBox.height - scalar(pad?.bottom) + 1 / 32
            )
              if (!layout.overflow.includes(node.id))
                layout.overflow.push(node.id);
          }
          if (
            node.type === "scroll" ||
            node.type === "image" ||
            node.type === "icon" ||
            (appearance?.clip && appearance.clip.kind !== "none")
          )
            clips.push(node.id);
          chains.set(node.id, clips);
          nodes[node.id] = {
            localBounds: { ...box, unit: "design-unit" },
            measuredBounds: { ...measured, unit: "design-unit" },
            ...(node.metadata?.sourceAbsoluteBounds
              ? { sourceAbsoluteBounds: node.metadata.sourceAbsoluteBounds }
              : {}),
            transform,
            clipChain: clips,
            paintOrder: order++,
            overflow:
              layout.overflow.includes(node.id) ||
              Object.hasOwn(layout.textExcess, node.id),
            evidence: "renderer-measurement",
          };
        }
        if (wire.mode === "strict" && layout.overflow.length)
          throw new HostBoundaryError(
            "INVALID_LAYOUT",
            "Unexpected measured text/layout overflow.",
          );
        phase = "screenshot";
        const png = await page.screenshot({
          type: "png",
          animations: "disabled",
          caret: "hide",
          clip: {
            x: p.capture.bounds.x,
            y: p.capture.bounds.y,
            width: p.capture.bounds.width,
            height: p.capture.bounds.height,
          },
        });
        if (
          canonicalDigest(before) !== canonicalDigest(await readGeometry()) ||
          denied
        )
          throw new HostBoundaryError(
            "SOURCE_CHANGED_DURING_CAPTURE",
            "Capture changed or attempted forbidden network access.",
          );
        signal.throwIfAborted();
        const result: CaptureReply = {
          ok: true,
          png: png.toString("base64"),
          nodes,
          fonts: faceUses,
          overflow: layout.overflow,
          textExcess: layout.textExcess,
          profile: p,
        };
        if (wire.telemetry) {
          const system = await activeBrowser.newBrowserCDPSession();
          const processes = await system.send("SystemInfo.getProcessInfo");
          await system.detach();
          result.telemetry = {
            workerMs: performance.now() - started,
            browserStartupMs: wasCold ? browserStartupMs : 0,
            workerPid: process.pid,
            workerRss: process.memoryUsage().rss,
            processes: processes.processInfo,
          };
        }
        const output = canonicalBytes(result);
        if (output.byteLength > wire.budget.maxOutputBytes)
          throw new HostBoundaryError(
            "OUTPUT_LIMIT",
            "Capture response byte limit.",
          );
        signal.removeEventListener("abort", abort);
        abort = undefined;
        await context.close();
        await Promise.all(closed);
        page = undefined;
        signal.throwIfAborted();
        return output;
      } catch (error) {
        if (page) await page.context().close();
        if (abort) signal.removeEventListener("abort", abort);
        const result: CaptureReply = {
          ok: false,
          code: signal.aborted
            ? "CANCELLED"
            : error instanceof HostBoundaryError
              ? error.code
              : "PROCESS_FAILED",
          message:
            error instanceof HostBoundaryError
              ? error.message
              : `Renderer failed during ${phase}.`,
        };
        return canonicalBytes(result);
      }
    },
    async close() {
      await browser?.close();
      browser = undefined;
      verifiedImages.clear();
    },
  };
}
