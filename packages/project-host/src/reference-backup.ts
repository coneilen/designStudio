import { createHash } from "node:crypto";
import type { OperationContext } from "@design-studio/contracts";
import {
  type Authority,
  HostBoundaryError,
  OperationGuard,
} from "@design-studio/host";
import { WindowsNtfsPublisher } from "../../host/dist/windows-publication.js";
import { loadNative, type ReadLease, refuse } from "./native.js";

export interface ReferenceBackupPin {
  sha256: string;
  byteLength: number;
  check(): Promise<void>;
  close(): void;
}
interface BackupScope {
  owner: object;
  sid: string;
  retainedPins: Set<ReadLease>;
  current(): Promise<void>;
}
const proofs = new WeakMap<
  ReferenceBackupPin,
  {
    owner: object;
    sid: string;
    filename: string;
    lease: ReadLease;
  }
>();

export async function pinReferenceBackupFile(
  filename: string,
  scope: BackupScope,
): Promise<ReferenceBackupPin> {
  await scope.current();
  const native = await loadNative();
  const lease = native.pinRead(filename, false, scope.sid);
  scope.retainedPins.add(lease);
  let closed = false;
  const close = () => {
    if (!closed) {
      lease.close();
      scope.retainedPins.delete(lease);
      closed = true;
    }
  };
  try {
    if (lease.byteLength > 26214400)
      throw new HostBoundaryError(
        "INPUT_LIMIT",
        "Migration backup exceeds its separate database bound.",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let count = 0;
    try {
      for (;;) {
        await scope.current();
        const read = lease.read(buffer);
        if (!read) break;
        count += read;
        if (count > lease.byteLength)
          refuse("Migration backup grew while pinned.");
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      buffer.fill(0);
    }
    if (count !== lease.byteLength) refuse("Migration backup length changed.");
    const result: ReferenceBackupPin = Object.freeze({
      sha256: hash.digest("hex"),
      byteLength: count,
      close,
      async check() {
        if (closed) refuse("Migration backup pin is closed.");
        await scope.current();
        const fresh = native.pinRead(filename, false, scope.sid);
        scope.retainedPins.add(fresh);
        try {
          if (
            fresh.identity.file !== lease.identity.file ||
            fresh.identity.volume !== lease.identity.volume ||
            fresh.byteLength !== count
          )
            refuse("Migration backup native identity changed.");
        } finally {
          fresh.close();
          scope.retainedPins.delete(fresh);
        }
        await scope.current();
      },
    });
    proofs.set(result, { owner: scope.owner, sid: scope.sid, filename, lease });
    await result.check();
    return result;
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new HostBoundaryError(
        error instanceof HostBoundaryError ? error.code : "INTERRUPTED",
        "Backup proof closure failed.",
        false,
        { cause: new AggregateError([error, cleanup]) },
      );
    }
    throw error;
  }
}

export async function publishReferenceBackupFile(input: {
  source: string;
  destination: string;
  proof: ReferenceBackupPin;
  scope: BackupScope;
  context: OperationContext;
  authority: Authority;
}): Promise<ReferenceBackupPin> {
  const { source, destination, proof, scope, context } = input;
  const admitted = proofs.get(proof);
  if (
    !admitted ||
    admitted.owner !== scope.owner ||
    admitted.sid !== scope.sid ||
    admitted.filename !== source ||
    source !== `${destination}.pending` ||
    !context.jobId
  )
    refuse("Backup publication lacks its exact verified source pin.");
  await proof.check();
  const expected = { ...admitted.lease.identity };
  proof.close();
  const guard = new OperationGuard(
    context,
    {
      projectId: context.projectId,
      resourceKind: "job",
      resourceId: context.jobId,
      operation: "write",
    },
    input.authority,
  );
  const publisher = new WindowsNtfsPublisher();
  const publication = await publisher.publish(
    source,
    destination,
    proof.byteLength,
    guard,
  );
  if (
    publication.identity.fileId !== expected.file ||
    publication.identity.volumeId !== expected.volume
  )
    throw new HostBoundaryError(
      "ARTIFACT_INTEGRITY",
      "Backup source was replaced before native publication.",
    );
  await publisher.verify(destination, publication, guard);
  const destinationProof = await pinReferenceBackupFile(destination, scope);
  try {
    if (
      destinationProof.sha256 !== proof.sha256 ||
      destinationProof.byteLength !== proof.byteLength
    )
      throw new HostBoundaryError(
        "ARTIFACT_INTEGRITY",
        "Published backup bytes differ from the verified source.",
      );
    await destinationProof.check();
    guard.check();
    return destinationProof;
  } catch (error) {
    try {
      destinationProof.close();
    } catch (cleanup) {
      throw new HostBoundaryError(
        error instanceof HostBoundaryError ? error.code : "INTERRUPTED",
        "Published backup closure failed.",
        false,
        { cause: new AggregateError([error, cleanup]) },
      );
    }
    throw error;
  }
}
