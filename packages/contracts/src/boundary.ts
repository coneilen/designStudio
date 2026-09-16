import { Ajv } from "ajv";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import type { ContractName, ContractTypes } from "./catalog.generated.js";
import { contractNames } from "./catalog.generated.js";
import { foundationSchema } from "./schema.generated.js";

export interface BoundaryIssue {
  code:
    | "INVALID_INPUT"
    | "INVALID_SCHEMA"
    | "UNSUPPORTED_SCHEMA_VERSION"
    | "INPUT_LIMIT"
    | "DEPTH_LIMIT";
  path: string;
  message: string;
  measured?: number;
  allowed?: number;
}

export type ValidationResult<T> =
  | { success: true; stage: "schema-valid"; value: T }
  | { success: false; issues: BoundaryIssue[] };

export class ContractBoundaryError extends Error {
  constructor(readonly issues: readonly BoundaryIssue[]) {
    super(
      issues
        .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
        .join("\n"),
    );
    this.name = "ContractBoundaryError";
  }
}

const ajv = new Ajv({
  strict: true,
  strictRequired: false,
  allErrors: false,
  validateFormats: true,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
  ownProperties: true,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
    );
  },
});
ajv.addSchema(foundationSchema);

function issue(
  code: BoundaryIssue["code"],
  path: string,
  message: string,
): BoundaryIssue {
  return { code, path, message };
}

export function isContractName(name: string): name is ContractName {
  return contractNames.some((candidate) => candidate === name);
}

function inspectJson(
  value: unknown,
  maxDepth: number,
): BoundaryIssue | undefined {
  const ancestors = new Set<object>();
  const stack: Array<{
    value: unknown;
    depth: number;
    path: string;
    leave?: boolean;
  }> = [{ value, depth: 0, path: "" }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (
      entry.leave &&
      typeof entry.value === "object" &&
      entry.value !== null
    ) {
      ancestors.delete(entry.value);
      continue;
    }
    if (entry.depth > maxDepth) {
      return {
        ...issue(
          "DEPTH_LIMIT",
          entry.path,
          "Authoring nesting exceeds the configured boundary.",
        ),
        measured: entry.depth,
        allowed: maxDepth,
      };
    }
    const item = entry.value;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object")
      return issue("INVALID_INPUT", entry.path, "Expected finite JSON data.");
    if (ancestors.has(item))
      return issue(
        "INVALID_INPUT",
        entry.path,
        "Cyclic authoring data is forbidden.",
      );
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return issue(
        "INVALID_INPUT",
        entry.path,
        "Only plain JSON objects are accepted.",
      );
    }
    if (Object.getOwnPropertySymbols(item).length !== 0)
      return issue(
        "INVALID_INPUT",
        entry.path,
        "Symbol properties are not JSON.",
      );
    ancestors.add(item);
    stack.push({ ...entry, leave: true });
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item) && Object.keys(item).length !== item.length) {
      return issue(
        "INVALID_INPUT",
        entry.path,
        "Sparse or decorated arrays are not JSON.",
      );
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable)
        return issue(
          "INVALID_INPUT",
          entry.path,
          "Accessors and hidden properties are not JSON.",
        );
      stack.push({
        value: descriptor.value,
        depth: entry.depth + 1,
        path: `${entry.path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      });
    }
  }
  return undefined;
}

export function validateContract<K extends ContractName>(
  name: K,
  input: unknown,
): ValidationResult<ContractTypes[K]>;
export function validateContract(
  name: string,
  input: unknown,
): ValidationResult<unknown>;
export function validateContract(
  name: string,
  input: unknown,
): ValidationResult<unknown> {
  if (!isContractName(name))
    return {
      success: false,
      issues: [issue("INVALID_SCHEMA", "", `Unknown contract ${name}.`)],
    };
  const invalidJson = inspectJson(input, 128);
  if (invalidJson) return { success: false, issues: [invalidJson] };
  if (
    input &&
    typeof input === "object" &&
    "schemaVersion" in input &&
    input.schemaVersion !== "1.0"
  ) {
    return {
      success: false,
      issues: [
        issue(
          "UNSUPPORTED_SCHEMA_VERSION",
          "/schemaVersion",
          "Only schemaVersion 1.0 is supported; migrate explicitly into a new revision.",
        ),
      ],
    };
  }
  const validate = ajv.getSchema<unknown>(
    `${foundationSchema.$id}#/definitions/${name}`,
  );
  if (!validate) throw new Error(`Missing compiled contract: ${name}`);
  if (validate(input))
    return { success: true, stage: "schema-valid", value: input };
  return {
    success: false,
    issues: (validate.errors ?? []).map((error) =>
      issue(
        "INVALID_SCHEMA",
        error.instancePath,
        `${error.keyword}: ${error.message ?? "Schema mismatch"}`,
      ),
    ),
  };
}

export interface AuthoringLimits {
  maxInputBytes?: number;
}

export function parseContract<K extends ContractName>(
  name: K,
  text: string,
  format: "json" | "yaml",
  limits: AuthoringLimits = {},
): ContractTypes[K] {
  const maxInputBytes = limits.maxInputBytes ?? 26_214_400;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes <= 0 ||
    maxInputBytes > 26_214_400
  ) {
    throw new ContractBoundaryError([
      issue(
        "INVALID_INPUT",
        "",
        "Authoring limit must be a positive safe integer no greater than 25 MiB.",
      ),
    ]);
  }
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > maxInputBytes) {
    throw new ContractBoundaryError([
      {
        ...issue(
          "INPUT_LIMIT",
          "",
          "UTF-8 authoring input exceeds its byte budget.",
        ),
        measured: byteLength,
        allowed: maxInputBytes,
      },
    ]);
  }
  let input: unknown;
  try {
    if (format === "json") JSON.parse(text);
    const document = parseDocument(text, {
      strict: true,
      uniqueKeys: true,
      schema: "core",
    });
    const errors = [...document.errors, ...document.warnings];
    if (errors.length > 0)
      throw new ContractBoundaryError(
        errors.map((error) => issue("INVALID_INPUT", "", error.message)),
      );
    let astIssue: BoundaryIssue | undefined;
    visit(document, (_key, node, path) => {
      if (path.length > 260) {
        astIssue = issue(
          "DEPTH_LIMIT",
          "",
          "Authoring syntax nesting exceeds the depth budget.",
        );
        return visit.BREAK;
      }
      if (isAlias(node)) {
        astIssue = issue(
          "INVALID_INPUT",
          "",
          "YAML aliases are outside the bounded authoring profile.",
        );
        return visit.BREAK;
      }
      if (
        node &&
        typeof node === "object" &&
        "tag" in node &&
        typeof node.tag === "string" &&
        !node.tag.startsWith("tag:yaml.org,2002:")
      ) {
        astIssue = issue(
          "INVALID_INPUT",
          "",
          "Custom YAML tags are forbidden.",
        );
        return visit.BREAK;
      }
      if (
        node &&
        typeof node === "object" &&
        "key" in node &&
        (!isScalar(node.key) || typeof node.key.value !== "string")
      ) {
        astIssue = issue("INVALID_INPUT", "", "Object keys must be strings.");
        return visit.BREAK;
      }
      return undefined;
    });
    if (astIssue) throw new ContractBoundaryError([astIssue]);
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ContractBoundaryError) throw error;
    if (error instanceof SyntaxError || error instanceof RangeError) {
      throw new ContractBoundaryError([
        issue("INVALID_INPUT", "", error.message),
      ]);
    }
    throw error;
  }
  const result = validateContract(name, input);
  if (!result.success) throw new ContractBoundaryError(result.issues);
  return result.value;
}
