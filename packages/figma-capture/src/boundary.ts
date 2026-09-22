import { isIP } from "node:net";
import {
  type Budget,
  type CredentialReference,
  DEFAULT_BUDGETS,
  type FigmaCaptureRequest,
  type OperationContext,
  validateContract,
} from "@design-studio/contracts";
import { canonicalDigest } from "@design-studio/design-ir";
import { parseFigmaSelection } from "@design-studio/figma-import";
import {
  type Authority,
  authorizeOperation,
  HostBoundaryError,
  OperationGuard,
  snapshotOperationContext,
} from "@design-studio/host";

export const CAPTURE_LIMITS: Readonly<Budget> = Object.freeze({
  ...DEFAULT_BUDGETS,
  maxExternalCalls: 4,
  maxAttempts: 1,
});
export interface CapturePolicy {
  id: string;
  projectId: string;
  sourceId: string;
  artifactRootId: string;
  fileKey: string;
  nodeId: string;
  credential: CredentialReference;
  imageOrigins: readonly string[];
}
export function fail(
  code: ConstructorParameters<typeof HostBoundaryError>[0],
  message: string,
): never {
  throw new HostBoundaryError(code, message);
}
export function ownPolicy(input: CapturePolicy): Readonly<CapturePolicy> {
  if (!validateContract("JsonValue", input).success)
    fail("INVALID_INPUT", "Invalid capture policy.");
  const policy = structuredClone(input);
  if (
    Object.keys(policy).some(
      (key) =>
        ![
          "id",
          "projectId",
          "sourceId",
          "artifactRootId",
          "fileKey",
          "nodeId",
          "credential",
          "imageOrigins",
        ].includes(key),
    ) ||
    [policy.id, policy.projectId, policy.sourceId, policy.artifactRootId].some(
      (value) => !validateContract("StableId", value).success,
    ) ||
    !/^[A-Za-z0-9]{1,160}$/.test(policy.fileKey) ||
    !/^[0-9]+:[0-9]+$/.test(policy.nodeId) ||
    policy.nodeId.length > 160 ||
    !validateContract("CredentialReference", policy.credential).success ||
    policy.credential.providerId !== "figma_rest" ||
    !Array.isArray(policy.imageOrigins) ||
    policy.imageOrigins.length > 16
  )
    fail("INVALID_INPUT", "Invalid closed capture policy.");
  for (const value of policy.imageOrigins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail("INVALID_INPUT", "Invalid capture image origin.");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.port ||
      url.username ||
      url.password ||
      url.hostname.endsWith(".") ||
      isIP(url.hostname) ||
      !/^[a-z0-9.-]+$/.test(url.hostname)
    )
      fail(
        "INVALID_INPUT",
        "Capture image origins must be independently approved exact HTTPS host origins.",
      );
  }
  return Object.freeze({
    ...policy,
    credential: Object.freeze(policy.credential),
    imageOrigins: Object.freeze([...new Set(policy.imageOrigins)]),
  });
}
export function ownRequest(
  input: unknown,
  policy: CapturePolicy,
): FigmaCaptureRequest {
  const checked = validateContract("FigmaCaptureRequest", input);
  if (!checked.success) fail("INVALID_INPUT", "Invalid capture request.");
  const request = structuredClone(checked.value);
  let selected: { fileKey: string; nodeId: string };
  try {
    selected = parseFigmaSelection(request.selectionUrl);
  } catch {
    fail(
      "INVALID_INPUT",
      "An explicit supported selected-frame URL is required.",
    );
  }
  const url = new URL(request.selectionUrl);
  if (
    url.pathname.includes("%") ||
    selected.fileKey !== policy.fileKey ||
    selected.nodeId !== policy.nodeId ||
    request.projectId !== policy.projectId ||
    request.policyId !== policy.id ||
    request.policySha256 !== canonicalDigest(policy) ||
    request.credential.id !== policy.credential.id ||
    request.credential.providerId !== policy.credential.providerId ||
    request.credential.store !== policy.credential.store
  )
    fail(
      "FORBIDDEN",
      "Capture selection or credential differs from the trusted project policy.",
    );
  request.selectionUrl = `https://www.figma.com/design/${selected.fileKey}/selection?node-id=${selected.nodeId.replace(":", "-")}`;
  return request;
}
export interface ImageBudget {
  readonly context: OperationContext;
  readonly signal: AbortSignal;
  readonly policy: { readonly imageOrigins: readonly string[] };
  readonly body: number;
  check(): void;
  dnsQuery(): void;
  receive(bytes: number): void;
  decoded(bytes: number): void;
}
export class CaptureBudget implements ImageBudget {
  readonly context: OperationContext;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly #guard: OperationGuard;
  readonly #watch: ReturnType<OperationGuard["watch"]>;
  calls = 0;
  dns = 0;
  received = 0;
  body = 0;
  persisted = 0;
  constructor(
    context: OperationContext,
    readonly policy: Readonly<CapturePolicy>,
    readonly authority: Authority,
  ) {
    this.context = snapshotOperationContext(context);
    this.#guard = new OperationGuard(
      this.context,
      {
        projectId: policy.projectId,
        resourceKind: "source",
        resourceId: policy.sourceId,
        operation: "capture",
      },
      authority,
      undefined,
      CAPTURE_LIMITS,
    );
    this.deadline = this.#guard.expiresAt;
    if (
      Date.parse(this.context.deadline) >
      this.context.clock.now() +
        Math.min(30000, this.context.budget.maxDurationMs)
    )
      fail(
        "POLICY_FAILED",
        "Capture admission must supply its original absolute deadline within the 30-second work limit.",
      );
    this.scopes();
    this.#watch = this.#guard.watch();
    this.signal = this.#watch.signal;
  }
  check(): void {
    if (this.signal.aborted) {
      const reason = this.signal.reason;
      throw reason instanceof HostBoundaryError
        ? new HostBoundaryError(reason.code, "Capture interrupted.")
        : new HostBoundaryError("CANCELLED", "Capture interrupted.");
    }
    this.#guard.check();
    this.scopes();
  }
  private scopes(): void {
    if (this.context.authorization.egress !== "explicit-grant-required")
      fail(
        "FORBIDDEN",
        "Capture requires explicit read-only provider egress authority.",
      );
    for (const scope of [
      {
        resourceKind: "provider" as const,
        resourceId: "figma_rest",
        operation: "read" as const,
      },
      {
        resourceKind: "artifact" as const,
        resourceId: this.policy.artifactRootId,
        operation: "write" as const,
      },
    ])
      authorizeOperation(
        this.context,
        { projectId: this.policy.projectId, ...scope },
        this.authority,
      );
  }
  call(): void {
    this.check();
    if (this.calls >= Math.min(4, this.context.budget.maxExternalCalls))
      fail("INPUT_LIMIT", "Capture external-call budget exceeded.");
    this.calls++;
  }
  dnsQuery(): void {
    this.check();
    if (this.dns >= 4)
      fail("INPUT_LIMIT", "Capture DNS query budget exceeded.");
    this.dns++;
  }
  receive(bytes: number): void {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.context.budget.maxInputBytes - this.received
    )
      fail(
        "INPUT_LIMIT",
        "Aggregate received capture bytes exceeded the original budget.",
      );
    this.received += bytes;
  }
  decoded(bytes: number): void {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.context.budget.maxInputBytes - this.body
    )
      fail(
        "INPUT_LIMIT",
        "Aggregate capture body bytes exceeded the original budget.",
      );
    this.body += bytes;
  }
  output(bytes: number): void {
    this.check();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.context.budget.maxOutputBytes - this.persisted
    )
      fail(
        "OUTPUT_LIMIT",
        "Aggregate persisted capture bytes exceeded the original budget.",
      );
    this.persisted += bytes;
  }
  async close(): Promise<void> {
    await this.#watch.close();
  }
}
