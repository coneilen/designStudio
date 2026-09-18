import { readFile } from "node:fs/promises";
import type {
  ContractName,
  ContractTypes,
  DesignIR,
  Diagnostic,
  FoundationAcceptFixtureRequest,
  FoundationApiDescriptionResponseData,
  FoundationCancelJobRequest,
  FoundationHelpResponseData,
  FoundationRenderSubmissionRequest,
  FoundationRevisionResponseData,
  FoundationServiceResponseData,
  FoundationVersionedJobResponse,
  FoundationVersionResponseData,
  Job,
  LegacyResponseData,
  ResponseEnvelope,
  Revision,
} from "@design-studio/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parseContract, validateContract } from "../src/index.js";
import { foundationSchema } from "../src/schema.generated.js";

const fixtures = new URL(
  "../../../tests/fixtures/foundation/",
  import.meta.url,
);
const examples = parseContract(
  "ContractExamples",
  await readFile(new URL("contract-examples.json", fixtures), "utf8"),
  "json",
);
function example<K extends ContractName>(name: K): ContractTypes[K] {
  const item = examples.artifacts.find((entry) => entry.contract === name);
  if (!item) throw new Error(`Missing example ${name}.`);
  return parseContract(name, JSON.stringify(item.value), "json");
}
const design = parseContract(
  "DesignIR",
  await readFile(new URL("settings-screen.design.json", fixtures), "utf8"),
  "json",
);
const revision = example("Revision");
const job = example("Job");
const artifact = example("HandoffManifest").artifacts["design.json"];
const receipt = parseContract(
  "CommitReceipt",
  JSON.stringify({
    schemaVersion: "1.0",
    id: "receipt_synthetic",
    projectId: job.projectId,
    jobId: job.id,
    idempotency: job.idempotency,
    committedAt: "2026-09-16T00:00:00Z",
    outputs: [artifact],
    integrity: "verified",
    publication: "atomic",
  }),
  "json",
);
const base = {
  expectedBaseRevision: "revision_base",
  ifMatch: `"${"a".repeat(64)}"`,
};
const reference = { id: "revision_artifact", sha256: "a".repeat(64) };
const error = {
  code: "NOT_FOUND",
  message: "The authorized resource is absent.",
  retryable: false,
  diagnosticIds: [],
};
const envelope = <T>(data: T) => ({
  schemaVersion: "1.0",
  success: true,
  requestId: "request_contract",
  data,
});
const failure = {
  schemaVersion: "1.0",
  success: false,
  requestId: "request_contract",
  error,
};

it("keeps generated response data typed instead of an unknown property bag", () => {
  expectTypeOf<string>().not.toMatchTypeOf<keyof LegacyResponseData>();
  type Data = Extract<ResponseEnvelope, { success: true }>["data"];
  expectTypeOf<
    Extract<Data, { kind: "revision" }>
  >().toEqualTypeOf<FoundationRevisionResponseData>();
  expectTypeOf<
    Extract<Data, { kind: "help" }>
  >().toEqualTypeOf<FoundationHelpResponseData>();
  expectTypeOf<
    Extract<Data, { kind: "version" }>
  >().toEqualTypeOf<FoundationVersionResponseData>();
  expectTypeOf<
    Extract<Data, { kind: "api-description" }>
  >().toEqualTypeOf<FoundationApiDescriptionResponseData>();
  expectTypeOf<
    Extract<Data, { kind: "service" }>
  >().toEqualTypeOf<FoundationServiceResponseData>();
  expectTypeOf<string>().not.toMatchTypeOf<
    keyof FoundationVersionedJobResponse["data"]
  >();
  const result = parseContract(
    "ResponseEnvelope",
    JSON.stringify(
      envelope({
        kind: "revision",
        warnings: [],
        revision,
        design,
      }),
    ),
    "json",
  );
  expectTypeOf(result).toEqualTypeOf<ResponseEnvelope>();
  if (!result.success) throw new Error("Expected success.");
  expectTypeOf(result.data.warnings).toEqualTypeOf<Diagnostic[]>();
  if (result.data.kind !== "revision") throw new Error("Expected revision.");
  expectTypeOf(result.data.revision).toEqualTypeOf<Revision>();
  expectTypeOf(result.data.design).toEqualTypeOf<DesignIR>();

  const versioned = parseContract(
    "FoundationVersionedJobResponse",
    JSON.stringify(
      envelope({
        kind: "job",
        job,
        jobVersion: 1,
        warnings: [],
      }),
    ),
    "json",
  );
  expectTypeOf(versioned).toEqualTypeOf<FoundationVersionedJobResponse>();
  expectTypeOf(versioned.success).toEqualTypeOf<true>();
  expectTypeOf(versioned.data.kind).toEqualTypeOf<"job">();
  expectTypeOf(versioned.data.job).toEqualTypeOf<Job>();
  expectTypeOf(versioned.data.jobVersion).toEqualTypeOf<number>();
  expectTypeOf(versioned.data.warnings).toEqualTypeOf<Diagnostic[]>();
  expectTypeOf(
    parseContract(
      "FoundationAcceptFixtureRequest",
      '{"fixtureId":"fixture","branch":"main","base":null}',
      "json",
    ),
  ).toEqualTypeOf<FoundationAcceptFixtureRequest>();
  expectTypeOf(
    parseContract(
      "FoundationRenderSubmissionRequest",
      JSON.stringify({ revision: reference, base, mode: "strict" }),
      "json",
    ),
  ).toEqualTypeOf<FoundationRenderSubmissionRequest>();
  expectTypeOf(
    parseContract("FoundationCancelJobRequest", "{}", "json"),
  ).toEqualTypeOf<FoundationCancelJobRequest>();
});

