import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { HostBoundaryError } from "@design-studio/host";
import {
  CAPTURE_POLICY_SHA256,
  CAPTURE_PROFILE,
  capturePolicyBytes,
} from "./capture-profile.js";
import {
  assertCaptureInstallation,
  type CaptureInstallationLease,
} from "./installation.js";
import {
  type Identity,
  type Lease,
  loadNative,
  type Native,
  refuse,
} from "./native.js";

export interface FixtureScope {
  readonly projectId: string;
  readonly artifactRootId: string;
  readonly permissionScope: string;
}
export interface FixtureProjectOptions {
  readonly applicationId: "design-studio";
  readonly catalogIdentity: string;
  readonly catalogBytes: Uint8Array;
  readonly trustedImmutableInstallation: true;
  readonly fixtures: readonly FixtureScope[];
}
declare const principalBrand: unique symbol;
export interface CurrentPrincipal {
  readonly actorId: string;
  readonly [principalBrand]: true;
}
export interface FixturePaths {
  readonly database: string;
  readonly artifacts: string;
  readonly inputs: string;
  readonly outputs: string;
  readonly temp: string;
}
export interface FixtureProjectBinding {
  readonly scope: FixtureScope;
  readonly paths: FixturePaths;
  readonly principal: CurrentPrincipal;
  readonly catalogIdentity: string;
  attestLocalDatabase(filename: string, scope: FixtureScope): Promise<void>;
  recheck(): Promise<void>;
  close(): Promise<void>;
}
export interface FixtureProjectRegistry {
  currentPrincipal(): CurrentPrincipal;
  createFixtureProject(scope: FixtureScope): Promise<FixtureProjectBinding>;
  openFixtureProject(projectId: string): Promise<FixtureProjectBinding>;
  close(): Promise<void>;
}
interface Registration {
  version: 1;
  catalog: string;
  sid: string;
  scope: FixtureScope;
  child: string;
  identities: Identity[];
  kind?: typeof CAPTURE_PROFILE;
}
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sameScope = (a: FixtureScope, b: FixtureScope) =>
  a.projectId === b.projectId &&
  a.artifactRootId === b.artifactRootId &&
  a.permissionScope === b.permissionScope;
const sameIdentity = (a: Identity, b: Identity) =>
  a.path === b.path && a.volume === b.volume && a.file === b.file;

function policy(options: FixtureProjectOptions): FixtureProjectOptions {
  if (
    !(options.catalogBytes instanceof Uint8Array) ||
    options.catalogBytes.buffer instanceof SharedArrayBuffer ||
    options.catalogBytes.byteLength > 1024 * 1024
  )
    refuse("Catalog must be bounded non-shared Uint8Array bytes.");
  const catalogBytes = Buffer.from(options.catalogBytes);
  if (
    options.applicationId !== "design-studio" ||
    options.trustedImmutableInstallation !== true ||
    !/^[a-f0-9]{64}$/.test(options.catalogIdentity) ||
    hash(catalogBytes) !== options.catalogIdentity
  )
    refuse(
      "Reviewed catalog bytes/digest and an explicit immutable installed-closure precondition are required.",
    );
  if (
    !Array.isArray(options.fixtures) ||
    options.fixtures.length < 1 ||
    options.fixtures.length > 64
  )
    refuse("Installed fixture policy must contain 1..64 scopes.");
  const ids = new Set<string>();
  const fixtures = options.fixtures.map((scope) => {
    for (const value of [
      scope.projectId,
      scope.artifactRootId,
      scope.permissionScope,
    ])
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
      )
        refuse("Invalid installed fixture logical identifier.");
    if (ids.has(scope.projectId))
      refuse("Duplicate fixture project in installed policy.");
    ids.add(scope.projectId);
    return Object.freeze({
      projectId: scope.projectId,
      artifactRootId: scope.artifactRootId,
      permissionScope: scope.permissionScope,
    });
  });
  return Object.freeze({
    ...options,
    catalogBytes,
    fixtures: Object.freeze(fixtures),
  });
}

function release(leases: Lease[]): void {
  const errors: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Fixture handle release failed.");
}

