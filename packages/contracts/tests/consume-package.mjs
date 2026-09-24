import { readFile } from "node:fs/promises";
import {
  contractNames,
  parseContract,
  validateContract,
} from "@design-studio/contracts";
import {
  createFakeFigmaProvider,
  syntheticContext,
} from "@design-studio/contracts/testing";

const design = parseContract(
  "DesignIR",
  await readFile(process.argv[2], "utf8"),
  "json",
);
const schema = JSON.parse(
  await readFile(
    new URL(
      import.meta.resolve(
        "@design-studio/contracts/schemas/design-ir.schema.json",
      ),
    ),
    "utf8",
  ),
);
const provider = createFakeFigmaProvider();
if (
  !contractNames.includes("RetainedInventoryFailure") ||
  !validateContract("RetainedInventoryFailure", {
    check: "proof-stat",
    category: "original-proof",
  }).success ||
  validateContract("RetainedInventoryFailure", {
    check: "proof-stat",
    category: "original-proof",
    path: "private",
  }).success
)
  throw new Error(
    "Closed inventory failure contract missing from built public API.",
  );
const capabilities = await provider.getCapabilities(syntheticContext());
const apiSchemaRefs = [];
for (const slug of [
  "foundation-accept-fixture-request",
  "foundation-render-submission-request",
  "foundation-cancel-job-request",
  "foundation-versioned-job-response",
]) {
  const entrypoint = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve(
          `@design-studio/contracts/schemas/${slug}.schema.json`,
        ),
      ),
      "utf8",
    ),
  );
  const name = entrypoint.$ref.split("/").at(-1);
  if (!contractNames.includes(name))
    throw new Error(`Unregistered public schema ${name}.`);
  apiSchemaRefs.push(entrypoint.$ref);
}
const version = parseContract(
  "ResponseEnvelope",
  JSON.stringify({
    schemaVersion: "1.0",
    success: true,
    requestId: "request_version",
    data: {
      kind: "version",
      warnings: [],
      cliVersion: "1.0.0",
      contractVersion: "1.1.0",
      apiVersion: "v1",
    },
  }),
  "json",
);
const accept = parseContract(
  "FoundationAcceptFixtureRequest",
  '{"fixtureId":"fixture","branch":"main","base":null}',
  "json",
);
const cancel = parseContract("FoundationCancelJobRequest", "{}", "json");
const strictRejectsOtherKind = !validateContract(
  "FoundationVersionedJobResponse",
  version,
).success;
process.stdout.write(
  JSON.stringify({
    designId: design.designId,
    schemaRef: schema.$ref,
    implementation: capabilities.implementation,
    apiSchemaRefs,
    version: version.data,
    accept,
    cancel,
    strictRejectsOtherKind,
  }),
);