interface ShapeCase {
  name: string;
  value: Record<string, unknown>;
  invalid: Record<string, unknown[]>;
}
const responseCases: ShapeCase[] = [
  {
    name: "revision",
    value: { revision, design },
    invalid: {
      revision: [null, {}, { ...revision, schemaVersion: "1.1" }],
      design: [null, {}, { ...design, schemaVersion: "1.1" }],
    },
  },
  {
    name: "help",
    value: { command: "designctl", usage: "designctl --help" },
    invalid: {
      command: [null, 1, "", "a".repeat(161)],
      usage: [null, 1, "", "a".repeat(16_385)],
    },
  },
  {
    name: "version",
    value: { cliVersion: "1.0.0", contractVersion: "1.1.0", apiVersion: "v1" },
    invalid: {
      cliVersion: [null, 1, "", "a".repeat(161)],
      contractVersion: [null, 1, "", "a".repeat(161)],
      apiVersion: [null, 1, "v2"],
    },
  },
  {
    name: "api-description",
    value: {
      openapiVersion: "3.1.0",
      apiVersion: "v1",
      documentSha256: "a".repeat(64),
      path: "/v1/openapi.json",
    },
    invalid: {
      openapiVersion: [null, 3.1, "3.0.0"],
      apiVersion: [null, 1, "v2"],
      documentSha256: [
        null,
        1,
        "",
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
      ],
      path: [
        null,
        1,
        "openapi.json",
        "/v2/openapi.json",
        "C:\\host\\openapi.json",
        "../openapi.json",
        "https://example.invalid/v1/openapi.json",
      ],
    },
  },
  {
    name: "service",
    value: { state: "stopped", projectId: "project_synthetic" },
    invalid: {
      state: [null, 1, "ready", "running", "failed"],
      projectId: [null, 1, "", "a".repeat(161), "../project", "project space"],
    },
  },
];
const requestCases: (ShapeCase & { name: ContractName })[] = [
  {
    name: "FoundationAcceptFixtureRequest",
    value: { fixtureId: "settings-screen", branch: "main", base },
    invalid: {
      fixtureId: [null, 1, "", "a".repeat(161), "../fixture", "fixture space"],
      branch: [null, 1, "", "a".repeat(161), "../branch", "branch space"],
      base: [
        1,
        "",
        {},
        { expectedBaseRevision: "r" },
        { ifMatch: base.ifMatch },
        { ...base, expectedBaseRevision: "" },
        { ...base, expectedBaseRevision: "a".repeat(161) },
        { ...base, ifMatch: "*" },
        { ...base, authorization: {} },
      ],
    },
  },
  {
    name: "FoundationRenderSubmissionRequest",
    value: { revision: reference, base, mode: "strict" },
    invalid: {
      revision: [
        null,
        1,
        {},
        { id: reference.id },
        { sha256: reference.sha256 },
        { ...reference, id: "" },
        { ...reference, id: "a".repeat(161) },
        { ...reference, sha256: "A".repeat(64) },
        { ...reference, path: "C:\\host\\design.json" },
      ],
      base: [
        null,
        1,
        "",
        {},
        { expectedBaseRevision: "r" },
        { ifMatch: base.ifMatch },
        { ...base, expectedBaseRevision: "" },
        { ...base, expectedBaseRevision: "a".repeat(161) },
        { ...base, ifMatch: "*" },
        { ...base, authorization: {} },
      ],
      mode: [null, 1, "", "best-effort"],
    },
  },
  { name: "FoundationCancelJobRequest", value: {}, invalid: {} },
];

