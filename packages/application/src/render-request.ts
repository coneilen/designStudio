import { release } from "node:os";
import {
  type ArtifactReference,
  type RenderRequest,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import { installedBuildIdentity } from "@design-studio/renderer";
import type { FixtureCatalog } from "./catalog.js";
import { ApplicationError } from "./response.js";

export async function makeRenderRequest(
  catalog: FixtureCatalog,
  fixtureId: string,
  reference: ArtifactReference,
  mode: RenderRequest["mode"],
): Promise<RenderRequest> {
  const revision = { ...reference };
  const { design, resources } = catalog.fixture(fixtureId);
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new ApplicationError("UNSUPPORTED_HOST", 503);
  if (
    !validateContract("ArtifactReference", revision).success ||
    revision.sha256 !== canonicalDigest(design)
  )
    throw new ApplicationError("CONFLICT", 412);
  if (!design.screen.capture) throw new ApplicationError("EVIDENCE_MISSING");
  const build = await installedBuildIdentity();
  const request: RenderRequest = {
    design,
    resources,
    revision,
    mode,
    profile: {
      schemaVersion: "1.0",
      id: "foundation_static_v1",
      renderer: build.renderer,
      browser: {
        name: "chromium-headless-shell",
        version: "153.0.8010.12",
        sha256:
          "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c",
      },
      host: {
        os: "windows",
        version: release(),
        architecture: "x64",
        evidence: "observed",
      },
      viewport: { x: 0, y: 0, ...design.screen.viewport },
      deviceScale: 1,
      locale: "en-US",
      theme: "light",
      colorSpace: "srgb",
      fontHashes: resources.fonts.flatMap((font) =>
        font.kind === "bundled"
          ? [{ id: font.artifact.id, sha256: font.artifact.sha256 }]
          : [],
      ),
      assetHashes: resources.assets.map((asset) => ({
        id: asset.artifact.id,
        sha256: asset.artifact.sha256,
      })),
      frozenTime: "2026-09-16T00:00:00Z",
      state: {},
      capture: design.screen.capture,
      motion: "disabled",
      network: "deny",
      fontFallback: "forbidden",
    },
  };
  const checked = validateContract("RenderRequest", request);
  if (!checked.success) throw new ApplicationError("INVALID_INPUT");
  return checked.value;
}