async function registrationBytes(filename: string): Promise<Buffer> {
  const file = await open(filename, "r");
  let result: Buffer;
  try {
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.byteLength - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) refuse("Fixture registration exceeds 64 KiB.");
    result = buffer.subarray(0, length);
  } catch (error) {
    try {
      await file.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Registration read and file close failed.",
        { cause: error },
      );
    }
    throw error;
  }
  await file.close();
  return result;
}

export class WindowsFixtureProjects {
  private constructor() {}
  static async open(
    options: FixtureProjectOptions,
  ): Promise<FixtureProjectRegistry> {
    const trusted = policy(options);
    const native = await loadNative();
    return Registry.openInternal(trusted, native, native.localAppData());
  }
}
/** Internal capture composition; fixture configuration cannot mint this admission. */
export async function openCaptureRegistry(
  installation: CaptureInstallationLease,
  scope: FixtureScope,
): Promise<FixtureProjectRegistry> {
  assertCaptureInstallation(installation);
  const native = await loadNative();
  const options = policy({
    applicationId: "design-studio",
    catalogIdentity: CAPTURE_POLICY_SHA256,
    catalogBytes: capturePolicyBytes(),
    trustedImmutableInstallation: true,
    fixtures: [scope],
  });
  return Registry.openInternal(
    options,
    native,
    native.localAppData(),
    CAPTURE_PROFILE,
  );
}

