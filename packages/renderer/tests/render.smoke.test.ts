import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeRaster } from "@design-studio/assets";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { installedBuildIdentity } from "../src/profile.js";
import { prepareInputs } from "../src/resources.js";
import { fixtureInputs, workerHarness } from "./support.js";

it.skipIf(process.env.F06_RENDER_SMOKE !== "1")(
  "five real fixtures produce pinned same-render PNG and node geometry, including explicit inspection",
  async () => {
    const harness = await workerHarness();
    const opened = await harness.host.open(harness.context("open"));
    expect(opened.status, JSON.stringify(opened)).toBe("complete");
    if (opened.status !== "complete") {
      await harness.remove();
      return;
    }
    try {
      for (const name of [
        "settings-screen",
        "mixed-styled-text",
        "image-crop-transform",
        "component-variants-slots",
        "unsupported-feature",
      ]) {
        const { request, accepted } = await fixtureInputs(name);
        if (name === "unsupported-feature") request.mode = "inspection";
        const allowed = new Set([
          request.profile.fontHashes[0]?.sha256,
          request.profile.assetHashes[0]?.sha256,
        ]);
        const prepared = prepareInputs(
          request,
          accepted,
          (_license, hash, use) => allowed.has(hash) && use === "embed",
          DEFAULT_BUDGETS,
        );
        const wire = canonicalBytes({
          version: 1,
          design: prepared.expanded,
          fonts: prepared.fonts,
          images: prepared.images,
          profile: request.profile,
          mode: request.mode,
          budget: DEFAULT_BUDGETS,
        });
        const reply = await opened.value.exchange(wire, harness.context(name));
        expect(reply.status, JSON.stringify(reply)).toBe("complete");
        if (reply.status !== "complete") continue;
        const result = JSON.parse(new TextDecoder().decode(reply.value));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const decoded = decodeRaster(
          Buffer.from(result.png, "base64"),
          DEFAULT_BUDGETS,
        );
        expect([decoded.width, decoded.height]).toEqual([393, 852]);
        expect(result.nodes[request.design.root.id]).toBeDefined();
        expect(result.fonts.every((f: { custom: boolean }) => f.custom)).toBe(
          true,
        );
        if (name === "image-crop-transform") {
          expect(result.nodes["rotated-image"].measuredBounds).toMatchObject({
            x: 0,
            y: 112,
            width: 100,
            height: 100,
          });
          const pixel = (x: number, y: number) => [
            ...decoded.rgba.slice(
              (y * decoded.width + x) * 4,
              (y * decoded.width + x) * 4 + 3,
            ),
          ];
          expect(pixel(25, 50)).toEqual([30, 180, 80]);
          expect(pixel(75, 50)).toEqual([35, 90, 210]);
          expect(pixel(50, 137)).toEqual([30, 180, 80]);
          expect(pixel(50, 187)).toEqual([35, 90, 210]);
        }
        const again = await opened.value.exchange(
          wire,
          harness.context(`${name}-repeat`),
        );
        expect(again.status).toBe("complete");
        if (again.status === "complete")
          expect(hashBytes(again.value)).toBe(hashBytes(reply.value));
        const directory = path.resolve(
          "packages/renderer/tests/goldens/windows-x64-shell-r1243",
        );
        const png = Buffer.from(result.png, "base64");
        const metadata = canonicalBytes({
          profile: result.profile,
          nodes: result.nodes,
          fonts: result.fonts,
          overflow: result.overflow,
          pngSha256: hashBytes(png),
        });
        if (process.env.F06_UPDATE_GOLDENS === "1") {
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, `${name}.png`), png);
          await writeFile(path.join(directory, `${name}.json`), metadata);
        } else {
          expect(
            png.equals(await readFile(path.join(directory, `${name}.png`))),
          ).toBe(true);
          const historical = JSON.parse(
            await readFile(path.join(directory, `${name}.json`), "utf8"),
          );
          expect(historical.profile.renderer).toEqual({
            name: "@design-studio/renderer",
            version: "1.0.0",
            sha256:
              "183d72b2f9914ebc1532e37910d598be41a4459fac2bd8c83d1ff0ea8b727b71",
          });
          expect(result.profile.renderer).toEqual(
            (await installedBuildIdentity()).renderer,
          );
          // Preserve the historical artifact; only its separately asserted compiler identity differs.
          expect(
            canonicalBytes({
              ...historical,
              profile: {
                ...historical.profile,
                renderer: result.profile.renderer,
              },
            }),
          ).toEqual(metadata);
        }
      }
    } finally {
      expect(await opened.value.close()).toMatchObject({
        status: "complete",
        value: { workerExitObserved: true, jobEmptyObserved: true },
      });
      await harness.remove();
    }
  },
  40_000,
);