describe("F08 additive success data", () => {
  const warning: Diagnostic = {
    schemaVersion: "1.0",
    id: "diagnostic_synthetic",
    code: "EVIDENCE_MISSING",
    severity: "warning",
    message: "Synthetic contract example, not an approved output.",
    operations: [],
    nodeIds: [],
    evidenceIds: [],
    recovery: "Obtain verified output evidence.",
  };
  for (const shape of responseCases) {
    const data = { kind: shape.name, warnings: [], ...shape.value };
    it(`accepts ${shape.name} without mutating or defaulting data`, () => {
      const input = envelope(data);
      const before = structuredClone(input);
      expect(validateContract("ResponseEnvelope", input).success).toBe(true);
      expect(
        parseContract("ResponseEnvelope", JSON.stringify(input), "json"),
      ).toEqual(input);
      expect(input).toEqual(before);
      expect(
        validateContract(
          "ResponseEnvelope",
          envelope({ ...data, warnings: [warning] }),
        ).success,
      ).toBe(true);
    });
    it.each(Object.keys(data))(`${shape.name} requires %s`, (field) => {
      const missing: Record<string, unknown> = { ...data };
      delete missing[field];
      expect(
        validateContract("ResponseEnvelope", envelope(missing)).success,
      ).toBe(false);
    });
    for (const [field, values] of Object.entries({
      ...shape.invalid,
      warnings: [null, {}, "", [null], [{}]],
      kind: [null, 1, "unknown"],
    })) {
      it.each(values.map((value) => [value]))(
        `${shape.name} rejects invalid ${field}: %j`,
        (value) => {
          expect(
            validateContract(
              "ResponseEnvelope",
              envelope({ ...data, [field]: value }),
            ).success,
          ).toBe(false);
        },
      );
    }
    it.each([
      "unknown",
      "extensions",
      "job",
      "jobVersion",
      "authorization",
      "document",
      "hostPath",
    ])(`${shape.name} rejects extra field %s`, (field) => {
      expect(
        validateContract("ResponseEnvelope", envelope({ ...data, [field]: {} }))
          .success,
      ).toBe(false);
    });
    it(`${shape.name} cannot mix envelope data/error, omit envelope fields, or weaken schema version`, () => {
      for (const field of ["schemaVersion", "success", "requestId", "data"]) {
        const missing: Record<string, unknown> = { ...envelope(data) };
        delete missing[field];
        expect(validateContract("ResponseEnvelope", missing).success).toBe(
          false,
        );
      }
      for (const patch of [
        { error },
        { unknown: true },
        { schemaVersion: "1.1" },
        { success: false },
        { requestId: "" },
      ]) {
        expect(
          validateContract("ResponseEnvelope", { ...envelope(data), ...patch })
            .success,
        ).toBe(false);
      }
    });
  }
  it("allows only a valid optional receipt on revision data", () => {
    const data = { kind: "revision", warnings: [], revision, design, receipt };
    expect(validateContract("ResponseEnvelope", envelope(data)).success).toBe(
      true,
    );
    for (const invalid of [
      null,
      {},
      { ...receipt, schemaVersion: "1.1" },
      { ...receipt, path: "C:\\host" },
    ]) {
      expect(
        validateContract(
          "ResponseEnvelope",
          envelope({ ...data, receipt: invalid }),
        ).success,
      ).toBe(false);
    }
  });
  it("accepts inclusive string limits and existing non-SemVer version conventions", () => {
    for (const data of [
      { kind: "help", command: "a", usage: "a" },
      { kind: "help", command: "a".repeat(160), usage: "a".repeat(16_384) },
      {
        kind: "version",
        cliVersion: "a",
        contractVersion: "a".repeat(160),
        apiVersion: "v1",
      },
      { kind: "service", state: "stopped", projectId: "a".repeat(160) },
    ]) {
      expect(
        validateContract(
          "ResponseEnvelope",
          envelope({ ...data, warnings: [] }),
        ).success,
      ).toBe(true);
    }
  });
});

