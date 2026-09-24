import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const root = new URL("../", import.meta.url);
const schema = JSON.parse(
  await readFile(new URL("schemas/foundation.schema.json", root), "utf8"),
);
const names = Object.keys(schema.definitions);
const banner =
  "/* Generated from schemas/foundation.schema.json. Do not edit. */";
const types = await compile(
  {
    $schema: schema.$schema,
    title: "ContractCatalog",
    type: "object",
    additionalProperties: false,
    definitions: schema.definitions,
    properties: Object.fromEntries(
      names.map((name) => [name, { $ref: `#/definitions/${name}` }]),
    ),
    required: names,
  },
  "ContractCatalog",
  {
    bannerComment: banner,
    unreachableDefinitions: true,
    unknownAny: true,
    strictIndexSignatures: false,
    additionalProperties: false,
    enableConstEnums: false,
    format: true,
    style: {
      singleQuote: false,
      semi: true,
      tabWidth: 2,
      trailingComma: "all",
    },
  },
);
const outputs = new Map([
  ["src/generated.ts", types],
  [
    "src/catalog.generated.ts",
    `${banner}\nimport type * as Types from "./generated.js";\n\nexport interface ContractTypes {\n${names.map((name) => `  ${name}: Types.${name};`).join("\n")}\n}\n\nexport type ContractName = keyof ContractTypes;\n\nexport const contractNames: readonly ContractName[] = ${JSON.stringify(names, null, 2)};\n`,
  ],
  [
    "src/schema.generated.ts",
    `${banner}\nexport const foundationSchema = ${JSON.stringify(schema, null, 2)} as const;\n`,
  ],
]);
const publicArtifacts = [
  "DesignIR",
  "HandoffManifest",
  "Diagnostic",
  "DiagnosticReport",
  "ResourceSnapshot",
  "ComponentSnapshot",
  "TokenSnapshot",
  "ProvenanceSnapshot",
  "SourceSnapshot",
  "FigmaCaptureRequest",
  "FigmaCaptureManifest",
  "FigmaCaptureResult",
  "NativeCaptureEnvelope",
  "CaptureRecoveryProposal",
  "CaptureRecoveryAuthorization",
  "NativeCaptureRecoveryEnvelope",
  "FigmaReferenceProposal",
  "FigmaReferenceApproval",
  "FigmaReferenceRequest",
  "FigmaReferenceEvidence",
  "NativeReferenceEnvelope",
  "ReferenceRecoveryPlan",
  "NativeReferenceRecoveryPlanEnvelope",
  "ReferenceRecoveryBinding",
  "ReferenceRecoveryEvidence",
  "OfflineReferencePlan",
  "EffectiveReference",
  "ReferenceConversionEvidence",
  "NativeReferenceOfflineEnvelope",
  "FigmaIntakeManifest",
  "FigmaSourceMap",
  "FigmaConversionEvidence",
  "SourceStatus",
  "Revision",
  "ResourceLock",
  "ExpectedBase",
  "SemanticPatch",
  "SemanticDiff",
  "ReviewEvent",
  "ApprovalContext",
  "RenderProfile",
  "BoundsMap",
  "CaptureScenario",
  "CaptureMetadata",
  "ReadinessReceipt",
  "ValidationPolicy",
  "ValidationReport",
  "HandoffMetadata",
  "ImplementationPlan",
  "ResponseEnvelope",
  "FoundationVersionedJobResponse",
  "FoundationAcceptFixtureRequest",
  "FoundationRenderSubmissionRequest",
  "FoundationCancelJobRequest",
  "Job",
  "CommitReceipt",
  "Budget",
  "AuthorizationContext",
  "ProviderCapabilities",
  "FixtureManifest",
];
for (const name of publicArtifacts) {
  const slug = name
    .replace(/IR$/, "Ir")
    .replace(
      /[A-Z]/g,
      (letter, offset) => `${offset === 0 ? "" : "-"}${letter.toLowerCase()}`,
    );
  outputs.set(
    `schemas/${slug}.schema.json`,
    `${JSON.stringify(
      {
        $schema: schema.$schema,
        $id: schema.$id.replace(
          "foundation.schema.json",
          `${slug}.schema.json`,
        ),
        $ref: `foundation.schema.json#/definitions/${name}`,
        $comment: "Generated from foundation.schema.json. Do not edit.",
      },
      null,
      2,
    )}\n`,
  );
}
let mismatches = 0;
for (const [path, content] of outputs) {
  const url = new URL(path, root);
  if (process.argv.includes("--check")) {
    let actual;
    try {
      actual = await readFile(url, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (actual !== content) {
      console.error(
        `Generated contract drift: ${path}; run pnpm contracts:generate.`,
      );
      mismatches++;
    }
  } else {
    await writeFile(url, content);
  }
}
if (mismatches > 0) process.exitCode = 1;
else
  console.log(
    `${process.argv.includes("--check") ? "Checked" : "Generated"} ${outputs.size} synchronized contract outputs.`,
  );
