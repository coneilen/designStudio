import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { syntheticCertificate } from "./tls-fixture.js";

it.each(["cleared-extra", "replaced-default"])(
  "bundled capture trust rejects startup-loaded foreign CA: %s",
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "ds-capture-ca-"));
    const identity = await lstat(root, { bigint: true });
    const certificate = syntheticCertificate();
    const certFile = path.join(root, "synthetic-public-ca.pem");
    await writeFile(certFile, certificate.cert, { flag: "wx" });
    const peers = new Set<tls.TLSSocket>();
    let applicationBytes = 0;
    const server = tls.createServer(certificate, (socket) => {
      peers.add(socket);
      socket.on("close", () => peers.delete(socket));
      socket.on("error", () => {});
      socket.on("data", (bytes: Buffer) => {
        applicationBytes += bytes.length;
        bytes.fill(0);
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
      });
    });
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing synthetic TLS server");
    const cleanup = async () => {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await lstat(root, { bigint: true });
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.isSymbolicLink() ||
        (await realpath(root)).toLowerCase() !== root.toLowerCase()
      )
        throw new Error("Synthetic CA root changed");
      await rm(root, { recursive: true });
    };
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL("./fixtures/ca-startup-child.mjs", import.meta.url),
          ),
          mode,
          String(address.port),
        ],
        {
          env: {
            SystemRoot: process.env.SystemRoot ?? "",
            TZ: "UTC",
            NODE_EXTRA_CA_CERTS: certFile,
          },
          timeout: 10000,
          maxBuffer: 2048,
          windowsHide: true,
        },
      );
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        startupExtraLoaded: true,
        defaultTrusted: true,
        pinnedBundled: true,
        dnsQueries: 1,
        connections: 1,
        code: "REJECTED",
      });
      expect(applicationBytes).toBe(0);
    } finally {
      await cleanup();
    }
  },
);
