import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import path from "node:path";
import type { CredentialReference } from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import type {
  CredentialAdminAction,
  CredentialAdminJournal,
  CredentialAdminState,
} from "../../host/dist/credential-admin.js";
import {
  admitCredentialCapacity,
  CREDENTIAL_JOURNAL_RECORDS,
  credentialStateWrite,
} from "./credential-capacity.js";
import {
  assertCaptureInstallation,
  type CaptureInstallationLease,
  retainCaptureInstallation,
} from "./installation.js";
import { boundedFile } from "./installation-manifest.js";
import { type Lease, loadNative, refuse } from "./native.js";
import {
  type CurrentPrincipal,
  type FixturePaths,
  type FixtureProjectBinding,
  type FixtureProjectRegistry,
  openCaptureRegistry,
} from "./projects.js";

export interface CaptureProject {
  readonly projectId: string;
  readonly artifactRootId: string;
  readonly paths: FixturePaths;
  readonly principal: CurrentPrincipal;
  readonly reference: CredentialReference;
  recheck(): Promise<void>;
  close(): Promise<void>;
}
interface Owned {
  installation: CaptureInstallationLease;
  binding: FixtureProjectBinding;
  registry: FixtureProjectRegistry;
  sid: string;
  journal: CredentialAdminJournal & {
    begin(action: CredentialAdminAction): Promise<void>;
  };
  live: boolean;
  users: number;
  helpers: number;
}
const projects = new WeakMap<CaptureProject, Owned>();
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const same = (a: Lease, b: Lease) =>
  a.identity.path === b.identity.path &&
  a.identity.volume === b.identity.volume &&
  a.identity.file === b.identity.file;
export class CaptureStartupCleanupRequired extends HostBoundaryError {
  constructor(readonly close: () => Promise<void>) {
    super(
      "INTERRUPTED",
      "Capture startup failed; native ownership is retained until cleanup succeeds.",
    );
  }
}

