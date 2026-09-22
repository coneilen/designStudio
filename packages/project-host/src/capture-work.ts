import type {
  AuthorizationContext,
  CredentialStore,
  OperationContext,
} from "@design-studio/contracts";
import {
  DEFAULT_BUDGETS,
  referenceDiagnosticFields,
} from "@design-studio/contracts";
import {
  type Authority,
  authorizeOperation,
  boundary,
  HostBoundaryError,
  Redactor,
  ScopedCredentialStore,
  snapshotOperationContext,
} from "@design-studio/host";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import {
  type NativeCapturePolicy,
  nativeCapturePolicy,
} from "./capture-authority.js";
import { CAPTURE_POLICY, CAPTURE_POLICY_SHA256 } from "./capture-profile.js";
import { type CaptureProject, captureProjectOwner } from "./capture-project.js";
import { CAPTURE_RECOVERY_POLICY_SHA256 } from "./capture-recovery-profile.js";
import { CAPTURE_REFERENCE_POLICY_SHA256 } from "./capture-reference-profile.js";
import {
  assertCaptureRecoveryInstallation,
  assertCaptureReferenceInstallation,
} from "./installation.js";
import { refuse } from "./native.js";

export interface CaptureWork {
  readonly project: CaptureProject;
  readonly actorId: string;
  readonly permissionScope: string;
  readonly sqliteBinding: string;
  readonly policyId: string;
  readonly policySha256: string;
  readonly imageOrigins: readonly string[];
  readonly apiOrigins: readonly string[];
  readonly policy: NativeCapturePolicy;
  current(): Promise<void>;
  readyCredential(now: number): Promise<string | undefined>;
  recoveryAuthority(): Promise<{
    policySha256: string;
    credentialSha256: string;
  }>;
  referenceAuthority?(): Promise<string>;
  isCurrent(): boolean;
  attestDatabase(
    filename: string,
    scope: {
      projectId: string;
      artifactRootId: string;
      permissionScope: string;
    },
  ): Promise<void>;
  credentials(): CredentialStore;
  close(): void;
}
const works = new WeakSet<CaptureWork>();

