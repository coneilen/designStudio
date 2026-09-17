import { canonicalDigest, hashBytes } from "@design-studio/design-ir";
import { expect, it } from "vitest";
import { describeApi, generateOpenApi, openApiBytes } from "../src/openapi.js";

it("generates local authoritative schemas and only implemented route descriptors", () => {
  const document = generateOpenApi();
  expect(document.openapi).toBe("3.1.0");
  expect(document.jsonSchemaDialect).toBe(
    "http://json-schema.org/draft-07/schema#",
  );
  expect(Object.keys(document.paths)).toContain(
    "/v1/projects/{projectId}/jobs/{jobId}/cancel",
  );
  expect(JSON.stringify(document.paths)).not.toMatch(
    /figma|device|handoff|bootstrap/,
  );
  expect(
    document.components.schemas.foundation.definitions
      .FoundationCancelJobRequest,
  ).toBeDefined();
});
it("serves exactly the generated schema bytes identified in CLI metadata", () => {
  const bytes = openApiBytes();
  expect(canonicalDigest(JSON.parse(Buffer.from(bytes).toString("utf8")))).toBe(
    canonicalDigest(generateOpenApi()),
  );
  const description = describeApi("openapi");
  if (!description.success || description.data.kind !== "api-description")
    throw new Error("Missing API description.");
  expect(description.data.documentSha256).toBe(hashBytes(bytes));
});
