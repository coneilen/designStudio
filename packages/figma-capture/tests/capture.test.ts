import { expect, it, vi } from "vitest";
import { chunk, image, srgb } from "../../assets/tests/png-fixtures.js";
import { captureSelectedFrame } from "../src/capture.js";
import { CaptureHttpError, FigmaHttpsTransport } from "../src/transport.js";
import { captureFixture, nodes, PAT, png } from "./support.js";

function network() {
  const calls: { operation: string; version: string | undefined }[] = [];
  const api = vi
    .spyOn(FigmaHttpsTransport.prototype, "api")
    .mockImplementation(async (operation, version, _secret, budget) => {
      calls.push({ operation, version });
      budget.dnsQuery();
      const bytes = Buffer.from(
        JSON.stringify(
          operation === "metadata"
            ? { file: { version: "version_7" } }
            : operation === "nodes"
              ? nodes
              : {
                  images: {
                    "1:2":
                      "https://images.capture.invalid/reference.png?signature=synthetic-only",
                  },
                },
        ),
      );
      budget.receive(bytes.length + 100);
      budget.decoded(bytes.length);
      return { status: 200, bytes, mediaType: "application/json" };
    });
  const image = vi
    .spyOn(FigmaHttpsTransport.prototype, "image")
    .mockImplementation(async (_url, budget) => {
      calls.push({ operation: "image", version: undefined });
      budget.dnsQuery();
      const bytes = png();
      budget.receive(bytes.length + 100);
      budget.decoded(bytes.length);
      return { status: 200, bytes, mediaType: "image/png" };
    });
  return {
    api,
    image,
    calls,
    close() {
      api.mockRestore();
      image.mockRestore();
    },
  };
}
it.each([
  ["image/png", "png", true],
  ["application/octet-stream", "generic-binary", true],
  ["binary/octet-stream", "generic-binary", true],
  [undefined, "missing", false],
  ["text/html", "other", false],
  ["application/json", "other", false],
  ["other", "other", false],
] as const)(
  "classifies HTTP200 reference MIME %s without URL-based acceptance",
  async (mediaType, mimeClass, accepted) => {
    const fixture = captureFixture(["https://images.capture.invalid"]);
    const fake = network();
    const original = image(6, 8, undefined, [
      srgb(),
      chunk("tEXt", Buffer.from("Synthetic\0private-text-marker")),
    ]);
    fake.image.mockResolvedValue({
      status: 200,
      bytes: Buffer.from(original),
      ...(mediaType ? { mediaType } : {}),
    });
    try {
      const prepared = await captureSelectedFrame(
        fixture.request,
        fixture.execution,
        fixture,
      );
      expect(prepared.manifest.referenceDiagnostic).toEqual({
        stage: accepted ? "png" : "mime",
        reason: accepted
          ? "validated"
          : mediaType
            ? "mime-rejected"
            : "mime-missing",
        mimeClass,
      });
      expect(prepared.result.referenceStatus).toBe(
        accepted ? "complete" : "unavailable",
      );
      expect(JSON.stringify(prepared.manifest)).not.toContain(
        "private-text-marker",
      );
      if (accepted) {
        const hash = prepared.manifest.reference?.artifact.sha256;
        expect(hash && fixture.blobs.get(hash)).toEqual(original);
      } else {
        expect(prepared.result.errorCode).toBe("UNSUPPORTED_FEATURE");
        expect(
          prepared.manifest.artifacts.some(
            (entry) => entry.role === "reference",
          ),
        ).toBe(false);
      }
    } finally {
      fake.close();
    }
  },
);
it("rejects HTML and malformed content even when MIME is recognized generic binary", async () => {
  const fixture = captureFixture(["https://images.capture.invalid"]);
  const fake = network();
  fake.image.mockResolvedValue({
    status: 200,
    bytes: Buffer.from("<html>synthetic</html>"),
    mediaType: "application/octet-stream",
  });
  try {
    const prepared = await captureSelectedFrame(
      fixture.request,
      fixture.execution,
      fixture,
    );
    expect(prepared.result).toMatchObject({
      referenceStatus: "unavailable",
      errorCode: "UNSUPPORTED_FEATURE",
      referenceDiagnostic: {
        stage: "png",
        reason: "not-png",
        mimeClass: "generic-binary",
      },
    });
    expect(prepared.manifest.reference).toBeUndefined();
  } finally {
    fake.close();
  }
});
it("captures three original pinned responses with truthful partial result before unapproved CDN contact", async () => {
  const fixture = captureFixture();
  const fake = network();
  try {
    const prepared = await captureSelectedFrame(
      fixture.request,
      fixture.execution,
      fixture,
    );
    expect(fake.calls).toEqual([
      { operation: "metadata", version: undefined },
      { operation: "nodes", version: "version_7" },
      { operation: "reference-render", version: "version_7" },
    ]);
    expect(prepared.result).toMatchObject({
      completeness: "partial",
      referenceStatus: "unavailable",
      readiness: "not-evaluated",
    });
    expect(prepared.manifest.remediationOrigin).toBe(
      "https://images.capture.invalid",
    );
    expect(prepared.manifest.missing).toContain(
      "reference-origin-not-approved",
    );
    expect(JSON.stringify(prepared.result)).not.toContain("signature");
    expect(
      fixture.body(prepared.result.source ?? { sha256: "" }),
    ).toMatchObject({
      identity: {
        transport: "figma-rest",
        sourceVersion: "version_7",
        nodeId: "1:2",
      },
    });
    expect(
      fixture.record.effects.every((effect) => effect.state === "settled"),
    ).toBe(true);
    expect(prepared.result.persistedBytes).toBe(
      fixture.record.usage.outputBytes,
    );
    expect(fixture.assertZeroed()).toBe(true);
  } finally {
    fake.close();
  }
});
it("captures exactly four calls and decoded reference metadata without claiming render readiness", async () => {
  const fixture = captureFixture(["https://images.capture.invalid"]);
  const fake = network();
  try {
    const prepared = await captureSelectedFrame(
      fixture.request,
      fixture.execution,
      fixture,
    );
    expect(fake.calls).toHaveLength(4);
    expect(prepared.result).toMatchObject({
      completeness: "complete",
      referenceStatus: "complete",
      readiness: "not-evaluated",
    });
    expect(prepared.manifest.reference).toMatchObject({
      pixelWidth: 1,
      pixelHeight: 1,
      scale: 1,
      colorSpace: "srgb",
    });
    expect(prepared.staged).toHaveLength(7);
    expect(fixture.reads()).toBe(1);
    expect(fixture.assertZeroed()).toBe(true);
  } finally {
    fake.close();
  }
});
it("retains a 429 attempt and Retry-After without another call or invented source version", async () => {
  const fixture = captureFixture();
  const fake = network();
  fake.api.mockImplementation(async () => {
    throw new CaptureHttpError("RATE_LIMITED", 429, "60");
  });
  try {
    const prepared = await captureSelectedFrame(
      fixture.request,
      fixture.execution,
      fixture,
    );
    expect(prepared.result).toMatchObject({
      completeness: "unavailable",
      errorCode: "RATE_LIMITED",
    });
    expect(prepared.result.source).toBeUndefined();
    expect(prepared.manifest.retry).toBe("explicit-action-required");
    expect(prepared.manifest.nextEligibleAt).toBeDefined();
    expect(fixture.record.usage.externalCalls).toBe(1);
    expect(fake.image).not.toHaveBeenCalled();
  } finally {
    fake.close();
  }
});
it("rejects credential echo before persistence and never retries unknown effects", async () => {
  for (const kind of ["secret", "unknown"] as const) {
    const fixture = captureFixture();
    const fake = network();
    fake.api.mockImplementation(async () => {
      if (kind === "unknown")
        throw new CaptureHttpError("PROVIDER_UNAVAILABLE");
      return {
        status: 200,
        bytes: Buffer.from(
          JSON.stringify({
            file: { version: "7" },
            value: [...Buffer.from(PAT)],
          }),
        ),
      };
    });
    try {
      await expect(
        captureSelectedFrame(fixture.request, fixture.execution, fixture),
      ).rejects.toBeDefined();
      expect(fixture.blobs.size).toBe(1);
      expect(fixture.assertZeroed()).toBe(true);
      if (kind === "unknown")
        expect(fixture.record.effects[0]?.state).toBe("unknown");
      expect(fake.api).toHaveBeenCalledTimes(1);
    } finally {
      fake.close();
    }
  }
});

