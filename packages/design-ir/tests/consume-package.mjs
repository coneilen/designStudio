import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContract, validateContract } from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
  resolveDesign,
} from "@design-studio/design-ir";

const load = (file) =>
  readFileSync(
    new URL(`../../../tests/fixtures/foundation/${file}`, import.meta.url),
  );
const resourceBytes = load("resources.json");
const resources = parseContract(
  "ResourceSnapshot",
  resourceBytes.toString(),
  "json",
);
const cases = [
  "settings-screen",
  "mixed-styled-text",
  "image-crop-transform",
  "component-variants-slots",
  "unsupported-feature",
];
for (const name of cases) {
  const design = parseContract(
    "DesignIR",
    load(`${name}.design.json`).toString(),
    "json",
  );
  const result = resolveDesign(design, resources, { resourceBytes });
  assert.equal(
    result.report.readiness,
    name === "unsupported-feature" ? "blocked" : "needs-review",
  );
  assert.equal(result.closure?.integrity, "verified-bytes");
  assert.ok(validateContract("DesignIR", result.design).success);
  assert.equal(
    canonicalDigest(result.design),
    hashBytes(canonicalBytes(result.design)),
  );
}
console.log(
  JSON.stringify({
    imported: true,
    fixtures: cases.length,
    unsupported: "blocked",
  }),
);