export async function openCaptureProject(
  installation: CaptureInstallationLease,
  projectId?: string,
): Promise<CaptureProject> {
  assertCaptureInstallation(installation);
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      !projectId.startsWith("capture_") ||
      !uuid.test(projectId.slice("capture_".length)))
  )
    refuse("Capture project must be an app-created logical ID.");
  const release = retainCaptureInstallation(installation);
  let registry: FixtureProjectRegistry | undefined;
  const held: Lease[] = [];
  try {
    await installation.checkCurrent();
    const id =
      projectId === undefined
        ? randomUUID()
        : projectId.slice("capture_".length);
    if (
      !uuid.test(id) ||
      (projectId !== undefined && projectId !== `capture_${id}`)
    )
      refuse("Capture project must be an app-created logical ID.");
    const scope = {
      projectId: `capture_${id}`,
      artifactRootId: `capture_artifacts_${id}`,
      permissionScope: `capture_private_${id}`,
    };
    registry = await openCaptureRegistry(installation, scope);
    const binding =
      projectId === undefined
        ? await registry.createFixtureProject(scope)
        : await registry.openFixtureProject(scope.projectId);
    const native = await loadNative();
    const sid = native.principal();
    const journalRoot = path.join(binding.paths.temp, "credential-journal");
    const lockPath = path.join(binding.paths.temp, "credential.lock");
    if (projectId === undefined) {
      native.createDirectory(journalRoot, sid);
      native.createFile(lockPath, sid, Buffer.alloc(0));
    }
    held.push(native.inspect(journalRoot, true, sid));
    held.push(native.exclusive(lockPath, sid));
    const reference: CredentialReference = Object.freeze({
      id: `figma_pat_${id}`,
      providerId: "figma_rest",
      store: "windows-credential-manager",
    });
    let closed = false;
    let closing = false;
    const check = async () => {
      assertCaptureInstallation(installation);
      if (closed || closing || native.principal() !== sid)
        refuse("Capture project closed or native principal changed.");
      await binding.recheck();
      const current = native.inspect(journalRoot, true, sid);
      try {
        if (!held[0] || !same(held[0], current))
          refuse("Credential journal identity changed.");
      } finally {
        current.close();
      }
      if (closed || closing || native.principal() !== sid)
        refuse("Capture principal changed during checkpoint.");
    };
    const readRecords = async () => {
      await check();
      const names: string[] = [];
      for await (const entry of await opendir(journalRoot)) {
        if (names.length === CREDENTIAL_JOURNAL_RECORDS)
          refuse("Credential journal exceeds its bounded sequence.");
        names.push(entry.name);
      }
      names.sort();
      if (
        names.length > CREDENTIAL_JOURNAL_RECORDS ||
        names.some(
          (name, index) => name !== `${String(index).padStart(4, "0")}.json`,
        )
      )
        refuse(
          "Credential journal is incomplete or outside its bounded sequence; reconciliation required.",
        );
      let state: CredentialAdminState | undefined;
      let previous = "";
      for (const [index, name] of names.entries()) {
        const filename = path.join(journalRoot, name);
        const pin = native.inspect(filename, false, sid);
        try {
          const bytes = await boundedFile(filename, 8192);
          let value: unknown;
          try {
            value = JSON.parse(bytes.toString("utf8"));
          } catch {
            refuse("Credential journal is torn; reconciliation required.");
          }
          if (
            !value ||
            typeof value !== "object" ||
            !("state" in value) ||
            !("previous" in value) ||
            value.previous !== previous ||
            !("sequence" in value) ||
            value.sequence !== index
          )
            refuse("Credential journal sequence is invalid.");
          state = checkedState(value.state, reference);
          if (
            !bytes.equals(
              Buffer.from(JSON.stringify({ sequence: index, previous, state })),
            )
          )
            refuse("Credential journal is noncanonical.");
          previous = createHash("sha256").update(bytes).digest("hex");
        } finally {
          pin.close();
        }
      }
      await check();
      return { state, previous, count: names.length };
    };
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const pending = queue.then(work);
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    const journal: Owned["journal"] = {
      begin: (action) =>
        serial(async () => {
          const prior = await readRecords();
          admitCredentialCapacity(action, prior.count, prior.state?.state);
        }),
      read: () => serial(async () => (await readRecords()).state),
      record: async (input) => {
        const state = checkedState(input, reference);
        return serial(async () => {
          const prior = await readRecords();
          if (
            credentialStateWrite(prior.state, state, prior.count) === "retain"
          )
            return;
          await check();
          native.createFile(
            path.join(
              journalRoot,
              `${String(prior.count).padStart(4, "0")}.json`,
            ),
            sid,
            Buffer.from(
              JSON.stringify({
                sequence: prior.count,
                previous: prior.previous,
                state,
              }),
            ),
          );
          await check();
        });
      },
    };
    const owned: Owned = {
      installation,
      binding,
      registry,
      sid,
      journal,
      live: true,
      users: 0,
      helpers: 0,
    };
    const project: CaptureProject = Object.freeze({
      projectId: scope.projectId,
      artifactRootId: scope.artifactRootId,
      paths: binding.paths,
      principal: binding.principal,
      reference,
      recheck: check,
      async close() {
        if (closed) return;
        if (owned.users || owned.helpers)
          refuse(
            "Close credential owners and dialog helpers before the private capture project.",
          );
        closing = true;
        owned.live = false;
        await queue;
        for (const lease of [...held].reverse()) lease.close();
        await owned.registry.close();
        release();
        closed = true;
      },
    });
    projects.set(project, owned);
    return project;
  } catch (error) {
    const cleanup = async () => {
      const errors: unknown[] = [];
      for (const lease of [...held].reverse()) {
        try {
          lease.close();
        } catch (failure) {
          errors.push(failure);
        }
      }
      try {
        await registry?.close();
      } catch (failure) {
        errors.push(failure);
      }
      if (errors.length) throw new CaptureStartupCleanupRequired(cleanup);
      release();
    };
    await cleanup();
    throw error;
  }
}

function checkedState(
  input: unknown,
  reference: CredentialReference,
): CredentialAdminState {
  if (!input || typeof input !== "object" || Array.isArray(input))
    refuse("Invalid credential journal state.");
  const state = structuredClone(input) as CredentialAdminState;
  if (
    Object.keys(state).some(
      (key) =>
        !["reference", "state", "declaredExpiresAt", "declaredScopes"].includes(
          key,
        ),
    ) ||
    !validateContract("CredentialReference", state.reference).success ||
    JSON.stringify(state.reference) !== JSON.stringify(reference) ||
    ![
      "pending-setup",
      "pending-update",
      "pending-remove",
      "ready",
      "absent",
      "uncertain",
    ].includes(state.state) ||
    (state.declaredExpiresAt !== undefined &&
      (typeof state.declaredExpiresAt !== "string" ||
        state.declaredExpiresAt.length > 64 ||
        !validateContract("Timestamp", state.declaredExpiresAt).success)) ||
    (state.declaredScopes !== undefined &&
      (!Array.isArray(state.declaredScopes) ||
        state.declaredScopes.length > 2 ||
        new Set(state.declaredScopes).size !== state.declaredScopes.length ||
        state.declaredScopes.some(
          (scope) =>
            !["file_content:read", "file_metadata:read"].includes(scope),
        )))
  )
    refuse("Credential journal must contain only scoped nonsecret metadata.");
  return state;
}
/** Internal admission used by the native credential facade, never a caller grant. */
export function captureProjectOwner(project: CaptureProject): Owned {
  const owned = projects.get(project);
  if (!owned?.live)
    refuse("Credential administration requires a live native capture project.");
  assertCaptureInstallation(owned.installation);
  return owned;
}