describe("endpoint-versioned strict F08 requests", () => {
  for (const shape of requestCases) {
    it(`exports and accepts ${shape.name}`, () => {
      expect(validateContract(shape.name, shape.value).success).toBe(true);
      expect(
        parseContract(shape.name, JSON.stringify(shape.value), "json"),
      ).toEqual(shape.value);
    });
    for (const field of Object.keys(shape.value)) {
      it(`${shape.name} requires ${field}`, () => {
        const missing = { ...shape.value };
        delete missing[field];
        expect(validateContract(shape.name, missing).success).toBe(false);
      });
    }
    for (const [field, values] of Object.entries(shape.invalid)) {
      it.each(values.map((value) => [value]))(
        `${shape.name} rejects invalid ${field}: %j`,
        (value) => {
          expect(
            validateContract(shape.name, { ...shape.value, [field]: value })
              .success,
          ).toBe(false);
        },
      );
    }
    it.each([
      "schemaVersion",
      "projectId",
      "designId",
      "jobId",
      "authorization",
      "context",
      "callback",
      "ifMatch",
      "requestId",
      "unknown",
    ])(`${shape.name} rejects extra transport/authority field %s`, (field) => {
      expect(
        validateContract(shape.name, { ...shape.value, [field]: {} }).success,
      ).toBe(false);
    });
    it.each([null, [], "", 1, false])(
      `${shape.name} rejects non-object %j`,
      (value) => {
        expect(validateContract(shape.name, value).success).toBe(false);
      },
    );
  }
  it("allows explicit null create base, inspection mode and inclusive stable ID limits", () => {
    expect(
      validateContract("FoundationAcceptFixtureRequest", {
        fixtureId: "a".repeat(160),
        branch: "a".repeat(160),
        base: null,
      }).success,
    ).toBe(true);
    expect(
      validateContract("FoundationRenderSubmissionRequest", {
        revision: reference,
        base,
        mode: "inspection",
      }).success,
    ).toBe(true);
  });
});

