import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FigmaCaptureManifest, Outcome } from "@design-studio/contracts";
import {
  canonicalBytes,
  canonicalDigest,
  hashBytes,
} from "@design-studio/design-ir";
import {
  convertFigmaStructure,
  type FigmaConversionPolicy,
} from "@design-studio/figma-import";
import { LocalStore, type StorageOptions } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import { context, diskFixture } from "../../storage/tests/support.js";
import {
  captureConversionEntries,
  captureConversionIdentity,
  persistCaptureConversion,
} from "../src/capture-conversion.js";

function value<T>(outcome: Outcome<T>): T {
  if (outcome.status !== "complete") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}

function fixture() {
  const bytes = canonicalBytes({
    nodes: {
      "1:1": {
        document: {
          id: "1:1",
          type: "FRAME",
          name: "Synthetic policy receipt",
          relativeTransform: [
            [1, 0, 12],
            [0, 1, 20],
          ],
          absoluteBoundingBox: { x: 12, y: 20, width: 40, height: 50 },
          children: [
            {
              id: "1:2",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 15, y: 24, width: 10, height: 12 },
            },
          ],
        },
      },
    },
  });
  const nodes = {
    id: `sha256_${hashBytes(bytes)}`,
    sha256: hashBytes(bytes),
    byteLength: bytes.length,
    mediaType: "application/json",
    path: "synthetic.json",
  };
  const source = { id: "source_synthetic", sha256: "b".repeat(64) };
  const manifest: FigmaCaptureManifest = {
    schemaVersion: "1.0",
    format: "figma-rest-capture-v1",
    policySha256: "a".repeat(64),
    captureId: "capture_synthetic",
    projectId: "project1",
    policyId: "policy_synthetic",
    request: { id: "request_synthetic", sha256: "c".repeat(64) },
    selection: { fileKey: "SyntheticFile", nodeId: "1:1" },
    startedAt: "2026-09-17T00:00:00.000Z",
    endedAt: "2026-09-17T00:00:00.000Z",
    sourceVersion: "synthetic_version",
    source,
    completeness: "partial",
    referenceStatus: "unavailable",
    readiness: "not-evaluated",
    observations: [],
    artifacts: [{ role: "nodes", artifact: nodes }],
    missing: ["verified-reference-unavailable"],
    limitations: ["Synthetic receipt fixture, not an authenticated capture."],
    usage: {
      externalCalls: 0,
      dnsQueries: 0,
      networkReceivedBytes: 0,
      networkBodyBytes: 0,
      persistedBytes: 0,
    },
  };
  function convert(policy: FigmaConversionPolicy) {
    const identity = captureConversionIdentity(
      manifest.captureId,
      manifest,
      nodes,
      policy,
    );
    const converted = convertFigmaStructure({
      policy: identity.policy,
      projectId: manifest.projectId,
      designId: identity.designId,
      intakeId: manifest.captureId,
      actorId: "actor1",
      observedAt: manifest.endedAt,
      selection: manifest.selection,
      structure: nodes,
      structureBytes: bytes,
    });
    return {
      identity,
      converted,
      entries: captureConversionEntries(converted, source),
    };
  }
  return { nodes, manifest, source, convert };
}

it("pins legacy identity formulas and separates the new intended policy", () => {
  const { nodes, manifest, convert } = fixture();
  const old = convert("fixed-v1");
  const current = convert("fixed-v2");
  expect(old.identity.designId).toBe(
    `design_${canonicalDigest([manifest.captureId, nodes.sha256])}`,
  );
  expect(old.identity.operationId).toBe(
    `convert_${canonicalDigest([manifest.captureId, manifest, "figma-structure-fixed-v1", "0.2.0"])}`,
  );
  expect(current.identity).toEqual(
    captureConversionIdentity(manifest.captureId, manifest, nodes),
  );
  expect(current.identity.designId).not.toBe(old.identity.designId);
  expect(current.identity.operationId).not.toBe(old.identity.operationId);
  expect(old.converted.design?.root.type).toBe("unsupported");
  expect(current.converted.design?.root.type).toBe("frame");
});

