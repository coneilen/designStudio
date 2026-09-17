import { readFileSync } from "node:fs";
import foundation from "@design-studio/contracts/schemas/foundation.schema.json" with {
  type: "json",
};
import { hashBytes } from "@design-studio/design-ir";
import { success } from "./response.js";
import { ROUTES } from "./routes.js";

const reference = (name: string) => ({
  $ref: `${foundation.$id}#/definitions/${name}`,
});
export function openApiBytes(): Uint8Array {
  return readFileSync(new URL("../generated/openapi.json", import.meta.url));
}
export function describeApi(requestId: string) {
  return success(requestId, {
    kind: "api-description",
    openapiVersion: "3.1.0",
    apiVersion: "v1",
    documentSha256: hashBytes(openApiBytes()),
    path: "/v1/openapi.json",
    warnings: [],
  });
}
export function generateOpenApi() {
  const paths: Record<string, unknown> = {};
  for (const route of ROUTES) {
    const fullPath = `/v1/projects/{projectId}${route.path}`;
    const parameters: unknown[] = [...fullPath.matchAll(/\{([^}]+)\}/g)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: reference("StableId"),
      }),
    );
    if (route.method === "POST") {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: reference("StableId"),
      });
      parameters.push({
        name: "If-Match",
        in: "header",
        required: route.operation !== "acceptFixture",
        schema: { type: "string" },
        description:
          "Exact strong content ETag, or job:<id>:<rowVersion> for cancellation.",
      });
      if (route.operation === "acceptFixture")
        parameters.push({
          name: "If-None-Match",
          in: "header",
          schema: { const: "*" },
          description:
            "Required for new roots; mutually exclusive with If-Match.",
        });
    }
    if (route.operation === "getDesign")
      parameters.push({
        name: "branch",
        in: "query",
        required: false,
        schema: { ...reference("StableId"), default: "main" },
      });
    if (route.operation === "waitJob")
      parameters.push({
        name: "timeoutMs",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 30000, default: 30000 },
      });
    if (route.operation === "getArtifact" || route.operation === "readArtifact")
      parameters.push({
        name: "sha256",
        in: "query",
        required: true,
        schema: reference("Sha256"),
      });
    const json = (schema: string) => ({
      "application/json": { schema: reference(schema) },
    });
    const responses: Record<string, unknown> = {
      "200": {
        description:
          "Authorized result; job completion and comparison verdict remain separate.",
        content:
          route.response === "binary"
            ? {
                [route.operation === "getPreview"
                  ? "image/png"
                  : "application/octet-stream"]: {
                  schema: { type: "string", format: "binary" },
                },
              }
            : json(route.response),
      },
    };
    if (route.operation === "submitRender")
      responses["202"] = {
        description: "Accepted durable work, not completed output.",
        content: json("ResponseEnvelope"),
      };
    if (route.operation === "acceptFixture")
      responses["201"] = {
        description: "Committed immutable fixture revision.",
        content: json("ResponseEnvelope"),
      };
    for (const status of [
      "400",
      "401",
      "403",
      "404",
      "409",
      "412",
      "413",
      "415",
      "428",
      "500",
      "503",
      "504",
    ])
      responses[status] = {
        description: "Typed bounded failure.",
        content: json("ResponseEnvelope"),
      };
    const operation = {
      operationId: route.operation,
      parameters,
      responses,
      ...(route.method === "POST"
        ? { requestBody: { required: true, content: json(route.request) } }
        : {}),
    };
    paths[fullPath] = { [route.method.toLowerCase()]: operation };
  }
  paths["/v1/openapi.json"] = {
    get: {
      operationId: "openapi",
      responses: {
        "200": {
          description: "Authenticated generated OpenAPI document.",
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "http://json-schema.org/draft-07/schema#",
    info: { title: "Design Studio fixture foundation", version: "1.0.0" },
    security: [{ localBearer: [] }],
    paths,
    components: {
      securitySchemes: {
        localBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Private inherited-pipe session. No bootstrap route or browser enrollment.",
        },
      },
      schemas: { foundation },
    },
  };
}
