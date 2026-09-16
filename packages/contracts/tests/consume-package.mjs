import { readFile } from "node:fs/promises";
import { parseContract } from "@design-studio/contracts";
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
const capabilities = await provider.getCapabilities(syntheticContext());
process.stdout.write(
  JSON.stringify({
    designId: design.designId,
    schemaRef: schema.$ref,
    implementation: capabilities.implementation,
  }),
);