describe("legacy compatibility and narrow versioned job responses", () => {
  const legacy = [
    { kind: "accepted-job", jobId: job.id, status: "queued" },
    { kind: "job", job },
    { kind: "artifact", artifact },
    { kind: "design", design },
    { kind: "validation", validation: example("ValidationReport") },
    { kind: "capabilities", capabilities: example("ProviderCapabilities") },
  ];
  for (const data of legacy) {
    it(`preserves ${data.kind} and rejects it as a versioned job response`, () => {
      const input = envelope({ ...data, warnings: [] });
      expect(validateContract("ResponseEnvelope", input).success).toBe(true);
      expect(
        validateContract("FoundationVersionedJobResponse", input).success,
      ).toBe(false);
    });
    it(`preserves previously valid shared optional fields on ${data.kind}`, () => {
      expect(
        validateContract(
          "ResponseEnvelope",
          envelope({
            ...data,
            warnings: [],
            job,
            jobId: job.id,
            status: "queued",
            artifact,
            design,
            validation: example("ValidationReport"),
            capabilities: example("ProviderCapabilities"),
          }),
        ).success,
      ).toBe(true);
    });
    it(`preserves every legacy optional-field combination on ${data.kind}`, () => {
      const optional = Object.entries({
        job,
        jobId: job.id,
        status: "queued",
        artifact,
        design,
        validation: example("ValidationReport"),
        capabilities: example("ProviderCapabilities"),
      });
      for (let mask = 0; mask < 2 ** optional.length; mask++) {
        const extra = Object.fromEntries(
          optional.filter((_, index) => mask & (1 << index)),
        );
        expect(
          validateContract(
            "ResponseEnvelope",
            envelope({ ...extra, ...data, warnings: [] }),
          ).success,
          `mask ${mask}`,
        ).toBe(true);
      }
    });
  }
  it("keeps legacy status semantics and restricts the new version field to job data", () => {
    for (const data of legacy) {
      for (const status of foundationSchema.definitions.JobStatus.enum) {
        const accepted =
          data.kind !== "accepted-job" ||
          ["queued", "running", "waiting-for-user", "retry-wait"].includes(
            status,
          );
        expect(
          validateContract(
            "ResponseEnvelope",
            envelope({ ...data, status, warnings: [] }),
          ).success,
        ).toBe(accepted);
      }
      expect(
        validateContract(
          "ResponseEnvelope",
          envelope({ ...data, jobVersion: 1, warnings: [] }),
        ).success,
      ).toBe(data.kind === "job");
    }
  });
  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "accepts authoritative jobVersion %s in both contracts",
    (jobVersion) => {
      const input = envelope({ kind: "job", job, jobVersion, warnings: [] });
      for (const name of [
        "ResponseEnvelope",
        "FoundationVersionedJobResponse",
      ] as const) {
        const before = structuredClone(input);
        expect(validateContract(name, input).success).toBe(true);
        expect(parseContract(name, JSON.stringify(input), "json")).toEqual(
          input,
        );
        expect(input).toEqual(before);
      }
    },
  );
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null, true])(
    "rejects invalid jobVersion %j without dropping it",
    (jobVersion) => {
      const input = envelope({ kind: "job", job, jobVersion, warnings: [] });
      for (const name of [
        "ResponseEnvelope",
        "FoundationVersionedJobResponse",
      ] as const) {
        expect(validateContract(name, input).success).toBe(false);
      }
      expect(input.data.jobVersion).toBe(jobVersion);
    },
  );
  it("strict refinement requires successful job data, jobVersion, warnings and all envelope fields", () => {
    const input = envelope({ kind: "job", job, jobVersion: 1, warnings: [] });
    const unversioned = envelope({ kind: "job", job, warnings: [] });
    expect(() =>
      parseContract(
        "FoundationVersionedJobResponse",
        JSON.stringify(unversioned),
        "json",
      ),
    ).toThrow();
    expect(unversioned.data).not.toHaveProperty("jobVersion");
    for (const field of Object.keys(input)) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(
        validateContract("FoundationVersionedJobResponse", missing).success,
      ).toBe(false);
    }
    for (const field of Object.keys(input.data)) {
      const missing: Record<string, unknown> = { ...input.data };
      delete missing[field];
      expect(
        validateContract("FoundationVersionedJobResponse", envelope(missing))
          .success,
      ).toBe(false);
    }
    for (const data of legacy.filter((entry) => entry.kind !== "job")) {
      expect(
        validateContract(
          "FoundationVersionedJobResponse",
          envelope({ ...data, job, jobVersion: 1, warnings: [] }),
        ).success,
      ).toBe(false);
    }
    for (const invalid of [
      failure,
      { ...input, error },
      { ...input, extra: true },
      { ...input, schemaVersion: "1.1" },
      envelope({ ...input.data, extra: true }),
      envelope({ ...input.data, job: {} }),
      envelope({ ...input.data, warnings: [{}] }),
    ]) {
      expect(
        validateContract("FoundationVersionedJobResponse", invalid).success,
      ).toBe(false);
    }
  });
  it("adds NOT_FOUND to shared typed errors without accepting fabricated HTTP enums", () => {
    expect(validateContract("ErrorCode", "NOT_FOUND").success).toBe(true);
    expect(validateContract("ContractError", error).success).toBe(true);
    expect(validateContract("ResponseEnvelope", failure).success).toBe(true);
    for (const code of ["HTTP_404", "HTTP_NOT_FOUND", "not-found", "", 404]) {
      expect(validateContract("ErrorCode", code).success).toBe(false);
      expect(
        validateContract("ResponseEnvelope", {
          ...failure,
          error: { ...error, code },
        }).success,
      ).toBe(false);
    }
  });
  it.each(foundationSchema.definitions.ErrorCode.enum)(
    "retains shared error code %s in failures",
    (code) => {
      expect(
        validateContract("ResponseEnvelope", {
          ...failure,
          error: { ...error, code },
        }).success,
      ).toBe(true);
    },
  );
});

it.each([
  ["FoundationAcceptFixtureRequest", "foundation-accept-fixture-request"],
  ["FoundationRenderSubmissionRequest", "foundation-render-submission-request"],
  ["FoundationCancelJobRequest", "foundation-cancel-job-request"],
  ["FoundationVersionedJobResponse", "foundation-versioned-job-response"],
])("publishes the generated draft-07 %s entrypoint", async (name, slug) => {
  const schema = JSON.parse(
    await readFile(
      new URL(`../schemas/${slug}.schema.json`, import.meta.url),
      "utf8",
    ),
  );
  expect(schema).toEqual({
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://design-studio.invalid/schemas/1.0/${slug}.schema.json`,
    $ref: `foundation.schema.json#/definitions/${name}`,
    $comment: "Generated from foundation.schema.json. Do not edit.",
  });
});
