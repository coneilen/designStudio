import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { describe, expect, it } from "vitest";
import { prepareInputs } from "../src/resources.js";
import { fixtureInputs } from "./support.js";

describe("actual accepted bytes, licensed faces and media", () => {
  it("verifies normal face and all five real foundation inputs without claiming approval", async () => {
    for (const name of [
      "settings-screen",
      "mixed-styled-text",
      "image-crop-transform",
      "component-variants-slots",
      "unsupported-feature",
    ]) {
      const { request, accepted } = await fixtureInputs(name);
      if (name === "unsupported-feature") request.mode = "inspection";
      const prepared = prepareInputs(
        request,
        accepted,
        () => true,
        DEFAULT_BUDGETS,
      );
      expect(prepared.fonts[0]?.face.postScriptName).toBe("ABeeZee-Regular");
      expect(prepared.report.readiness).not.toBe("ready");
      expect(prepared.expanded.root.id).toBe(request.design.root.id);
    }
  });
  it("refuses untrusted rights even when JSON declares permitted", async () => {
    const { request, accepted } = await fixtureInputs();
    expect(() =>
      prepareInputs(request, accepted, () => false, DEFAULT_BUDGETS),
    ).toThrow("rights");
  });
  it("rejects missing raw bytes instead of hashing a reserialization", async () => {
    const { request, accepted } = await fixtureInputs();
    accepted.resourceBytes = new Uint8Array();
    expect(() =>
      prepareInputs(request, accepted, () => true, DEFAULT_BUDGETS),
    ).toThrow();
  });
  it("rejects missing font and profile hash mismatch", async () => {
    const { request, accepted } = await fixtureInputs();
    accepted.artifacts = accepted.artifacts.filter(
      (a) => a.artifact.sha256 !== request.profile.fontHashes[0]?.sha256,
    );
    expect(() =>
      prepareInputs(request, accepted, () => true, DEFAULT_BUDGETS),
    ).toThrow("resource");
    const next = await fixtureInputs();
    next.request.profile.fontHashes = [];
    expect(() =>
      prepareInputs(next.request, next.accepted, () => true, DEFAULT_BUDGETS),
    ).toThrow("profile");
  });
  it("strict unsupported case fails before browser work", async () => {
    const { request, accepted } = await fixtureInputs("unsupported-feature");
    expect(() =>
      prepareInputs(request, accepted, () => true, DEFAULT_BUDGETS),
    ).toThrow("unsupported");
  });
});
