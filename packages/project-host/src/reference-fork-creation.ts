import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import type { OperationContext } from "@design-studio/contracts";
import { HostBoundaryError } from "@design-studio/host";
import type { ReservedStage } from "../../host/dist/filesystem.js";
import {
  loadNative,
  ReservedCreationCleanupRequired,
  type RetainedReadLease,
  refuse,
} from "./native.js";

/** Internal destination owner. Only CREATE_NEW, never existing-owner or ACL mutation. */
export function referenceForkCreation(input: {
  root: string;
  sid: string;
  authorize(context: OperationContext): Promise<void>;
}) {
  const held = new Set<{ close(): void }>();
  let root: RetainedReadLease | undefined;
  let stageRoot: RetainedReadLease | undefined;
  let hostId: string | undefined;
  let operation: OperationContext["authorization"] | undefined;
  let active = false,
    poisoned = false;
  const check = async (context: OperationContext) => {
    await input.authorize(context);
    if (context.signal.aborted)
      throw new HostBoundaryError(
        "CANCELLED",
        "Reserved creation was cancelled.",
      );
    if (context.clock.now() >= Date.parse(context.deadline))
      throw new HostBoundaryError(
        "DEADLINE_EXCEEDED",
        "Reserved creation deadline expired.",
      );
    if (operation && operation !== context.authorization)
      refuse("Reserved creation belongs to another invocation.");
  };
  const own = <T extends { close(): void }>(entry: T): T => {
    held.add(entry);
    return entry;
  };
  const release = (entry: { close(): void }) => {
    entry.close();
    held.delete(entry);
  };
  return {
    async create(
      stage: ReservedStage,
      bytes: Uint8Array,
      context: OperationContext,
    ) {
      if (active || poisoned)
        refuse("Reserved creation owner is active or requires cleanup.");
      active = true;
      try {
        await check(context);
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        if (
          !uuid.test(stage.hostId) ||
          !uuid.test(stage.stagingId) ||
          bytes.length > context.budget.maxInputBytes ||
          stage.artifact.byteLength !== bytes.length ||
          stage.artifact.sha256 !==
            createHash("sha256").update(bytes).digest("hex") ||
          stage.artifact.path !== `blobs/${stage.artifact.sha256}`
        )
          refuse("Reserved bytes differ from their descriptor.");
        const native = await loadNative();
        if (!root) {
          root = own(native.pinRetainedRoot(input.root, input.sid));
          for await (const _entry of await opendir(input.root))
            refuse("Fork artifact root is not fresh.");
          operation = context.authorization;
          hostId = stage.hostId;
          const blobDir = own(native.createRetainedChild(root, "blobs", true));
          release(blobDir);
          const stageDir = own(
            native.createRetainedChild(root, `.host-${stage.hostId}`, true),
          );
          release(stageDir);
          stageRoot = own(
            native.pinRetainedChild(root, `.host-${stage.hostId}`, true),
          );
        }
        if (!stageRoot || hostId !== stage.hostId)
          refuse("Reserved host changed.");
        await check(context);
        const file = own(
          native.createRetainedChild(stageRoot, stage.stagingId, false),
        );
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          await check(context);
          const chunk = Buffer.from(
            bytes.subarray(offset, Math.min(bytes.length, offset + 65536)),
          );
          try {
            file.write(chunk);
          } finally {
            chunk.fill(0);
          }
        }
        await check(context);
        file.flush();
        file.check();
        const stat = await lstat(file.identity.path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size !== bytes.length
        )
          refuse("Reserved created file shape changed.");
        await check(context);
        release(file);
        return { dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (error instanceof ReservedCreationCleanupRequired) own(error);
        poisoned = true;
        throw error;
      } finally {
        active = false;
      }
    },
    close() {
      if (active) refuse("Reserved creation still owns active work.");
      const errors: unknown[] = [];
      for (const entry of [...held].reverse()) {
        try {
          release(entry);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Reserved creation handles did not close.",
        );
      poisoned = true;
    },
  };
}
