import { mkdir, writeFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import path from "node:path";
import { decodeRaster } from "@design-studio/assets";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { validateFaces } from "../src/faces.js";
import { prepareInputs } from "../src/resources.js";
import { encodeResourceWire } from "../src/wire.js";
import { performanceFixture } from "./fixtures/performance.js";
import { workerHarness } from "./support.js";

it.skipIf(process.env.F06_PERFORMANCE !== "1")(
  "calibrates 20 serial warm 500-node/10MiB renders on the observed Windows host",
  async () => {
    const fixture = await performanceFixture();
    expect(fixture.resourceBytes).toBe(10_485_760);
    const harness = await workerHarness(true);
    const openStart = performance.now();
    const opened = await harness.host.open(
      harness.context("benchmark-open", true),
    );
    const workerStartupMs = performance.now() - openStart;
    expect(opened.status, JSON.stringify(opened)).toBe("complete");
    if (opened.status !== "complete") {
      await harness.remove();
      return;
    }
    const samples: {
      totalMs: number;
      prepareMs: number;
      exchangeMs: number;
      verifyMs: number;
      wireBytes: number;
      pngSha256: string;
      structuredSha256: string;
      browserStartupMs: number;
      workerMs: number;
      workerRss: number;
      serviceRss: number;
    }[] = [];
    try {
      for (let i = 0; i < 23; i++) {
        const start = performance.now();
        const allowed = new Set(
          fixture.request.profile.assetHashes
            .concat(fixture.request.profile.fontHashes)
            .map((a) => a.sha256),
        );
        const prepared = prepareInputs(
          fixture.request,
          fixture.accepted,
          (_license, hash) => allowed.has(hash),
          DEFAULT_BUDGETS,
        );
        const wire = encodeResourceWire({
          version: 1,
          design: prepared.expanded,
          fonts: prepared.fonts,
          images: prepared.images,
          profile: fixture.request.profile,
          budget: DEFAULT_BUDGETS,
          mode: "strict",
          telemetry: true,
        });
        const beforeExchange = performance.now();
        const reply = await opened.value.exchange(
          wire,
          harness.context(`benchmark-${i}`),
        );
        const beforeVerify = performance.now();
        expect(
          reply.status,
          JSON.stringify(
            reply.status === "complete" ? { status: reply.status } : reply,
          ),
        ).toBe("complete");
        if (reply.status !== "complete")
          throw new Error("Benchmark exchange failed");
        const result = JSON.parse(new TextDecoder().decode(reply.value));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const png = Buffer.from(result.png, "base64"),
          decoded = decodeRaster(png, DEFAULT_BUDGETS);
        validateFaces(prepared.expanded.root, prepared.fonts, result.fonts);
        expect(Object.keys(result.nodes)).toHaveLength(500);
        expect([decoded.width, decoded.height]).toEqual([393, 852]);
        expect(result.nodes.performance_image.measuredBounds).toMatchObject({
          x: 0,
          y: 0,
          width: 393,
          height: 500,
        });
        expect(result.nodes.performance_strip.measuredBounds).toMatchObject({
          x: 0,
          y: 500,
          width: 393,
          height: 1,
        });
        const sample = {
          totalMs: performance.now() - start,
          prepareMs: beforeExchange - start,
          exchangeMs: beforeVerify - beforeExchange,
          verifyMs: performance.now() - beforeVerify,
          wireBytes: wire.byteLength,
          pngSha256: hashBytes(png),
          structuredSha256: canonicalDigest([
            result.nodes,
            result.fonts,
            result.profile,
          ]),
          browserStartupMs: result.telemetry.browserStartupMs,
          workerMs: result.telemetry.workerMs,
          workerRss: result.telemetry.workerRss,
          serviceRss: process.memoryUsage().rss,
        };
        samples.push(sample);
        await mkdir(path.resolve(".tools"), { recursive: true });
        await writeFile(
          path.resolve(".tools/renderer-perf-owned-processes.json"),
          JSON.stringify({
            service: process.pid,
            worker: result.telemetry.workerPid,
            browser: result.telemetry.processes,
          }),
        );
        console.log(
          `F06 sample ${i}: ${sample.totalMs.toFixed(1)}ms (${sample.wireBytes} wire bytes)`,
        );
      }
      const warm = samples.slice(3),
        times = warm.map((s) => s.totalMs).sort((a, b) => a - b);
      expect(new Set(samples.map((s) => s.pngSha256)).size).toBe(1);
      expect(new Set(samples.map((s) => s.structuredSha256)).size).toBe(1);
      expect(samples.slice(1).every((s) => s.browserStartupMs === 0)).toBe(
        true,
      );
      const lowerMedian = times[9],
        upperMedian = times[10];
      if (lowerMedian === undefined || upperMedian === undefined)
        throw new Error("Missing median samples.");
      const report = {
        profile: "f06-windows-500-node-10MiB-v1",
        expandedNodes: 500,
        immutableImageFontBytes: fixture.resourceBytes,
        renderProfile: fixture.request.profile,
        profileExcludes:
          "License notices, source/provenance/DesignIR JSON and IPC framing; no unused image bytes or padding chunks.",
        boundary:
          "Accepted in-memory inputs through F02 resolution, F05 byte/font/image verification, wire encoding, browser readiness/layout/face proof, PNG/map, return and PNG/hash verification. Publication/staging excluded.",
        cache:
          "Three unmeasured warmups; same owned browser, fresh context/page each render. Parent F05 verifies/decodes resources every run. Worker rehashes bytes every request and reuses at most256 validation records keyed by exact bytes/media/dimensions/profile/budgets/F05 version. Text metrics cache is page-local under full typography/text/ranges/width, with immutable page profile/faces; every rendered run still gets actual-face proof.",
        host: {
          os: release(),
          architecture: process.arch,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
          node: process.version,
          conditions:
            "Shared development Windows host; no parallel benchmark in this session, external load not controlled.",
        },
        workerStartupMs,
        browserStartupMs: samples[0]?.browserStartupMs,
        warmups: samples.slice(0, 3),
        samples: warm,
        medianMs: (lowerMedian + upperMedian) / 2,
        p95Ms: times[18],
        maxMs: times[19],
        targetMs: 2000,
        targetStatus:
          (times[18] ?? Infinity) <= 2000
            ? "met-on-this-host"
            : "missed-on-this-host",
        macos: "not-executed",
        cachedHandoff: "not-implemented-by-F06",
      };
      await mkdir(path.resolve("packages/renderer/docs"), { recursive: true });
      await writeFile(
        path.resolve("packages/renderer/docs/performance-windows.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      expect(report.p95Ms).toBeLessThanOrEqual(2000);
    } finally {
      expect(await opened.value.close()).toMatchObject({
        status: "complete",
        value: { workerExitObserved: true, jobEmptyObserved: true },
      });
      await harness.remove();
    }
  },
  200_000,
);
