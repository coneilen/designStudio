import { createHash } from "node:crypto";
import type { CredentialReference } from "@design-studio/contracts";
import { validateContract } from "@design-studio/contracts";
import {
  type OwnedCredentialAdapter,
  validateOwnedFigmaReference,
} from "./credential-admin.js";
import { HostBoundaryError } from "./guards.js";

export interface NativeAdminEntry {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(bytes: Uint8Array): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
interface NativeAdminModule {
  AsyncEntry: new (service: string, account: string) => NativeAdminEntry;
}
interface Options {
  projectId: string;
  actorId: string;
  reference: CredentialReference;
}
async function load(): Promise<NativeAdminModule> {
  return import("@napi-rs/keyring");
}
/** Internal fixed-entry byte adapter. It does not issue authority or enroll a project. */
export class OwnedFigmaCredentialAdapter implements OwnedCredentialAdapter {
  private readonly service: string;
  private readonly account: string;
  constructor(
    options: Options,
    private readonly loadModule: () => Promise<NativeAdminModule> = load,
  ) {
    if (process.platform !== "win32")
      throw new HostBoundaryError(
        "UNSUPPORTED_HOST",
        "Credential administration requires Windows.",
        true,
      );
    validateOwnedFigmaReference(options.reference);
    if (
      !validateContract("StableId", options.projectId).success ||
      !validateContract("StableId", options.actorId).success
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid owned credential scope.",
      );
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    this.service = `DesignStudio.FigmaPAT.v1.${hash([options.actorId, options.projectId, options.reference.id])}`;
    this.account = `principal-${hash(options.actorId)}`;
  }
  private async entry(): Promise<NativeAdminEntry> {
    try {
      const module = await this.loadModule();
      return new module.AsyncEntry(this.service, this.account);
    } catch {
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Native credential binding unavailable; no fallback.",
        true,
      );
    }
  }
  async read(): Promise<Uint8Array | undefined> {
    try {
      return await (await this.entry()).getSecret();
    } catch {
      throw new HostBoundaryError(
        "PROVIDER_UNAVAILABLE",
        "Owned credential read failed; sensitive details withheld.",
        true,
      );
    }
  }
  async write(bytes: Uint8Array): Promise<void> {
    try {
      await (await this.entry()).setSecret(bytes);
    } catch {
      throw new HostBoundaryError(
        "OUTPUT_UNCERTAIN",
        "Native credential write may have taken effect.",
      );
    }
  }
  async remove(): Promise<boolean> {
    try {
      return await (await this.entry()).deleteCredential();
    } catch {
      throw new HostBoundaryError(
        "OUTPUT_UNCERTAIN",
        "Native credential removal may have taken effect.",
      );
    }
  }
}
