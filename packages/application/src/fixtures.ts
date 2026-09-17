import type { AssetInput, RightsAuthority } from "@design-studio/assets";
import {
  type ArtifactReference,
  type DesignIR,
  type JsonValue,
  parseContract,
} from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
  resolveDesign,
  validateProvenance,
} from "@design-studio/design-ir";
import type { FixtureCatalog } from "./catalog.js";
import { ApplicationError } from "./response.js";

export function fixtureSemantics(catalog: FixtureCatalog, id: string) {
  const fixture = catalog.fixture(id);
  const byHash = new Map(
    fixture.artifacts.map((entry) => [entry.artifact.sha256, entry]),
  );
  const references = new Map<
    string,
    { reference: ArtifactReference; bytes: Uint8Array }
  >();
  function add(reference: ArtifactReference) {
    const entry = byHash.get(reference.sha256);
    if (!entry) throw new ApplicationError("RESOURCE_UNRESOLVED", 409);
    references.set(`${reference.id}:${reference.sha256}`, {
      reference,
      bytes: entry.bytes.slice(),
    });
  }
  function visit(value: JsonValue) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.sha256 === "string") {
      const id =
        typeof value.snapshotId === "string" ? value.snapshotId : value.id;
      if (typeof id === "string" && byHash.has(value.sha256))
        add({ id, sha256: value.sha256 });
    }
    for (const child of Object.values(value)) visit(child);
  }
  for (const entry of fixture.artifacts)
    add({ id: entry.artifact.id, sha256: entry.artifact.sha256 });
  for (const value of [fixture.design, fixture.resources, fixture.provenance])
    visit(parseContract("JsonValue", JSON.stringify(value), "json"));
  add({ id: fixture.resources.id, sha256: hashBytes(fixture.resourceBytes) });
  const resolution = resolveDesign(fixture.design, fixture.resources, {
    resourceBytes: fixture.resourceBytes,
  });
  if (!resolution.design || !resolution.closure)
    throw new ApplicationError("INVALID_LAYOUT");
  const provenanceDiagnostics = validateProvenance(
    fixture.design,
    fixture.provenance,
    (evidence) => {
      const source = byHash.get(evidence.artifact.sha256);
      if (!source) throw new ApplicationError("EVIDENCE_MISSING");
      return parseContract(
        "JsonValue",
        Buffer.from(source.bytes).toString("utf8"),
        "json",
      );
    },
  );
  if (
    provenanceDiagnostics.some((diagnostic) => diagnostic.severity === "error")
  )
    throw new ApplicationError("EVIDENCE_MISSING");
  const licenses = [
    ...fixture.resources.assets.map((asset) => ({
      hash: asset.artifact.sha256,
      licenseDigest: canonicalDigest(asset.license),
    })),
    ...fixture.resources.fonts.flatMap((font) =>
      font.kind === "bundled"
        ? [
            {
              hash: font.artifact.sha256,
              licenseDigest: canonicalDigest(font.license),
            },
          ]
        : [],
    ),
  ];
  const rightsAuthority: RightsAuthority = (license, digest, use) =>
    ["embed", "redistribute", "local-render"].includes(use) &&
    licenses.some(
      (entry) =>
        entry.hash === digest &&
        entry.licenseDigest === canonicalDigest(license),
    );
  const bytes = (reference: ArtifactReference) => {
    const entry = byHash.get(reference.sha256);
    if (!entry) throw new ApplicationError("RESOURCE_UNRESOLVED");
    return entry.bytes.slice();
  };
  const text = textContent(resolution.design);
  const assets: AssetInput[] = [
    ...fixture.resources.assets.map((asset): AssetInput => {
      if (!asset.license.notice)
        throw new ApplicationError("LICENSE_UNVERIFIED");
      return {
        kind: "image",
        id: asset.id,
        bytes: bytes(asset.artifact),
        license: asset.license,
        notice: bytes(asset.license.notice),
        source: asset.source,
        usageNodeIds: asset.usageNodeIds,
      };
    }),
    ...fixture.resources.fonts.map((font): AssetInput => {
      if (font.kind !== "bundled" || !font.license.notice)
        throw new ApplicationError("FONT_MISSING");
      return {
        kind: "font",
        bytes: bytes(font.artifact),
        face: font,
        text,
        notice: bytes(font.license.notice),
      };
    }),
  ];
  return {
    ...fixture,
    contentBytes: canonicalBytes(fixture.design),
    references: [...references.values()],
    rightsAuthority,
    assets,
    renderReferences: [
      ...new Map(
        [
          ...resolution.closure.artifacts.map((artifact) => ({
            id: artifact.id,
            sha256: artifact.sha256,
          })),
          ...resolution.closure.references,
        ].map((reference) => [reference.sha256, reference]),
      ).values(),
    ],
    diagnostics: [...resolution.report.diagnostics, ...provenanceDiagnostics],
  };
}
function textContent(design: DesignIR): string {
  const texts: string[] = ["Unsupported"];
  function visit(node: DesignIR["root"]) {
    if (node.type === "text") texts.push(node.content);
    if ("children" in node && Array.isArray(node.children))
      for (const child of node.children) visit(child);
  }
  visit(design.root);
  return texts.join("\n");
}