class Registry implements FixtureProjectRegistry {
  #closed = false;
  #closing = false;
  #bindings = new Set<FixtureProjectBinding>();
  #queue: Promise<unknown> = Promise.resolve();
  readonly #principal: CurrentPrincipal;
  private constructor(
    private readonly options: FixtureProjectOptions,
    private readonly native: Native,
    private readonly sid: string,
    private readonly base: string,
    private readonly ancestors: Lease[],
    private readonly kind?: typeof CAPTURE_PROFILE,
  ) {
    // The symbol brand is compile-time opaque; runtime provenance is the private instance.
    this.#principal = Object.freeze({
      actorId: `windows-${hash(sid)}`,
    }) as CurrentPrincipal;
  }

  static async openInternal(
    options: FixtureProjectOptions,
    native: Native,
    folder: string,
    kind?: typeof CAPTURE_PROFILE,
  ): Promise<FixtureProjectRegistry> {
    const sid = native.principal();
    const leases: Lease[] = [];
    try {
      const parsed = path.win32.parse(folder);
      if (!/^[A-Za-z]:\\$/.test(parsed.root))
        refuse("KnownFolder must be an absolute local drive path.");
      const catalogDirectory = Buffer.from(
        options.catalogIdentity,
        "hex",
      ).toString("base64url");
      const longestDatabase = path.win32.join(
        folder,
        "DesignStudio",
        kind ? "capture-projects" : "fixtures",
        catalogDirectory,
        "x".repeat(43),
        "x".repeat(36),
        "database.sqlite",
      );
      if (longestDatabase.length > 240 || folder.split("\\").length > 32)
        refuse(
          "Fresh fixture profile requires database paths at most 240 UTF-16 units and at most 32 KnownFolder ancestors.",
        );
      let current = parsed.root;
      leases.push(native.inspect(current, true));
      for (const part of folder
        .slice(parsed.root.length)
        .split("\\")
        .filter(Boolean)) {
        current = path.win32.join(current, part);
        leases.push(native.inspect(current, true));
      }
      for (const part of [
        "DesignStudio",
        kind ? "capture-projects" : "fixtures",
        catalogDirectory,
      ]) {
        current = path.win32.join(current, part);
        try {
          native.createDirectory(current, sid);
        } catch (error) {
          if (
            !(error instanceof HostBoundaryError) ||
            error.code !== "CONFLICT"
          )
            throw error;
        }
        leases.push(native.inspect(current, true, sid));
      }
      const registry = new Registry(
        options,
        native,
        sid,
        current,
        leases,
        kind,
      );
      return Object.freeze({
        currentPrincipal: () => registry.currentPrincipal(),
        createFixtureProject: (scope: FixtureScope) =>
          registry.createFixtureProject(scope),
        openFixtureProject: (projectId: string) =>
          registry.openFixtureProject(projectId),
        close: () => registry.close(),
      });
    } catch (error) {
      try {
        release(leases);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Fixture registry open and handle release failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  #check(): void {
    if (this.#closed || this.#closing) refuse("Fixture registry is closed.");
    if (this.native.principal() !== this.sid)
      refuse("Current native principal changed.");
  }

  #bindingCapacity(): void {
    if (this.#bindings.size >= 64)
      refuse(
        "Close a fixture binding before opening more than 64 live bindings.",
      );
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  currentPrincipal(): CurrentPrincipal {
    this.#check();
    return this.#principal;
  }

  #scope(projectId: string): FixtureScope {
    this.#check();
    const scope = this.options.fixtures.find(
      (item) => item.projectId === projectId,
    );
    if (!scope)
      refuse("Project is not in the installed fixture catalog policy.");
    return scope;
  }

  #checkAncestors(): void {
    for (const [index, lease] of this.ancestors.entries()) {
      const check = this.native.inspect(
        lease.identity.path,
        true,
        index >= this.ancestors.length - 3 ? this.sid : undefined,
      );
      if (!sameIdentity(lease.identity, check.identity)) {
        const error = new HostBoundaryError(
          "ACTION_REQUIRED",
          "Registry ancestor identity changed.",
        );
        try {
          check.close();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Registry ancestor verification and close failed.",
            { cause: error },
          );
        }
        throw error;
      }
      check.close();
    }
  }

  #reservation(scope: FixtureScope): string {
    return path.win32.join(
      this.base,
      Buffer.from(hash(scope.projectId), "hex").toString("base64url"),
    );
  }

  #roles(
    reservation: string,
    child: string,
  ): { root: string; paths: FixturePaths } {
    const root = path.win32.join(reservation, child);
    return {
      root,
      paths: Object.freeze({
        database: path.win32.join(root, "database.sqlite"),
        artifacts: path.win32.join(root, "artifacts"),
        inputs: path.win32.join(root, "inputs"),
        outputs: path.win32.join(root, "outputs"),
        temp: path.win32.join(root, "temp"),
      }),
    };
  }

  createFixtureProject(request: FixtureScope): Promise<FixtureProjectBinding> {
    const requested = { ...request };
    return this.#serial(async () => {
      const scope = this.#scope(requested.projectId);
      if (!sameScope(scope, requested))
        refuse("Fixture scope differs from installed policy.");
      this.#bindingCapacity();
      this.#checkAncestors();
      const reservation = this.#reservation(scope);
      // Atomic reservation prevents a second creator from overwriting or adopting partial work.
      this.native.createDirectory(reservation, this.sid);
      const child = randomUUID();
      const { root, paths } = this.#roles(reservation, child);
      const leases: Lease[] = [];
      try {
        leases.push(this.native.inspect(reservation, true, this.sid));
        for (const directory of [
          root,
          paths.artifacts,
          paths.inputs,
          paths.outputs,
          paths.temp,
        ]) {
          this.native.createDirectory(directory, this.sid);
          leases.push(this.native.inspect(directory, true, this.sid));
        }
        this.native.createFile(paths.database, this.sid, Buffer.alloc(0));
        leases.push(this.native.inspect(paths.database, false, this.sid));
        const registration: Registration = {
          version: 1,
          catalog: this.options.catalogIdentity,
          sid: this.sid,
          scope,
          child,
          identities: [...this.ancestors, ...leases].map(
            (lease) => lease.identity,
          ),
          ...(this.kind ? { kind: this.kind } : {}),
        };
        this.native.createFile(
          path.win32.join(reservation, `${randomUUID()}.pending`),
          this.sid,
          Buffer.from(JSON.stringify(registration)),
          path.win32.join(reservation, "registration.json"),
        );
      } catch (error) {
        try {
          release(leases);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Incomplete fixture creation and handle release failed.",
            { cause: error },
          );
        }
        throw error;
      }
      release(leases);
      return this.#open(scope);
    });
  }

  openFixtureProject(projectId: string): Promise<FixtureProjectBinding> {
    return this.#serial(() => this.#open(this.#scope(projectId)));
  }

  async #open(scope: FixtureScope): Promise<FixtureProjectBinding> {
    this.#check();
    this.#bindingCapacity();
    this.#checkAncestors();
    const reservation = this.#reservation(scope);
    const filename = path.win32.join(reservation, "registration.json");
    const leases: Lease[] = [];
    try {
      leases.push(this.native.inspect(reservation, true, this.sid));
      leases.push(this.native.inspect(filename, false, this.sid));
      const bytes = await registrationBytes(filename);
      this.#check();
      this.#checkAncestors();
      let record: Registration;
      try {
        record = JSON.parse(bytes.toString("utf8")) as Registration;
      } catch (cause) {
        throw new HostBoundaryError(
          "ACTION_REQUIRED",
          "Torn fixture registration; explicit reconciliation required.",
          false,
          { cause },
        );
      }
      if (
        record?.version !== 1 ||
        record.kind !== this.kind ||
        record.catalog !== this.options.catalogIdentity ||
        record.sid !== this.sid ||
        !record.scope ||
        !sameScope(record.scope, scope) ||
        typeof record.child !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          record.child,
        ) ||
        !Array.isArray(record.identities)
      )
        refuse(
          "Fixture registration catalog, principal, scope or generated child is invalid.",
        );
      const { root, paths } = this.#roles(reservation, record.child);
      for (const directory of [
        root,
        paths.artifacts,
        paths.inputs,
        paths.outputs,
        paths.temp,
      ])
        leases.push(this.native.inspect(directory, true, this.sid));
      leases.push(this.native.inspect(paths.database, false, this.sid));
      const expected = [
        ...this.ancestors,
        ...leases.filter((lease) => lease.identity.path !== filename),
      ];
      if (
        record.identities.length !== expected.length ||
        expected.some(
          (lease, index) =>
            !record.identities[index] ||
            !sameIdentity(lease.identity, record.identities[index]),
        )
      )
        refuse(
          "Registered native path/volume/file identity changed; no adoption.",
        );
      const canonical: Registration = {
        version: 1,
        catalog: this.options.catalogIdentity,
        sid: this.sid,
        scope,
        child: record.child,
        identities: expected.map((lease) => lease.identity),
        ...(this.kind ? { kind: this.kind } : {}),
      };
      if (!bytes.equals(Buffer.from(JSON.stringify(canonical))))
        refuse("Fixture registration is not the exact canonical host record.");
      let closed = false;
      let closing = false;
      const recheck = async () => {
        this.#check();
        if (closed || closing) refuse("Fixture binding is closed.");
        const checks: Lease[] = [];
        try {
          for (const lease of [...this.ancestors, ...leases]) {
            const target = lease.identity.path;
            const privatePath =
              target.startsWith(`${this.base}\\`) ||
              this.ancestors
                .slice(-3)
                .some((ancestor) => ancestor.identity.path === target);
            const check = this.native.inspect(
              target,
              target !== paths.database && target !== filename,
              privatePath ? this.sid : undefined,
            );
            checks.push(check);
            if (!sameIdentity(lease.identity, check.identity))
              refuse("Fixture native identity changed.");
          }
          if (!(await registrationBytes(filename)).equals(bytes))
            refuse("Fixture registration changed while bound.");
          this.#check();
          if (closed || closing)
            refuse("Fixture binding closed during verification.");
        } catch (error) {
          try {
            release(checks);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "Fixture recheck and handle release failed.",
              { cause: error },
            );
          }
          throw error;
        }
        release(checks);
      };
      const binding: FixtureProjectBinding = Object.freeze({
        scope,
        paths,
        principal: this.#principal,
        catalogIdentity: this.options.catalogIdentity,
        attestLocalDatabase: async (
          target: string,
          requested: FixtureScope,
        ) => {
          if (target !== paths.database || !sameScope(requested, scope))
            refuse("Database attestation path or scope mismatch.");
          await recheck();
        },
        recheck,
        close: async () => {
          if (!closed) {
            closing = true;
            release(leases);
            closed = true;
            this.#bindings.delete(binding);
          }
        },
      });
      this.#bindings.add(binding);
      return binding;
    } catch (error) {
      try {
        release(leases);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Fixture verification and handle release failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) return;
      this.#closing = true;
      const errors: unknown[] = [];
      for (const binding of this.#bindings) {
        try {
          await binding.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        release(this.ancestors);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Fixture registry close failed; remaining releases may be retried.",
          { cause: errors[0] },
        );
      this.#closed = true;
    });
  }
}