/** Current native registry admission, never a structural project/callback assertion. */
export function acquireCaptureWork(project: CaptureProject): CaptureWork {
  const owner = captureProjectOwner(project);
  if (owner.work || owner.users || owner.helpers)
    refuse(
      "Close other capture/credential owners before starting a native capture transaction.",
    );
  owner.work++;
  const readers = new Set<ScopedCredentialStore>();
  let closed = false;
  let policy: NativeCapturePolicy | undefined;
  const current = async () => {
    captureProjectOwner(project);
    if (closed) refuse("Native capture work is closed.");
    await project.recheck();
    if (
      closed ||
      owner.registry.currentPrincipal().actorId !== project.principal.actorId
    )
      refuse("Native capture principal changed.");
  };
  const isCurrent = () => {
    try {
      captureProjectOwner(project);
      return (
        !closed &&
        owner.registry.currentPrincipal().actorId === project.principal.actorId
      );
    } catch (error) {
      if (error instanceof HostBoundaryError) return false;
      throw error;
    }
  };
  const readyCredential = async (now: number) => {
    await current();
    const state = await owner.journal.read();
    await current();
    if (
      !Number.isFinite(now) ||
      !state ||
      state.state !== "ready" ||
      (state.declaredExpiresAt && Date.parse(state.declaredExpiresAt) <= now)
    )
      throw new HostBoundaryError(
        "AUTH_REQUIRED",
        "The owned credential requires explicit enrollment or reconciliation.",
      );
    return state.declaredExpiresAt;
  };
  const work: CaptureWork = Object.freeze({
    project,
    actorId: project.principal.actorId,
    permissionScope: owner.binding.scope.permissionScope,
    sqliteBinding: owner.installation.paths.sqliteBinding,
    policyId: CAPTURE_POLICY.kind,
    policySha256: CAPTURE_POLICY_SHA256,
    imageOrigins: CAPTURE_POLICY.imageOrigins,
    apiOrigins: CAPTURE_POLICY.apiOrigins,
    get policy() {
      if (!policy) refuse("Native work authority has not been admitted.");
      return policy;
    },
    current,
    isCurrent,
    readyCredential,
    async recoveryAuthority() {
      await current();
      assertCaptureRecoveryInstallation(owner.installation);
      const credentialSha256 = await owner.journalFingerprint();
      await current();
      assertCaptureRecoveryInstallation(owner.installation);
      return { policySha256: CAPTURE_RECOVERY_POLICY_SHA256, credentialSha256 };
    },
    async referenceAuthority() {
      await current();
      assertCaptureReferenceInstallation(owner.installation);
      return CAPTURE_REFERENCE_POLICY_SHA256;
    },
    async attestDatabase(
      filename: string,
      scope: {
        projectId: string;
        artifactRootId: string;
        permissionScope: string;
      },
    ) {
      await current();
      await owner.binding.attestLocalDatabase(filename, scope);
      await current();
    },
    credentials(): CredentialStore {
      if (!isCurrent())
        refuse("Native capture credential admission is no longer current.");
      const verify: Authority = (authorization: AuthorizationContext) =>
        isCurrent() &&
        authorization.actorId === project.principal.actorId &&
        (policy?.verify(authorization) ?? false);
      const adapter = new OwnedFigmaCredentialAdapter({
        projectId: project.projectId,
        actorId: project.principal.actorId,
        reference: project.reference,
      });
      return Object.freeze({
        use<T>(
          reference: typeof project.reference,
          supplied: OperationContext,
          consumer: (bytes: Uint8Array) => Promise<T>,
        ) {
          return boundary(supplied, async () => {
            const context = snapshotOperationContext(supplied);
            const check = () =>
              authorizeOperation(
                context,
                {
                  projectId: project.projectId,
                  actorId: project.principal.actorId,
                  resourceKind: "credential",
                  resourceId: project.reference.id,
                  operation: "credential-use",
                },
                verify,
              );
            check();
            const store = new ScopedCredentialStore({
              projectId: project.projectId,
              authority: verify,
              references: [project.reference],
              redactor: new Redactor(),
              budgetLimits: {
                ...DEFAULT_BUDGETS,
                maxExternalCalls: 4,
                maxAttempts: 1,
              },
              backend: {
                store: "windows-credential-manager",
                capability: "native-binding",
                async read(_reference, signal) {
                  await current();
                  check();
                  await readyCredential(context.clock.now());
                  check();
                  if (signal.aborted)
                    throw new HostBoundaryError(
                      "CANCELLED",
                      "Credential use cancelled.",
                    );
                  check();
                  const bytes = await adapter.read();
                  try {
                    await current();
                    check();
                    if (signal.aborted)
                      throw new HostBoundaryError(
                        "CANCELLED",
                        "Credential use cancelled.",
                      );
                    if (!bytes)
                      throw new HostBoundaryError(
                        "AUTH_REQUIRED",
                        "The owned credential is absent.",
                      );
                    return bytes;
                  } catch (error) {
                    bytes?.fill(0);
                    throw error;
                  }
                },
              },
            });
            readers.add(store);
            try {
              const result = await store.use(reference, context, consumer);
              if (result.status !== "complete")
                throw new HostBoundaryError(
                  result.error.code,
                  "Owned credential use did not complete.",
                  false,
                  undefined,
                  referenceDiagnosticFields(result.error).referenceDiagnostic,
                );
              return result.value;
            } finally {
              readers.delete(store);
            }
          });
        },
      });
    },
    close() {
      if (closed) return;
      if (readers.size) refuse("Original credential work has not quiesced.");
      policy?.close();
      closed = true;
      owner.work--;
      works.delete(work);
    },
  });
  works.add(work);
  try {
    policy = nativeCapturePolicy(work);
  } catch (error) {
    closed = true;
    owner.work--;
    works.delete(work);
    throw error;
  }
  return work;
}
export function assertCaptureWork(work: CaptureWork): void {
  if (!works.has(work) || !work.isCurrent())
    refuse(
      "Capture runtime requires this process's current native work lease.",
    );
}
