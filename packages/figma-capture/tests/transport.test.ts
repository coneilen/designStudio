import { lookup } from "node:dns/promises";
import { once } from "node:events";
import tls from "node:tls";
import { syntheticContext } from "@design-studio/contracts/testing";
import { expect, it, vi } from "vitest";
import { CAPTURE_LIMITS, CaptureBudget, ownPolicy } from "../src/boundary.js";
import { FigmaHttpsTransport } from "../src/transport.js";
import { syntheticCertificate } from "./tls-fixture.js";

const seam = vi.hoisted(() => ({
  port: 0,
  ca: "",
  connections: 0,
  deny: false,
  answers: [{ address: "127.0.0.1", family: 4 }],
  delay: undefined as
    | Promise<{ address: string; family: number }[]>
    | undefined,
  secured: undefined as ((socket: tls.TLSSocket) => void) | undefined,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => seam.delay ?? seam.answers),
}));
vi.mock("@design-studio/assets", async (original) => {
  const actual = await original<typeof import("@design-studio/assets")>();
  return {
    ...actual,
    publicAddress: (address: string) =>
      address === "127.0.0.1" || actual.publicAddress(address),
  };
});
vi.mock("node:tls", async (original) => {
  const actual = await original<typeof import("node:tls")>();
  const connect = vi.fn((options: tls.ConnectionOptions) => {
    if (
      options.host !== "127.0.0.1" ||
      options.port !== 443 ||
      options.rejectUnauthorized !== true
    )
      throw new Error("Test seam refuses any nonlocal or weakened connection");
    seam.connections++;
    const socket = actual.connect({ ...options, port: seam.port, ca: seam.ca });
    socket.once("secureConnect", () => seam.secured?.(socket));
    return socket;
  });
  return { ...actual, default: { ...actual, connect }, connect };
});
const identity = syntheticCertificate();
const policy = ownPolicy({
  id: "policy_one",
  projectId: "project_synthetic",
  sourceId: "source_one",
  artifactRootId: "artifact_root",
  fileKey: "SyntheticFile",
  nodeId: "1:2",
  credential: {
    id: "credential_one",
    providerId: "figma_rest",
    store: "test-fake",
  },
  imageOrigins: ["https://images.capture.invalid"],
});
function budget(signal?: AbortSignal) {
  const context = syntheticContext({
    budget: { ...CAPTURE_LIMITS },
    ...(signal ? { signal } : {}),
  });
  context.authorization.egress = "explicit-grant-required";
  context.authorization.grants.push(
    {
      resourceKind: "source",
      resourceId: policy.sourceId,
      operations: ["capture"],
    },
    {
      resourceKind: "provider",
      resourceId: "figma_rest",
      operations: ["read"],
    },
    {
      resourceKind: "artifact",
      resourceId: policy.artifactRootId,
      operations: ["write"],
    },
  );
  return new CaptureBudget(context, policy, () => !seam.deny);
}
async function serverTest(
  response: string,
  work: (facts: {
    applicationBytes: number;
    requests: number;
    credentialHeaders: number;
  }) => Promise<void>,
) {
  const peers = new Set<tls.TLSSocket>();
  const facts = { applicationBytes: 0, requests: 0, credentialHeaders: 0 };
  const server = tls.createServer(identity, (socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (bytes) => {
      facts.applicationBytes += bytes.length;
      facts.requests++;
      if (bytes.toString("ascii").includes("X-Figma-Token:"))
        facts.credentialHeaders++;
      socket.end(response);
    });
    server.on("tlsClientError", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No synthetic listener");
  seam.port = address.port;
  seam.ca = identity.cert;
  seam.connections = 0;
  seam.deny = false;
  seam.answers = [{ address: "127.0.0.1", family: 4 }];
  seam.secured = undefined;
  seam.delay = undefined;
  expect(vi.isMockFunction(tls.connect)).toBe(true);
  expect(vi.isMockFunction(lookup)).toBe(true);
  try {
    await work(facts);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    seam.secured = undefined;
    seam.deny = false;
    seam.delay = undefined;
  }
}
const good =
  "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}";
it("uses one already-verified socket, and never forwards API credentials to the reference origin", async () => {
  await serverTest(good, async (facts) => {
    const run = budget();
    try {
      run.call();
      const response = await new FigmaHttpsTransport().api(
        "metadata",
        undefined,
        Buffer.from("synthetic-private-pat"),
        run,
      );
      expect(response.bytes.toString()).toBe("{}");
      expect(facts).toMatchObject({ requests: 1, credentialHeaders: 1 });
      expect(seam.connections).toBe(1);
      run.call();
      await new FigmaHttpsTransport().image(
        "https://images.capture.invalid/reference.png?synthetic=opaque",
        run,
      );
      expect(facts).toMatchObject({ requests: 2, credentialHeaders: 1 });
    } finally {
      await run.close();
    }
  });
});
it("sends zero application bytes after authorization is revoked at secureConnect", async () => {
  await serverTest(good, async (facts) => {
    const run = budget();
    seam.secured = () => {
      seam.deny = true;
    };
    try {
      run.call();
      await expect(
        new FigmaHttpsTransport().api(
          "metadata",
          undefined,
          Buffer.from("synthetic-pat"),
          run,
        ),
      ).rejects.toBeDefined();
      expect(facts.applicationBytes).toBe(0);
      expect(seam.connections).toBe(1);
    } finally {
      await run.close();
    }
  });
});
for (const response of [
  "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://other.invalid/\r\nConnection: close\r\n\r\n",
  "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n{}",
  "HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{}",
  good + good,
  `HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n${Array.from({ length: 65 }, (_, i) => `X-Test-${i}: value\r\n`).join("")}\r\n{}`,
  "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\nX-Trailer: no\r\n\r\n",
])
  it("rejects unsupported framing/redirects/encoding/truncation and preserves late parser errors", async () => {
    await serverTest(response, async (facts) => {
      const run = budget();
      try {
        run.call();
        await expect(
          new FigmaHttpsTransport().api(
            "metadata",
            undefined,
            Buffer.from("synthetic-pat"),
            run,
          ),
        ).rejects.toBeDefined();
        expect(facts.requests).toBe(1);
        expect(seam.connections).toBe(1);
      } finally {
        await run.close();
      }
    });
  });
it("supports maintained-parser chunked completion and rejects mixed DNS before connect", async () => {
  await serverTest(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    async () => {
      const run = budget();
      try {
        run.call();
        expect(
          (
            await new FigmaHttpsTransport().api(
              "metadata",
              undefined,
              Buffer.from("synthetic-pat"),
              run,
            )
          ).bytes.toString(),
        ).toBe("{}");
        seam.answers.push({ address: "10.0.0.1", family: 4 });
        run.call();
        await expect(
          new FigmaHttpsTransport().api(
            "metadata",
            undefined,
            Buffer.from("synthetic-pat"),
            run,
          ),
        ).rejects.toBeDefined();
        expect(seam.connections).toBe(1);
      } finally {
        await run.close();
      }
    },
  );
});

it("keeps original DNS work owned on cancellation and does not connect after its late return", async () => {
  await serverTest(good, async (facts) => {
    const abort = new AbortController();
    const run = budget(abort.signal);
    let resolve!: (value: { address: string; family: number }[]) => void;
    seam.delay = new Promise((done) => {
      resolve = done;
    });
    run.call();
    let settled = false;
    const outcome = new FigmaHttpsTransport().api(
      "metadata",
      undefined,
      Buffer.from("synthetic-pat"),
      run,
    );
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    abort.abort();
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    resolve([{ address: "127.0.0.1", family: 4 }]);
    await expect(outcome).rejects.toMatchObject({ code: "CANCELLED" });
    expect(seam.connections).toBe(0);
    expect(facts.applicationBytes).toBe(0);
    await run.close();
  });
});
it("denies the immediate Agent handoff gate without writing even a partial token header", async () => {
  await serverTest(good, async (facts) => {
    const run = budget();
    let secured = false;
    let checks = 0;
    seam.secured = () => {
      secured = true;
    };
    const original = run.check.bind(run);
    const gate = vi.spyOn(run, "check").mockImplementation(() => {
      if (secured && ++checks === 4) seam.deny = true;
      original();
    });

    try {
      run.call();
      await expect(
        new FigmaHttpsTransport().api(
          "metadata",
          undefined,
          Buffer.from("synthetic-pat"),
          run,
        ),
      ).rejects.toBeDefined();
      expect(facts.applicationBytes).toBe(0);
      expect(checks).toBeGreaterThanOrEqual(4);
    } finally {
      gate.mockRestore();
      await run.close();
    }
  });
});

for (const failure of ["certificate", "peer"] as const)
  it(`rejects ${failure} mismatch before any application bytes`, async () => {
    await serverTest(good, async (facts) => {
      const run = budget();
      if (failure === "certificate") seam.ca = syntheticCertificate().cert;
      else
        seam.secured = (socket) => {
          Object.defineProperty(socket, "remoteAddress", { value: "8.8.8.8" });
        };
      try {
        run.call();
        await expect(
          new FigmaHttpsTransport().api(
            "metadata",
            undefined,
            Buffer.from("synthetic-pat"),
            run,
          ),
        ).rejects.toBeDefined();
        expect(facts.applicationBytes).toBe(0);
        expect(seam.connections).toBe(1);
      } finally {
        await run.close();
      }
    });
  });
