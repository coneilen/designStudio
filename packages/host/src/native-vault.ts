import type { CredentialReference } from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import { HostBoundaryError } from "./guards.js";
import type { NativeCredentialBackend } from "./security.js";

export interface NativeEntryReader {
  getSecret(signal?: AbortSignal): Promise<Uint8Array | undefined>;
}
export interface NativeVaultModule {
  AsyncEntry: new (service: string, account: string) => NativeEntryReader;
}
export interface NativeVaultOptions {
  entries: readonly {
    reference: CredentialReference;
    service: string;
    account: string;
  }[];
  /** Test-only host substitution requires an injected module loader. */
  platform?: NodeJS.Platform;
  load?: () => Promise<NativeVaultModule>;
}

async function loadNative(): Promise<NativeVaultModule> {
  try {
    return await import("@napi-rs/keyring");
  } catch (error) {
    throw new HostBoundaryError(
      "PROVIDER_UNAVAILABLE",
      "Pinned native vault binding could not be loaded; no fallback.",
      true,
      { cause: error },
    );
  }
}

export async function nativeVaultCapability(): Promise<{
  available: boolean;
  host: NodeJS.Platform;
  evidence: "module-load-only" | "unsupported-host" | "binding-unavailable";
  limitation: string;
}> {
  if (process.platform !== "win32" && process.platform !== "darwin")
    return {
      available: false,
      host: process.platform,
      evidence: "unsupported-host",
      limitation:
        "Only Windows Credential Manager and macOS Keychain adapters are supported.",
    };
  try {
    const module = await loadNative();
    if (typeof module.AsyncEntry !== "function")
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Native binding lacks the required asynchronous byte API.",
        true,
      );
    return {
      available: true,
      host: process.platform,
      evidence: "module-load-only",
      limitation:
        "No entry was constructed and no vault was accessed; actual availability, permissions and read behavior remain unverified.",
    };
  } catch (error) {
    if (!(error instanceof HostBoundaryError)) throw error;
    return {
      available: false,
      host: process.platform,
      evidence: "binding-unavailable",
      limitation: error.message,
    };
  }
}

export class NapiCredentialBackend implements NativeCredentialBackend {
  readonly store: "windows-credential-manager" | "macos-keychain";
  readonly capability = "native-binding" as const;
  private readonly entries: NativeVaultOptions["entries"];
  private readonly load: () => Promise<NativeVaultModule>;
  constructor(options: NativeVaultOptions) {
    const platform = options.platform ?? process.platform;
    if (
      (platform !== "win32" && platform !== "darwin") ||
      (platform !== process.platform && !options.load)
    )
      throw new HostBoundaryError(
        "UNSUPPORTED_HOST",
        "Native credential store is unsupported on this host.",
        true,
      );
    this.store =
      platform === "win32" ? "windows-credential-manager" : "macos-keychain";
    const ids = new Set<string>();
    for (const entry of options.entries) {
      if (
        !validateContract("CredentialReference", entry.reference).success ||
        entry.reference.store !== this.store ||
        ids.has(entry.reference.id) ||
        !entry.service ||
        !entry.account ||
        entry.service.length > 256 ||
        entry.account.length > 256 ||
        entry.service.includes("\0") ||
        entry.account.includes("\0")
      )
        throw new HostBoundaryError(
          "INVALID_INPUT",
          "Invalid native credential reference configuration.",
        );
      ids.add(entry.reference.id);
    }
    this.entries = structuredClone(options.entries);
    this.load = options.load ?? loadNative;
  }
  async read(
    reference: CredentialReference,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted)
      throw new HostBoundaryError("CANCELLED", "Credential lookup cancelled.");
    const configured = this.entries.find(
      (entry) =>
        entry.reference.id === reference.id &&
        entry.reference.providerId === reference.providerId &&
        entry.reference.store === reference.store,
    );
    if (!configured)
      throw new HostBoundaryError(
        "FORBIDDEN",
        "Native reference is not explicitly configured.",
      );
    let module: NativeVaultModule;
    try {
      module = await this.load();
    } catch (error) {
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Native vault binding could not be loaded; no fallback.",
        true,
        { cause: error },
      );
    }
    if (signal.aborted)
      throw new HostBoundaryError("CANCELLED", "Credential lookup cancelled.");
    let bytes: Uint8Array | undefined;
    try {
      const entry = new module.AsyncEntry(
        configured.service,
        configured.account,
      );
      // N-API abort rejection is not proof the native operation has settled.
      bytes = await entry.getSecret();
    } catch {
      if (signal.aborted)
        throw new HostBoundaryError(
          "CANCELLED",
          "Credential lookup cancelled.",
        );
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Native vault read failed (locked, inaccessible or native error); sensitive details withheld.",
        true,
      );
    }
    if (signal.aborted) {
      bytes?.fill(0);
      throw new HostBoundaryError("CANCELLED", "Credential lookup cancelled.");
    }
    if (bytes === undefined)
      throw new HostBoundaryError(
        "RESOURCE_UNRESOLVED",
        "Configured native credential does not exist.",
      );
    return bytes;
  }
}