it("reopens a previously converted synthetic SQLite capture and retains both immutable policy results", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversion-policy-synthetic-"));
  let store: LocalStore | undefined;
  try {
    const disk = await diskFixture(root);
    const options: StorageOptions = {
      databasePath: join(root, "project.sqlite"),
      projectId: "project1",
      artifactRootId: "artifact-root",
      permissionScope: "permission1",
      nativeBinding: resolve(
        ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
      ),
      fileSystem: disk.fs,
      maintenance: disk.maintenance,
      ensurePublicationDurable: async () => {},
      ensureDatabaseBackupDurable: async () => {},
      authorize: async () => {},
      attestLocalDatabase: async () => {},
      canonicalBytes,
      authorizeRestore: async () => {},
      authorizeRetention: async () => {},
      canDiscardStage: async () => true,
      verifyRevision: async () => {},
      assessApproval: async () => ({
        complete: true,
        blockingDiagnosticIds: [],
        waiverEligibleDiagnosticIds: [],
      }),
    };
    const { convert } = fixture();
    const old = convert("fixed-v1");
    const current = convert("fixed-v2");
    const oldContext = context(old.identity.operationId);
    const newContext = context(current.identity.operationId);
    const check = vi.fn(async () => {});
    store = await LocalStore.open(options);
    const oldOutputs = await persistCaptureConversion(
      old.entries,
      store,
      oldContext,
      check,
    );
    const oldReceipt = value(
      await store.getReceipt(old.identity.operationId, oldContext),
    );
    const oldBytes = await Promise.all(
      oldOutputs.map(({ artifact }) =>
        readFile(join(root, ...artifact.path.split("/"))),
      ),
    );
    store.close();
    store = await LocalStore.open(options);
    expect(
      value(await store.getReceipt(old.identity.operationId, oldContext)),
    ).toEqual(oldReceipt);
    const stage = vi.spyOn(store, "stage");
    const newOutputs = await persistCaptureConversion(
      current.entries,
      store,
      newContext,
      check,
    );
    expect(stage).toHaveBeenCalledTimes(current.entries.length);
    expect(newOutputs).not.toEqual(oldOutputs);
    const newReceipt = value(
      await store.getReceipt(current.identity.operationId, newContext),
    );
    stage.mockClear();
    expect(
      await persistCaptureConversion(
        convert("fixed-v2").entries,
        store,
        newContext,
        check,
      ),
    ).toEqual(newOutputs);
    expect(
      await persistCaptureConversion(
        convert("fixed-v1").entries,
        store,
        oldContext,
        check,
      ),
    ).toEqual(oldOutputs);
    expect(stage).not.toHaveBeenCalled();
    expect(
      value(await store.getReceipt(old.identity.operationId, oldContext)),
    ).toEqual(oldReceipt);
    expect(
      value(await store.getReceipt(current.identity.operationId, newContext)),
    ).toEqual(newReceipt);
    expect(
      await Promise.all(
        oldOutputs.map(({ artifact }) =>
          readFile(join(root, ...artifact.path.split("/"))),
        ),
      ),
    ).toEqual(oldBytes);
    for (const [index, output] of newOutputs.entries()) {
      const actual = await readFile(
        join(root, ...output.artifact.path.split("/")),
      );
      expect(hashBytes(actual)).toBe(output.artifact.sha256);
      expect(actual).toEqual(Buffer.from(current.entries[index]?.bytes ?? []));
    }
    await expect(
      persistCaptureConversion(current.entries, store, oldContext, check),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
    });
    const tampered = current.entries.map((entry) => ({
      ...entry,
      bytes: canonicalBytes({ replaced: true }),
    }));
    await expect(
      persistCaptureConversion(tampered, store, newContext, check),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
    });
    expect(stage).not.toHaveBeenCalled();
    store.close();
    store = await LocalStore.open(options);
    expect(
      await persistCaptureConversion(
        convert("fixed-v1").entries,
        store,
        oldContext,
        check,
      ),
    ).toEqual(oldOutputs);
    expect(
      await persistCaptureConversion(
        convert("fixed-v2").entries,
        store,
        newContext,
        check,
      ),
    ).toEqual(newOutputs);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