for (const scenario of [
  "missing-version",
  "different-version",
  "null-node",
  "render-version",
  "dimensions",
  "color",
  "resources",
] as const)
  it(`does not promote incomplete ${scenario} evidence to complete capture`, async () => {
    const fixture = captureFixture(["https://images.capture.invalid"]);
    const fake = network();
    fake.api.mockImplementation(
      async (operation, _version, _secret, budget) => {
        fake.calls.push({ operation, version: _version });
        budget.dnsQuery();
        const data = structuredClone(nodes);
        if (scenario === "different-version") data.version = "other_version";
        if (scenario === "dimensions")
          data.nodes["1:2"].document.absoluteBoundingBox.width = 2;
        let value: unknown =
          operation === "metadata"
            ? {
                file:
                  scenario === "missing-version"
                    ? {}
                    : { version: "version_7" },
              }
            : operation === "nodes"
              ? scenario === "null-node"
                ? { version: "version_7", nodes: { "1:2": null } }
                : data
              : {
                  images: {
                    "1:2": "https://images.capture.invalid/reference.png",
                  },
                  ...(scenario === "render-version"
                    ? { version: "other_version" }
                    : {}),
                };
        if (scenario === "resources" && operation === "nodes")
          value = {
            version: "version_7",
            nodes: {
              "1:2": {
                document: {
                  ...data.nodes["1:2"].document,
                  children: [
                    {
                      id: "1:3",
                      type: "TEXT",
                      characters: "Synthetic",
                      fills: [{ type: "IMAGE", imageRef: "synthetic-image" }],
                    },
                  ],
                },
              },
            },
          };
        const bytes = Buffer.from(JSON.stringify(value));
        budget.receive(bytes.length);
        budget.decoded(bytes.length);
        return { status: 200, bytes, mediaType: "application/json" };
      },
    );
    if (scenario === "color")
      fake.image.mockImplementation(async (_url, budget) => {
        const bytes = png(false);
        budget.dnsQuery();
        budget.receive(bytes.length);
        budget.decoded(bytes.length);
        return { status: 200, bytes, mediaType: "image/png" };
      });
    try {
      const prepared = await captureSelectedFrame(
        fixture.request,
        fixture.execution,
        fixture,
      );
      expect(prepared.result.completeness).not.toBe("complete");
      expect(prepared.result.readiness).toBe("not-evaluated");
      if (
        ["missing-version", "different-version", "null-node"].includes(scenario)
      )
        expect(prepared.result.source).toBeUndefined();
      if (scenario === "render-version")
        expect(
          fixture.body(prepared.result.source ?? { sha256: "" }),
        ).toMatchObject({ consistency: { guarantee: "unstable" } });
      if (scenario === "resources")
        expect(prepared.manifest.missing).toEqual(
          expect.arrayContaining([
            "unresolved-image-fills-and-rights",
            "unresolved-fonts-and-rights",
          ]),
        );
      expect(fixture.assertZeroed()).toBe(true);
    } finally {
      fake.close();
    }
  });

it("snapshots caller selection before awaiting and denies authority changes before persistence", async () => {
  const fixture = captureFixture();
  const fake = network();
  try {
    const pending = captureSelectedFrame(
      fixture.request,
      fixture.execution,
      fixture,
    );
    fixture.request.selectionUrl =
      "https://www.figma.com/design/Foreign/selection?node-id=9-9";
    expect((await pending).manifest.selection).toEqual({
      fileKey: "SyntheticFile",
      nodeId: "1:2",
    });
  } finally {
    fake.close();
  }
  const revoked = captureFixture();
  const other = network();
  other.api.mockImplementation(async () => {
    revoked.revoke();
    return {
      status: 200,
      bytes: Buffer.from('{"file":{"version":"version_7"}}'),
    };
  });
  try {
    await expect(
      captureSelectedFrame(revoked.request, revoked.execution, revoked),
    ).rejects.toBeDefined();
    expect(revoked.blobs.size).toBe(1);
    expect(revoked.assertZeroed()).toBe(true);
  } finally {
    other.close();
  }
});
